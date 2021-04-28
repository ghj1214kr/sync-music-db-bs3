const audioExtensions = require('audio-extensions');
const fs = require('fs');
const mm = require('music-metadata');
const path = require('path');
const readdir = require('@jsdevtools/readdir-enhanced');
const chokidar = require('chokidar');
const { EventEmitter } = require('events');

// each of the columns in our database table
const TRACK_ATTRS = [
    'path', 'mtime', 'title', 'artist', 'album', 'year', 'duration', 'track_no',
    'tags', 'is_vbr', 'bitrate', 'codec', 'container'
];

const CREATE_TABLE = fs.readFileSync(path.join(__dirname, 'library.sql'))
    .toString();

const UPSERT_TRACK =
    `insert into library (${TRACK_ATTRS}) values ` +
    `(${TRACK_ATTRS.map(() => '?').join(',')}) on conflict(path) do update ` +
    `set ${TRACK_ATTRS.slice(1).map(attr => `${attr}=excluded.${attr}`)}`;

class SyncMusicDb extends EventEmitter {
    constructor({ db, dirs, delay = 1000}) {
        super();

        this.globPattern = '/**/*.+(' + audioExtensions.join('|') + ')';
        this.regex = new RegExp('.+\.(' + audioExtensions.join('|') +')$', 'i');

        this.db = db;
        this.dirs = dirs.map(dir => path.resolve(dir));

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
            const { common, format } = await mm.parseFile(filePath, { skipCovers: true });
            const isVbr =
                format.codec === 'MP3' && /^v/i.test(format.codecProfile);

            return {
                title: common.title === undefined ? path.basename(filePath) : common.title,
                artist: common.artist,
                album: common.album,
                year: common.year,
                duration: Math.round(format.duration),
                track_no: (common.track ? common.track.no : null),
                tags: JSON.stringify(common.genre),
                is_vbr: isVbr ? 0 : 1,
                bitrate: Math.floor(format.bitrate / 1000),
                codec: format.codec,
                container: format.container
            };
        } catch (e) {
            return {};
        }
    }

    async createTable() {
        await this.db.exec(CREATE_TABLE);
    }

    async prepareStatements() {
        this.removeDirStmt =
            await this.db.prepare('delete from library where path like ?');
        this.removeTrackStmt =
            await this.db.prepare('delete from library where path = ?');
        this.upsertTrackStmt = await this.db.prepare(UPSERT_TRACK);
    }

    async finalizeStatements() {
        for (const prefix of ['removeDir', 'removeTrack', 'upsertTrack']) {
            delete this[`${prefix}Stmt`];
        }
    }

    // remove all tracks that begin with directory
    async removeDbDir(dir) {
        await this.removeDirStmt.run(`${dir}${path.sep}%`);
    }

    // remove a single track based on path
    async removeDbTrack(trackPath) {
        await this.removeTrackStmt.run(trackPath);
        this.emit('remove', trackPath);
    }

    // add a single track
    async upsertDbTrack(track, update = false) {
        await this.upsertTrackStmt.run(TRACK_ATTRS.map(attr => track[attr]));
        this.emit(update ? 'update' : 'add', track);
    }

    // grab every file recursively in the dir specified and set their last-
    // modified time in this.localMtimes map
    async refreshLocalMtimes() {
        this.localMtimes.clear();

        const promiseArray = [];

        for (const dir of this.dirs) {
            promiseArray.push(new Promise((resolve, reject) => {
                const dirStream = readdir.stream(dir, {
                    filter: this.regex,
                    basePath: dir,
                    deep: true,
                    stats: true
                });
    
                dirStream
                    .on('file', stats => {
                        this.localMtimes.set(stats.path, Math.floor(stats.mtimeMs));
                    })
                    .on('end', () => resolve())
                    .on('error', err => reject(err))
                    .resume();
            }));
        }

        await Promise.all(promiseArray);
    }


    // remove tracks that don't exist on the filesystem from our database,
    // and remove files from localMtimes that have up-to-date database entries
    removeDeadTracks() {
        const query = this.db.prepare('select path as p, mtime from library');
        
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
        await this.db.exec('begin transaction');

        for (const [ path, mtime ] of this.localMtimes) {
            const track = await SyncMusicDb.getMetaData(path);
            Object.assign(track, { path, mtime });
            await this.upsertDbTrack(track);
        }

        await this.db.exec('commit');

        this.localMtimes.clear();
    }

    // listen for file updates or removals and update the database accordingly
    refreshWatcher() {
        this.watcher = chokidar.watch(this.dirs.map(dir => path.resolve(dir) + this.globPattern), {
            ignoreInitial: true,
            atomic: this.delay
        })
        .on('add', async (path) => {
            this.isSynced = false;
            this.emit('synced', this.isSynced);

            const stats = await fs.promises.stat(path);

            await this.upsertDbTrack(Object.assign({
                path: path,
                mtime: Math.floor(stats.mtimeMs)
            }, await SyncMusicDb.getMetaData(path)));

            this.isSynced = true;
            this.emit('synced', this.isSynced);
        })
        .on('change', async (path) => {
            this.isSynced = false;
            this.emit('synced', this.isSynced);

            const stats = await fs.promises.stat(path);

            await this.upsertDbTrack(Object.assign({
                path: path,
                mtime: Math.floor(stats.mtimeMs)
            }, await SyncMusicDb.getMetaData(path)), true);

            this.isSynced = true;
            this.emit('synced', this.isSynced);
        })
        .on('unlink', async (path) => {
            this.isSynced = false;
            this.emit('synced', this.isSynced);

            await this.removeDbTrack(path);
            
            this.isSynced = true;
            this.emit('synced', this.isSynced);
        })
        .on('ready', () => {
            this.isReady = true;
            this.isSynced = true;
            this.emit('synced', this.isSynced);
            this.emit('ready');
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
            .catch(err => this.emit('error', err));

        return this;
    }

    async close() {
        if (this.removeDirStmt) {
            await this.finalizeStatements();
        }

        if (this.watcher) {
            this.watcher.close();
            this.watcher = null;
        }

        this.isReady = false;
        this.isSynced = false;
        this.emit('synced', this.isSynced);
    }

    addDirs(dirs) {
        this.dirs.push(...dirs.map(dir => path.resolve(dir)));
        this.dirs = [...new Set(this.dirs)];
    }

    removeDirs(dirs) {
        this.dirs = this.dirs.filter((dir) => !dirs.map((dir) => path.resolve(dir)).includes(dir))
    }
};

SyncMusicDb.TRACK_ATTRS = TRACK_ATTRS;

module.exports = SyncMusicDb;
