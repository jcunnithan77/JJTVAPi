const db = require('../src/db');

(async () => {
  await db.initDb();
  console.log('--- ALL SCHEDULES ---');
  const schedules = await db.getSchedules();
  console.log(JSON.stringify(schedules, null, 2));

  console.log('--- PLAYLISTS ---');
  const playlists = await db.getCachedPlaylists();
  console.log(JSON.stringify(playlists, null, 2));

  console.log('--- EVALUATING PLAYLISTS ---');
  for (const p of playlists) {
    const isAllowed = await db.isPlaylistAllowed(p.name);
    console.log(`Playlist "${p.name}" allowed: ${isAllowed}`);
  }
})();
