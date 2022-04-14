import SyncMusicDb from '../src';
import Database from 'better-sqlite3';

(async () => {
    const db = new Database("example.db");
    const syncMusicDb = new SyncMusicDb({ db, dirs: ['../test/_music'] });

    syncMusicDb.createTable();

    console.time('sync');

    syncMusicDb
        .on('ready', () => console.timeEnd('sync'))
        .on('add', track => console.log(`${track.title} added`))
        .on('remove', path => console.log(`${path} removed`))
        .on('error', err => console.error(err))
        .refresh();
})();
