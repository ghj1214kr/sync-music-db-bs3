const SyncMusicDb = require('./');
const Database = require('better-sqlite3');

(async () => {
    const db = new Database("example.db");
    const syncMusicDb = new SyncMusicDb({ db, dir: ['./test/_music'] });

    await syncMusicDb.createTable();

    console.time('sync');

    syncMusicDb
        .on('ready', () => console.timeEnd('sync'))
        .on('add', track => console.log(`${track.title} added`))
        .on('remove', path => console.log(`${path} removed`))
        .on('error', err => console.error(err))
        .refresh();
})();
