import fs from "fs";
import mm from "music-metadata";
import path from "path";
import readdir from "@jsdevtools/readdir-enhanced";
import chokidar from "chokidar";
import { EventEmitter } from "events";
import { Database, Statement } from "better-sqlite3";

// each of the columns in our database table
const TRACK_ATTRS = [
  "path",
  "mtime",
  "title",
  "artist",
  "album",
  "year",
  "duration",
  "track_no",
  "tags",
  "is_vbr",
  "bitrate",
  "codec",
  "container",
];

const CREATE_TABLE = fs
  .readFileSync(path.join(__dirname, "library.sql"))
  .toString();

const UPSERT_TRACK =
  `insert into library (${TRACK_ATTRS}) values ` +
  `(${TRACK_ATTRS.map(() => "?").join(",")}) on conflict(path) do update ` +
  `set ${TRACK_ATTRS.slice(1).map((attr) => `${attr}=excluded.${attr}`)}`;

type metadata = {
  [key: string]: number | string;
};

interface SyncMusicDbType {
  db: Database;
  dirs: string[];
  delay?: number;
}

class SyncMusicDb extends EventEmitter {
  audioExtensions: string[];
  regex: RegExp;
  db: Database;
  dirs: string[];
  delay: number;
  localMtimes: Map<string, number>;
  isReady: boolean;
  isSynced: boolean;
  removeDirStmt?: Statement;
  removeTrackStmt?: Statement;
  upsertTrackStmt?: Statement;
  watcher?: chokidar.FSWatcher;
  static TRACK_ATTRS: string[];

  constructor({ db, dirs, delay = 1000 }: SyncMusicDbType) {
    super();

    this.audioExtensions = [
      "wav",
      "bwf",
      "raw",
      "aiff",
      "flac",
      "m4a",
      "pac",
      "tta",
      "wv",
      "ast",
      "aac",
      "mp2",
      "mp3",
      "mp4",
      "amr",
      "s3m",
      "3gp",
      "act",
      "au",
      "dct",
      "dss",
      "gsm",
      "m4p",
      "mmf",
      "mpc",
      "ogg",
      "oga",
      "opus",
      "ra",
      "sln",
      "vox",
    ];

    this.regex = new RegExp(".+.(" + this.audioExtensions.join("|") + ")$", "i");

    this.db = db;
    this.dirs = dirs.map((dir) => path.resolve(dir));

    this.delay = delay;

    // { path: fs.stat.mtimeMs }
    this.localMtimes = new Map();

    // is the initial sync done and are we ready to listen for new changes?
    this.isReady = false;

    // is dir up-to-date with db?
    this.isSynced = false;
  }

  // get each column of (TRACK_ATTRS) from the media file
  static async getMetaData(filePath: string): Promise<metadata | {}> {
    try {
      const { common, format } = await mm.parseFile(filePath, {
        duration: true,
        skipCovers: true,
      });
      const isVbr =
        format.codec === "MP3" &&
        format.codecProfile &&
        /^v/i.test(format.codecProfile);

      return {
        title: common.title ?? path.basename(filePath),
        artist: common.artists?.join(","),
        album: common.album,
        year: common.year,
        duration: format.duration && Math.round(format.duration),
        track_no: common.track ? common.track.no : null,
        tags: JSON.stringify(common.genre),
        is_vbr: isVbr ? 0 : 1,
        bitrate: format.bitrate && Math.floor(format.bitrate / 1000),
        codec: format.codec,
        container: format.container,
      };
    } catch (e) {
      return {};
    }
  }

  createTable() {
    this.db.exec(CREATE_TABLE);
  }

  prepareStatements() {
    this.removeDirStmt = this.db.prepare(
      "delete from library where path like ?"
    );
    this.removeTrackStmt = this.db.prepare(
      "delete from library where path = ?"
    );
    this.upsertTrackStmt = this.db.prepare(UPSERT_TRACK);
  }

  finalizeStatements() {
    delete this["removeDirStmt"];
    delete this["removeTrackStmt"];
    delete this["upsertTrackStmt"];
  }

  // remove all tracks that begin with directory
  removeDbDir(dir: string) {
    this.removeDirStmt!.run(`${dir}${path.sep}%`);
  }

  // remove a single track based on path
  removeDbTrack(trackPath: string) {
    this.removeTrackStmt!.run(trackPath);
    this.emit("remove", trackPath);
  }

  // add a single track
  upsertDbTrack(track: metadata, update = false) {
    this.upsertTrackStmt!.run(TRACK_ATTRS.map((attr) => track[attr]));
    this.emit(update ? "update" : "add", track);
  }

  // grab every file recursively in the dir specified and set their last-
  // modified time in this.localMtimes map
  async refreshLocalMtimes() {
    this.localMtimes.clear();

    const promiseArray = [];

    for (const dir of this.dirs) {
      promiseArray.push(
        new Promise<void>((resolve, reject) => {
          const dirStream = readdir.stream(dir, {
            filter: this.regex,
            basePath: dir,
            deep: true,
            stats: true,
          });

          dirStream
            .on("file", (stats) => {
              this.localMtimes.set(stats.path, Math.floor(stats.mtimeMs));
            })
            .on("end", () => resolve())
            .on("error", (err) => reject(err))
            .resume();
        })
      );
    }

    await Promise.all(promiseArray);
  }

  // remove tracks that don't exist on the filesystem from our database,
  // and remove files from localMtimes that have up-to-date database entries
  removeDeadTracks() {
    const query = this.db.prepare("select path as p, mtime from library");

    const transaction = this.db.transaction(() => {
      for (const { p, mtime } of query.all()) {
        const localMtime = this.localMtimes.get(p);

        if (!localMtime) {
          this.removeDbTrack(p);
        } else if (localMtime === mtime) {
          this.localMtimes.delete(p);
        }
      }
    });

    transaction();
  }

  // get the metadata from each file in localMtimes and add them to the
  // database
  async addUpdatedTracks() {
    this.db.exec("begin transaction");

    for (const [path, mtime] of this.localMtimes) {
      const track = await SyncMusicDb.getMetaData(path);
      Object.assign(track, { path, mtime });
      this.upsertDbTrack(track);
    }

    this.db.exec("commit");

    this.localMtimes.clear();
  }

  // listen for file updates or removals and update the database accordingly
  refreshWatcher() {
    this.watcher = chokidar
      .watch(this.dirs, {
        ignoreInitial: true,
        atomic: this.delay,
      })
      .on("add", async (path) => {
        if (
          !this.audioExtensions.includes(
            path.slice(((path.lastIndexOf(".") - 1) >>> 0) + 2).toLowerCase()
          )
        ) {
          return;
        }

        this.isSynced = false;
        this.emit("synced", this.isSynced);

        const stats = await fs.promises.stat(path);

        this.upsertDbTrack(
          Object.assign(
            {
              path: path,
              mtime: Math.floor(stats.mtimeMs),
            },
            await SyncMusicDb.getMetaData(path)
          )
        );

        this.isSynced = true;
        this.emit("synced", this.isSynced);
      })
      .on("change", async (path) => {
        if (
          !this.audioExtensions.includes(
            path.slice(((path.lastIndexOf(".") - 1) >>> 0) + 2).toLowerCase()
          )
        ) {
          return;
        }

        this.isSynced = false;
        this.emit("synced", this.isSynced);

        const stats = await fs.promises.stat(path);

        this.upsertDbTrack(
          Object.assign(
            {
              path: path,
              mtime: Math.floor(stats.mtimeMs),
            },
            await SyncMusicDb.getMetaData(path)
          ),
          true
        );

        this.isSynced = true;
        this.emit("synced", this.isSynced);
      })
      .on("unlink", async (path) => {
        if (
          !this.audioExtensions.includes(
            path.slice(((path.lastIndexOf(".") - 1) >>> 0) + 2).toLowerCase()
          )
        ) {
          return;
        }

        this.isSynced = false;
        this.emit("synced", this.isSynced);

        this.removeDbTrack(path);

        this.isSynced = true;
        this.emit("synced", this.isSynced);
      })
      .on("ready", () => {
        this.isReady = true;
        this.isSynced = true;
        this.emit("synced", this.isSynced);
        this.emit("ready");
      });
  }

  // start!
  refresh() {
    this.close()
      .then(() => this.prepareStatements())
      .then(() => this.refreshLocalMtimes())
      .then(() => this.removeDeadTracks())
      .then(() => this.addUpdatedTracks())
      .then(() => this.refreshWatcher())
      .catch((err) => this.emit("error", err));

    return this;
  }

  async close() {
    if (this.removeDirStmt) {
      this.finalizeStatements();
    }

    if (this.watcher) {
      this.watcher.close();
      this.watcher = undefined;
    }

    this.isReady = false;
    this.isSynced = false;
    this.emit("synced", this.isSynced);
  }

  addDirs(dirs: string[]) {
    this.dirs.push(...dirs.map((dir) => path.resolve(dir)));
    this.dirs = [...new Set(this.dirs)];
  }

  removeDirs(dirs: string[]) {
    this.dirs = this.dirs.filter(
      (dir) => !dirs.map((dir) => path.resolve(dir)).includes(dir)
    );
  }
}

SyncMusicDb.TRACK_ATTRS = TRACK_ATTRS;

export default SyncMusicDb;
