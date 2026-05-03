const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const path = require('path');

async function fix() {
  const db = await open({
    filename: path.join(__dirname, '..', '..', 'jjtv_config.db'),
    driver: sqlite3.Database
  });
  try {
    await db.exec('ALTER TABLE media_cache ADD COLUMN size_mb REAL');
    console.log('Column size_mb added successfully.');
  } catch (e) {
    console.log('Column might already exist or error:', e.message);
  }
  process.exit(0);
}
fix();
