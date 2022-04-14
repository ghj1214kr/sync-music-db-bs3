"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const fs_1 = __importDefault(require("fs"));
const music_metadata_1 = __importDefault(require("music-metadata"));
const path_1 = __importDefault(require("path"));
const readdir_enhanced_1 = __importDefault(require("@jsdevtools/readdir-enhanced"));
const chokidar_1 = __importDefault(require("chokidar"));
const events_1 = require("events");
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
const CREATE_TABLE = fs_1.default
    .readFileSync(path_1.default.join(__dirname, "library.sql"))
    .toString();
const UPSERT_TRACK = `insert into library (${TRACK_ATTRS}) values ` +
    `(${TRACK_ATTRS.map(() => "?").join(",")}) on conflict(path) do update ` +
    `set ${TRACK_ATTRS.slice(1).map((attr) => `${attr}=excluded.${attr}`)}`;
class SyncMusicDb extends events_1.EventEmitter {
    constructor({ db, dirs, delay = 1000 }) {
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
    static getMetaData(filePath) {
        var _a, _b;
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const { common, format } = yield music_metadata_1.default.parseFile(filePath, {
                    duration: true,
                    skipCovers: true,
                });
                const isVbr = format.codec === "MP3" &&
                    format.codecProfile &&
                    /^v/i.test(format.codecProfile);
                return {
                    title: (_a = common.title) !== null && _a !== void 0 ? _a : path_1.default.basename(filePath),
                    artist: (_b = common.artists) === null || _b === void 0 ? void 0 : _b.join(","),
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
            }
            catch (e) {
                return {};
            }
        });
    }
    createTable() {
        this.db.exec(CREATE_TABLE);
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
        this.emit("remove", trackPath);
    }
    // add a single track
    upsertDbTrack(track, update = false) {
        this.upsertTrackStmt.run(TRACK_ATTRS.map((attr) => track[attr]));
        this.emit(update ? "update" : "add", track);
    }
    // grab every file recursively in the dir specified and set their last-
    // modified time in this.localMtimes map
    refreshLocalMtimes() {
        return __awaiter(this, void 0, void 0, function* () {
            this.localMtimes.clear();
            const promiseArray = [];
            for (const dir of this.dirs) {
                promiseArray.push(new Promise((resolve, reject) => {
                    const dirStream = readdir_enhanced_1.default.stream(dir, {
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
                }));
            }
            yield Promise.all(promiseArray);
        });
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
    addUpdatedTracks() {
        return __awaiter(this, void 0, void 0, function* () {
            this.db.exec("begin transaction");
            for (const [path, mtime] of this.localMtimes) {
                const track = yield SyncMusicDb.getMetaData(path);
                Object.assign(track, { path, mtime });
                this.upsertDbTrack(track);
            }
            this.db.exec("commit");
            this.localMtimes.clear();
        });
    }
    // listen for file updates or removals and update the database accordingly
    refreshWatcher() {
        this.watcher = chokidar_1.default
            .watch(this.dirs, {
            ignoreInitial: true,
            atomic: this.delay,
        })
            .on("add", (path) => __awaiter(this, void 0, void 0, function* () {
            if (!this.audioExtensions.includes(path.slice(((path.lastIndexOf(".") - 1) >>> 0) + 2).toLowerCase())) {
                return;
            }
            this.isSynced = false;
            this.emit("synced", this.isSynced);
            const stats = yield fs_1.default.promises.stat(path);
            this.upsertDbTrack(Object.assign({
                path: path,
                mtime: Math.floor(stats.mtimeMs),
            }, yield SyncMusicDb.getMetaData(path)));
            this.isSynced = true;
            this.emit("synced", this.isSynced);
        }))
            .on("change", (path) => __awaiter(this, void 0, void 0, function* () {
            if (!this.audioExtensions.includes(path.slice(((path.lastIndexOf(".") - 1) >>> 0) + 2).toLowerCase())) {
                return;
            }
            this.isSynced = false;
            this.emit("synced", this.isSynced);
            const stats = yield fs_1.default.promises.stat(path);
            this.upsertDbTrack(Object.assign({
                path: path,
                mtime: Math.floor(stats.mtimeMs),
            }, yield SyncMusicDb.getMetaData(path)), true);
            this.isSynced = true;
            this.emit("synced", this.isSynced);
        }))
            .on("unlink", (path) => __awaiter(this, void 0, void 0, function* () {
            if (!this.audioExtensions.includes(path.slice(((path.lastIndexOf(".") - 1) >>> 0) + 2).toLowerCase())) {
                return;
            }
            this.isSynced = false;
            this.emit("synced", this.isSynced);
            this.removeDbTrack(path);
            this.isSynced = true;
            this.emit("synced", this.isSynced);
        }))
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
    close() {
        return __awaiter(this, void 0, void 0, function* () {
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
        });
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
