"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const fs_1 = __importDefault(require("fs"));
const mm = __importStar(require("music-metadata"));
const path_1 = __importDefault(require("path"));
const readdir_enhanced_1 = __importDefault(require("@jsdevtools/readdir-enhanced"));
const chokidar_1 = __importDefault(require("chokidar"));
const events_1 = require("events");
const audioExtensions = [
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
const regex = new RegExp(".+.(" + audioExtensions.join("|") + ")$", "i");
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
const UPSERT_TRACK = `insert into library (${TRACK_ATTRS}) values ` +
    `(${TRACK_ATTRS.map(() => "?").join(",")}) on conflict(path) do update ` +
    `set ${TRACK_ATTRS.slice(1).map((attr) => `${attr}=excluded.${attr}`)}`;
class SyncMusicDb extends events_1.EventEmitter {
    db;
    dirs;
    delay;
    localMtimes;
    isReady;
    isSynced;
    removeDirStmt;
    removeTrackStmt;
    upsertTrackStmt;
    watcher;
    static TRACK_ATTRS;
    constructor({ db, dirs, delay = 1000 }) {
        super();
        this.db = db;
        this.dirs = dirs.map((dir) => path_1.default.resolve(dir));
        this.delay = delay;
        // { path: fs.stat.mtimeMs }
        this.localMtimes = new Map();
        // is the initial sync done and are we ready to listen for new changes?
        this.isReady = false;
        // is dir up-to-date with db?
        this.isSynced = false;
    }
    // get each column of (TRACK_ATTRS) from the media file
    static async getMetaData(filePath) {
        try {
            const { common, format } = await mm.parseFile(filePath, {
                duration: true,
                skipCovers: true,
            });
            const isVbr = format.codec === "MP3" &&
                format.codecProfile !== undefined &&
                /^v/i.test(format.codecProfile);
            return {
                title: common.title ?? path_1.default.basename(filePath).normalize(),
                artist: common.artists?.join(","),
                album: common.album,
                year: common.year,
                duration: format.duration && Math.round(format.duration),
                track_no: common.track ? common.track.no : null,
                tags: JSON.stringify(common.genre),
                is_vbr: isVbr ? 1 : 0,
                bitrate: format.bitrate && Math.floor(format.bitrate / 1000),
                codec: format.codec,
                container: format.container,
            };
        }
        catch (e) {
            return { title: path_1.default.basename(filePath).normalize() };
        }
    }
    createTable() {
        this.db.exec(`
      CREATE TABLE IF NOT EXISTS library (
        "id"	INTEGER,
        "path"	TEXT UNIQUE,
        "mtime"	INTEGER,
        "title"	TEXT,
        "artist"	TEXT,
        "album"	TEXT,
        "year"	INTEGER,
        "duration"	INTEGER,
        "track_no"	INTEGER,
        "disk"	INTEGER DEFAULT 1,
        "tags"	TEXT,
        "is_vbr"	INTEGER DEFAULT 0,
        "bitrate"	INTEGER,
        "codec"	TEXT,
        "container"	TEXT,
        PRIMARY KEY("id")
      );
      
      CREATE INDEX IF NOT EXISTS "artist" ON library (
        "artist"	ASC
      );
      
      CREATE INDEX IF NOT EXISTS "title" ON library (
        "title"
      );    
    `);
    }
    prepareStatements() {
        this.removeDirStmt = this.db.prepare("delete from library where path like ?");
        this.removeTrackStmt = this.db.prepare("delete from library where path = ?");
        this.upsertTrackStmt = this.db.prepare(UPSERT_TRACK);
    }
    finalizeStatements() {
        delete this["removeDirStmt"];
        delete this["removeTrackStmt"];
        delete this["upsertTrackStmt"];
    }
    // remove all tracks that begin with directory
    removeDbDir(dir) {
        this.removeDirStmt.run(`${dir}${path_1.default.sep}%`);
    }
    // remove a single track based on path
    removeDbTrack(trackPath) {
        this.removeTrackStmt.run(trackPath);
        this.emit("remove", trackPath.normalize());
    }
    // add a single track
    upsertDbTrack(track, update = false) {
        this.upsertTrackStmt.run(TRACK_ATTRS.map((attr) => track[attr]));
        this.emit(update ? "update" : "add", track);
    }
    // grab every file recursively in the dir specified and set their last-
    // modified time in this.localMtimes map
    async refreshLocalMtimes() {
        this.localMtimes.clear();
        const promiseArray = [];
        for (const dir of this.dirs) {
            promiseArray.push(new Promise((resolve, reject) => {
                const dirStream = readdir_enhanced_1.default.stream(dir, {
                    filter: regex,
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
            }));
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
                }
                else if (localMtime === mtime) {
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
            Object.assign(track, { path: path.normalize(), mtime });
            this.upsertDbTrack(track);
        }
        this.db.exec("commit");
        this.localMtimes.clear();
    }
    // listen for file updates or removals and update the database accordingly
    refreshWatcher() {
        this.watcher = chokidar_1.default
            .watch(this.dirs, {
            ignoreInitial: true,
            atomic: this.delay,
        })
            .on("add", async (path) => {
            if (!audioExtensions.includes(path.slice(((path.lastIndexOf(".") - 1) >>> 0) + 2).toLowerCase())) {
                return;
            }
            this.isSynced = false;
            this.emit("synced", this.isSynced);
            const stats = await fs_1.default.promises.stat(path);
            this.upsertDbTrack(Object.assign({
                path: path,
                mtime: Math.floor(stats.mtimeMs),
            }, await SyncMusicDb.getMetaData(path)));
            this.isSynced = true;
            this.emit("synced", this.isSynced);
        })
            .on("change", async (path) => {
            if (!audioExtensions.includes(path.slice(((path.lastIndexOf(".") - 1) >>> 0) + 2).toLowerCase())) {
                return;
            }
            this.isSynced = false;
            this.emit("synced", this.isSynced);
            const stats = await fs_1.default.promises.stat(path);
            this.upsertDbTrack(Object.assign({
                path: path.normalize(),
                mtime: Math.floor(stats.mtimeMs),
            }, await SyncMusicDb.getMetaData(path)), true);
            this.isSynced = true;
            this.emit("synced", this.isSynced);
        })
            .on("unlink", async (path) => {
            if (!audioExtensions.includes(path.slice(((path.lastIndexOf(".") - 1) >>> 0) + 2).toLowerCase())) {
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
    addDirs(dirs) {
        this.dirs.push(...dirs.map((dir) => path_1.default.resolve(dir)));
        this.dirs = [...new Set(this.dirs)];
    }
    removeDirs(dirs) {
        this.dirs = this.dirs.filter((dir) => !dirs.map((dir) => path_1.default.resolve(dir)).includes(dir));
    }
}
SyncMusicDb.TRACK_ATTRS = TRACK_ATTRS;
exports.default = SyncMusicDb;
