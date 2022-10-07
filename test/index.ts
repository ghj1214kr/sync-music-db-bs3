import SyncMusicDb from "../dist/index.js";
import copydir from "copy-dir";
import fs from "fs";
import path from "path";
import readdir from "@jsdevtools/readdir-enhanced";
import Database from "better-sqlite3";
import test from "tape-async";
import rimrafSync from "rimraf";

const MUSIC_DIR = `${__dirname}${path.sep}_music`;
const TMP_DIR = `${__dirname}${path.sep}music`;
const DB_FILE = `${__dirname}${path.sep}..${path.sep}test.db`;

const ABBEY_ROAD = `${TMP_DIR}${path.sep}the-beatles${path.sep}abbey-road`;
const ED_BUYS_HOUSES = `${TMP_DIR}${path.sep}ed-buys-houses/*`;

const KETCHUP = Buffer.from("Ketchup");
const MUSTARD = Buffer.from("Mustard");
const MUSTARD_FILE =
  `${ABBEY_ROAD}${path.sep}` +
  "The Beatles - Abbey Road - 11 - Mean Mr. Mustard.mp3";
const MUSTARD_POS = 0x2e;

const TIMEOUT = 10000;

function removeDb() {
  try {
    fs.unlinkSync(DB_FILE);
  } catch (e) {
    // pass
  }
}

function removeTmp() {
  try {
    rimrafSync.sync(TMP_DIR);
  } catch (e) {
    // pass
  }
}

removeDb();
removeTmp();

fs.mkdirSync(TMP_DIR);

// copy the music to a new directory so we can modify the files
copydir.sync(MUSIC_DIR, TMP_DIR);

function afterReady(syncer: SyncMusicDb) {
  return new Promise((resolve) => syncer.once("ready", resolve));
}

function afterAddTrack(syncer: SyncMusicDb, file: string) {
  return new Promise<void>((resolve, reject) => {
    syncer.once("add", (track: { path: any }) => {
      if (track.path === file) {
        resolve();
      } else {
        reject(new Error(`unexpected file "${track.path}" added`));
      }
    });
  });
}

function afterUpdate(syncer: SyncMusicDb, file: string) {
  return new Promise<void>((resolve, reject) => {
    syncer.once("update", (track: { path: any }) => {
      if (track.path === file) {
        resolve();
      } else {
        reject(new Error(`unexpected file "${track.path}" changed`));
      }
    });
  });
}

function afterRemove(syncer: SyncMusicDb, sP: string) {
  return new Promise<void>((resolve) => {
    syncer.on("remove", (p: string) => {
      if (path.dirname(p) === path.dirname(sP)) {
        resolve();
      }
    });
  });
}

(async () => {
  const db = new Database(DB_FILE);
  const syncer = new SyncMusicDb({ db, dirs: [TMP_DIR] });

  test("syncer.createTable() creates library table with attrs", async (t) => {
    await syncer.createTable();

    const columns = db
      .prepare("pragma table_info(library)")
      .all()
      .map((row) => {
        return row.name;
      });

    for (const attr of SyncMusicDb.TRACK_ATTRS) {
      if (columns.indexOf(attr) < 0) {
        t.fail(`"${columns}" not found in library table`);
      }
    }
  });

  test("syncer.refresh() populates library table", async (t) => {
    t.timeoutAfter(TIMEOUT);
    syncer.on("error", (err) => t.error(err));

    t.notOk(
      db.prepare("select 1 from library").all().length,
      "initially empty"
    );
    t.notOk(syncer.isReady, "isReady is false");

    syncer.refresh();
    await afterReady(syncer);

    t.ok(syncer.isReady, "isReady is true");

    const files = readdir.sync(TMP_DIR, {
      basePath: TMP_DIR,
      deep: true,
      stats: true,
    });

    const fileMap = new Map();

    for (const file of files) {
      fileMap.set(file.path, Math.floor(file.mtimeMs));
    }

    await syncer.close();

    const nonMediaTracks = db
      .prepare("select 1 from library where path like" + "@path")
      .all({ path: `%not-music.txt` });

    t.notOk(nonMediaTracks.length, "syncer did not sync non-media file");

    const query = db.prepare("select path as p, mtime from library");

    for await (const { p, mtime } of query.iterate()) {
      const fileMtime = fileMap.get(p);

      if (!fileMtime) {
        t.fail(`${p} not found on local filesystem`);
      } else if (fileMtime !== mtime) {
        t.fail(
          `${p} database mtime (${mtime}) does not match ` +
            `filesystem's (${fileMtime})`
        );
      } else {
        t.pass(`${path.basename(p)} is on filesystem with correct ` + "mtime");
      }
    }

    syncer.removeAllListeners();
  });

  test("syncer responds to metadata changes", async (t) => {
    t.timeoutAfter(TIMEOUT);
    syncer.on("error", (err) => t.error(err));

    const updateTitle = (title: Buffer) => {
      const fd = fs.openSync(MUSTARD_FILE, "r+");
      fs.writeSync(fd, title, 0, title.length, MUSTARD_POS);
      fs.closeSync(fd);
    };

    const getTitle = async () => {
      try {
        return db
          .prepare("select title from library where path = ?")
          .all(MUSTARD_FILE)[0].title;
      } catch (e) {
        t.error(e);
      }
    };

    updateTitle(KETCHUP);
    syncer.refresh();
    await afterReady(syncer);

    t.equals(
      await getTitle(),
      "Mean Mr. Ketchup",
      "syncer updated metadata after .refresh()"
    );

    updateTitle(MUSTARD);
    await afterUpdate(syncer, MUSTARD_FILE);
    await syncer.close();

    t.equals(
      await getTitle(),
      "Mean Mr. Mustard",
      "syncer updated metadata live"
    );

    syncer.removeAllListeners();
  });

  test("syncer responds to additions and removals", async (t) => {
    t.timeoutAfter(TIMEOUT);
    syncer.on("error", (err) => t.error(err));

    const mustardContents = fs.readFileSync(MUSTARD_FILE);

    rimrafSync.sync(ABBEY_ROAD);
    syncer.refresh();
    await afterReady(syncer);

    t.notOk(
      db
        .prepare("select 1 from library where path like ?")
        .all(`${ABBEY_ROAD}%`).length,
      "syncer removes tracks after .refresh()"
    );

    setImmediate(() => rimrafSync.sync(ED_BUYS_HOUSES));
    await afterRemove(syncer, ED_BUYS_HOUSES);

    t.notOk(
      db
        .prepare("select 1 from library where path like ?")
        .all(`${ED_BUYS_HOUSES}%`).length,
      "syncer removes tracks live"
    );

    const newMustardFile = `${__dirname}${path.sep}music${path.sep}mustard.mp3`;

    setImmediate(() => fs.writeFileSync(newMustardFile, mustardContents));
    await afterAddTrack(syncer, newMustardFile);

    t.ok(
      db.prepare("select 1 from library where path = ?").all(newMustardFile)
        .length,
      "syncer adds tracks live"
    );

    await syncer.close();
    syncer.removeAllListeners();
  });

  test("teardown", async (t) => {
    db.close();
    removeDb();
    removeTmp();
    t.end();
  });
})();
