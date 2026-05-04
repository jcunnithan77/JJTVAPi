const sqlite3 = require('better-sqlite3');
const path = require('path');

const dbPath = 'd:\\JC\\Personal\\projects\\TvApp-JJtv\\JJTVAPI\\backend\\jjtv_config.db';
const db = new sqlite3(dbPath);

console.log('--- Media Cache Entries ---');
const rows = db.prepare('SELECT vpath, playlist, filename FROM media_cache LIMIT 10').all();
rows.forEach(row => {
    console.log(`Playlist: ${row.playlist} | Filename: ${row.filename} | Path: ${row.vpath}`);
});

console.log('\n--- Settings ---');
const settings = db.prepare('SELECT * FROM settings').all();
settings.forEach(s => {
    console.log(`${s.key}: ${s.value}`);
});
