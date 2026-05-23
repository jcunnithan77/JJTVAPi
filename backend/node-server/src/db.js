'use strict';

const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', '..', 'jjtv_config.db');

let _db = null;

async function getDb() {
  if (!_db) {
    _db = await open({
      filename: DB_PATH,
      driver: sqlite3.Database
    });
    await _db.exec('PRAGMA journal_mode = WAL');
  }
  return _db;
}

async function initDb() {
  const db = await getDb();
  await db.exec(`
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS schedules (playlist TEXT PRIMARY KEY, start_time TEXT, end_time TEXT);
    CREATE TABLE IF NOT EXISTS scheduled_downloads (
      id TEXT PRIMARY KEY, url TEXT NOT NULL, playlist TEXT NOT NULL,
      scheduled_at TEXT NOT NULL, status TEXT DEFAULT 'pending',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS overlay_config (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS media_cache (
      vpath TEXT PRIMARY KEY,
      playlist TEXT,
      filename TEXT,
      title TEXT,
      thumbnail TEXT,
      duration TEXT,
      size_mb REAL,
      vhash TEXT,
      last_seen DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  try { await db.exec(`ALTER TABLE schedules ADD COLUMN lock_message TEXT`); } catch(e) {}
  try { await db.exec(`ALTER TABLE schedules ADD COLUMN lock_audio TEXT`); } catch(e) {}
  try { await db.exec(`ALTER TABLE schedules ADD COLUMN priority INTEGER DEFAULT 0`); } catch(e) {}
  try { await db.exec(`ALTER TABLE schedules ADD COLUMN min_duration INTEGER DEFAULT 0`); } catch(e) {}
  try { await db.exec(`ALTER TABLE schedules ADD COLUMN watch_limit INTEGER DEFAULT 3`); } catch(e) {}
  try { await db.exec(`ALTER TABLE daily_playlist_progress ADD COLUMN watched_duration INTEGER DEFAULT 0`); } catch(e) {}

  await db.exec(`
    CREATE TABLE IF NOT EXISTS force_lock_profiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      icon_url TEXT DEFAULT '',
      audio_url TEXT DEFAULT '',
      message TEXT DEFAULT '',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS daily_playlist_progress (
      playlist TEXT NOT NULL, 
      date TEXT NOT NULL, 
      completed INTEGER DEFAULT 0,
      PRIMARY KEY (playlist, date)
    );
    CREATE TABLE IF NOT EXISTS video_watch_log (
      vhash TEXT NOT NULL, 
      playlist TEXT NOT NULL, 
      watch_count INTEGER DEFAULT 0,
      demoted INTEGER DEFAULT 0, 
      last_watched TEXT, 
      PRIMARY KEY (vhash, playlist)
    );
  `);
  await db.run("INSERT OR IGNORE INTO settings (key, value) VALUES ('force_lock_profile_id', '')");

  // Default settings
  await db.run("INSERT OR IGNORE INTO settings (key, value) VALUES ('sleep_start', '22:00')");
  await db.run("INSERT OR IGNORE INTO settings (key, value) VALUES ('sleep_end', '06:00')");
  await db.run("INSERT OR IGNORE INTO settings (key, value) VALUES ('force_sleep', 'false')");
  await db.run("INSERT OR IGNORE INTO settings (key, value) VALUES ('sleep_message', 'Time for bed! See you tomorrow.')");
  await db.run("INSERT OR IGNORE INTO settings (key, value) VALUES ('sleep_audio', '')");
  await db.run("INSERT OR IGNORE INTO settings (key, value) VALUES ('sleep_image', '')");
  await db.run("INSERT OR IGNORE INTO settings (key, value) VALUES ('timezone', 'local')");
  await db.run("INSERT OR IGNORE INTO settings (key, value) VALUES ('force_lock_message', '')");
  await db.run("INSERT OR IGNORE INTO settings (key, value) VALUES ('force_lock_audio', '')");
  await db.run("INSERT OR IGNORE INTO settings (key, value) VALUES ('force_lock_image', '')");
  await db.run("INSERT OR IGNORE INTO settings (key, value) VALUES ('stream_through_lan', 'false')");

  // Overlay defaults
  await db.run("INSERT OR IGNORE INTO overlay_config (key, value) VALUES ('enabled', 'false')");
  await db.run("INSERT OR IGNORE INTO overlay_config (key, value) VALUES ('banner_text', 'Welcome to JJtv!')");
  await db.run("INSERT OR IGNORE INTO overlay_config (key, value) VALUES ('music_url', '')");
  await db.run("INSERT OR IGNORE INTO overlay_config (key, value) VALUES ('music_volume', '0.3')");
  await db.run("INSERT OR IGNORE INTO overlay_config (key, value) VALUES ('banner_position', 'bottom')");
  await db.run("INSERT OR IGNORE INTO overlay_config (key, value) VALUES ('banner_color', '#1a1a2e')");
  
  console.log('[DB] Initialized.');
}

async function getSettings() {
  const db = await getDb();
  const rows = await db.all(`SELECT key, value FROM settings`);
  return Object.fromEntries(rows.map(r => [r.key, r.value]));
}

async function setSetting(key, value) {
  const db = await getDb();
  const storedValue = key === 'timezone' ? String(value) : String(value).toLowerCase();
  await db.run(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`, [key, storedValue]);
}

async function getOverlay() {
  const db = await getDb();
  const rows = await db.all(`SELECT key, value FROM overlay_config`);
  return Object.fromEntries(rows.map(r => [r.key, r.value]));
}

async function setOverlay(key, value) {
  const db = await getDb();
  await db.run(`INSERT OR REPLACE INTO overlay_config (key, value) VALUES (?, ?)`, [key, String(value)]);
}

async function getSchedules() {
  const db = await getDb();
  return await db.all(`SELECT * FROM schedules`);
}

async function getSchedule(playlist) {
  const db = await getDb();
  return await db.get(`SELECT * FROM schedules WHERE playlist = ?`, [playlist]);
}

async function upsertSchedule(playlist, startTime, endTime, lockMessage = '', lockAudio = '', priority = 0, minDuration = 0, watchLimit = 3) {
  const db = await getDb();
  await db.run(`INSERT OR REPLACE INTO schedules (playlist, start_time, end_time, lock_message, lock_audio, priority, min_duration, watch_limit) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, 
    [playlist, startTime, endTime, lockMessage, lockAudio, priority, minDuration, watchLimit]);
}

async function deleteSchedule(playlist) {
  const db = await getDb();
  await db.run(`DELETE FROM schedules WHERE playlist = ?`, [playlist]);
}

async function getScheduledDownloads() {
  const db = await getDb();
  return await db.all(`SELECT * FROM scheduled_downloads ORDER BY scheduled_at DESC`);
}

async function createScheduledDownload(id, url, playlist, scheduledAt) {
  const db = await getDb();
  await db.run(`INSERT INTO scheduled_downloads (id, url, playlist, scheduled_at, status) VALUES (?, ?, ?, ?, 'pending')`, [id, url, playlist, scheduledAt]);
}

async function updateScheduledDownloadStatus(id, status) {
  const db = await getDb();
  await db.run(`UPDATE scheduled_downloads SET status = ? WHERE id = ?`, [status, id]);
}

async function cancelScheduledDownload(id) {
  const db = await getDb();
  await db.run(`UPDATE scheduled_downloads SET status = 'cancelled' WHERE id = ? AND status = 'pending'`, [id]);
}

async function updateMediaCache(vpath, playlist, filename, title, thumbnail, duration, size_mb, vhash) {
  const db = await getDb();
  await db.run(`
    INSERT OR REPLACE INTO media_cache (vpath, playlist, filename, title, thumbnail, duration, size_mb, vhash, last_seen)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `, [vpath, playlist, filename, title, thumbnail, duration, size_mb, vhash]);
}

async function getCachedPlaylists() {
  const db = await getDb();
  // Return folders with video counts
  return await db.all(`
    SELECT playlist as name, COUNT(*) as count 
    FROM media_cache 
    GROUP BY playlist 
    ORDER BY playlist ASC
  `);
}

async function getCachedVideos(playlist) {
  const db = await getDb();
  return await db.all(`
    SELECT * FROM media_cache 
    WHERE playlist = ? 
    ORDER BY filename ASC
  `, [playlist]);
}

async function clearOldCache(playlist) {
  const db = await getDb();
  // We can't easily do a "last_seen" cleanup without a full scan, but we can delete a playlist before re-scanning
  const res = await db.run(`DELETE FROM media_cache WHERE playlist = ?`, [playlist]);
  if (res.changes > 0) {
    console.log(`[DB] Deleted ${res.changes} rows for playlist: ${playlist}`);
  }
}

function _parseMins(str) {
  const [h, m] = (str || '00:00').split(':').map(Number);
  return h * 60 + m;
}

async function getNowInConfiguredTimezone() {
  const now = new Date();
  const db = await getDb();
  const row = await db.get(`SELECT value FROM settings WHERE key = 'timezone'`);
  const timezone = row ? row.value : null;

  if (!timezone || timezone === 'local') return now;

  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      hour12: false
    });

    const parts = formatter.formatToParts(now);
    const dateParts = {};
    for (const part of parts) {
      dateParts[part.type] = part.value;
    }

    return new Date(
      parseInt(dateParts.year),
      parseInt(dateParts.month) - 1,
      parseInt(dateParts.day),
      parseInt(dateParts.hour),
      parseInt(dateParts.minute),
      parseInt(dateParts.second)
    );
  } catch (e) {
    console.error(`[DB] Error parsing configured timezone "${timezone}":`, e);
    return now;
  }
}

async function isSystemAsleep() {
  const s = await getSettings();
  const defaultMsg = s.sleep_message || 'Time for bed!';
  const defaultAudio = s.sleep_audio || '';
  const defaultImage = s.sleep_image || '';

  if (s.force_sleep === 'true') {
    const profileId = s.force_lock_profile_id;
    let profileData = {};
    if (profileId) {
      const profile = await getLockProfile(parseInt(profileId));
      if (profile) {
        profileData = {
          message: profile.message || s.force_lock_message || defaultMsg,
          audio:   profile.audio_url || s.force_lock_audio || defaultAudio,
          image:   profile.icon_url  || s.force_lock_image || defaultImage,
        };
      }
    }
    return {
      locked: true,
      message: profileData.message || s.force_lock_message || defaultMsg,
      audio:   profileData.audio   || s.force_lock_audio   || defaultAudio,
      image:   profileData.image   || s.force_lock_image   || defaultImage,
      profile_id: profileId || null,
    };
  }

  const now = await getNowInConfiguredTimezone();
  const nowM = now.getHours() * 60 + now.getMinutes();

  if (s.sleep_slots) {
    try {
      const slots = JSON.parse(s.sleep_slots);
      if (Array.isArray(slots) && slots.length > 0) {
        for (const slot of slots) {
          if (!slot.start || !slot.end) continue;
          const startM = _parseMins(slot.start);
          const endM = _parseMins(slot.end);
          const isSlotActive = startM < endM ? (nowM >= startM && nowM <= endM) : (nowM >= startM || nowM <= endM);
          if (isSlotActive) {
            return {
              locked: true,
              message: slot.message || defaultMsg,
              audio: slot.audio || defaultAudio,
              image: slot.image || defaultImage
            };
          }
        }
        return false;
      }
    } catch (e) {
      console.error('[DB] Failed to parse sleep_slots', e);
    }
  }

  const startM = _parseMins(s.sleep_start || '22:00');
  const endM = _parseMins(s.sleep_end || '06:00');
  const isLegacyActive = startM < endM ? (nowM >= startM && nowM <= endM) : (nowM >= startM || nowM <= endM);
  if (isLegacyActive) {
    return { locked: true, message: defaultMsg, audio: defaultAudio, image: defaultImage };
  }
  return false;
}

async function getPlaylistsForDisplay() {
  const db = await getDb();
  const now = await getNowInConfiguredTimezone();
  const today = now.toISOString().slice(0, 10);
  const nowM = now.getHours() * 60 + now.getMinutes();

  const schedules = await db.all(
    `SELECT * FROM schedules WHERE start_time IS NOT NULL AND start_time != '' ORDER BY priority DESC`
  );

  const activePriority = [];
  const scheduledNames = new Set();

  for (const s of schedules) {
    scheduledNames.add(s.playlist);
    const startM = _parseMins(s.start_time);
    const endM   = _parseMins(s.end_time);
    const inWindow = startM < endM
      ? (nowM >= startM && nowM <= endM)
      : (nowM >= startM || nowM <= endM);
    if (inWindow) activePriority.push(s.playlist);
  }

  if (activePriority.length === 0) {
    return { mode: 'all', playlists: null };
  }

  const placeholders = activePriority.map(() => '?').join(',');
  
  // Get active priority schedules to check their completion requirements
  const activeSchedules = await db.all(
    `SELECT playlist, min_duration FROM schedules WHERE playlist IN (${placeholders})`,
    activePriority
  );
  const minDurationMap = {};
  for (const s of activeSchedules) {
    minDurationMap[s.playlist] = s.min_duration || 0;
  }

  const completionRows = await db.all(
    `SELECT playlist, completed, watched_duration FROM daily_playlist_progress WHERE date = ? AND playlist IN (${placeholders})`,
    [today, ...activePriority]
  );
  
  const completedSet = new Set();
  for (const row of completionRows) {
    const minDurMins = minDurationMap[row.playlist] || 0;
    if (row.completed === 1) {
      completedSet.add(row.playlist);
    } else if (minDurMins > 0 && row.watched_duration >= minDurMins * 60) {
      completedSet.add(row.playlist);
      // Mark as completed in DB
      await db.run(
        `UPDATE daily_playlist_progress SET completed = 1 WHERE playlist = ? AND date = ?`,
        [row.playlist, today]
      );
    }
  }

  const allDone = activePriority.every(p => completedSet.has(p));

  if (allDone) {
    return { mode: 'fallback', playlists: null, excludeScheduled: scheduledNames };
  }

  return { mode: 'priority', playlists: activePriority.filter(p => !completedSet.has(p)) };
}

async function isPlaylistAllowed(name) {
  const result = await getPlaylistsForDisplay();
  if (result.mode === 'all') return true;
  if (result.mode === 'priority') return result.playlists.includes(name);
  if (result.mode === 'fallback') return !result.excludeScheduled.has(name);
  return true;
}

// --- Force Lock Profiles ---
async function getLockProfiles() {
  const db = await getDb();
  return await db.all(`SELECT * FROM force_lock_profiles ORDER BY id ASC`);
}

async function getLockProfile(id) {
  const db = await getDb();
  return await db.get(`SELECT * FROM force_lock_profiles WHERE id = ?`, [id]);
}

async function upsertLockProfile(id, name, iconUrl, audioUrl, message) {
  const db = await getDb();
  if (id) {
    await db.run(
      `UPDATE force_lock_profiles SET name=?, icon_url=?, audio_url=?, message=? WHERE id=?`,
      [name, iconUrl, audioUrl, message, id]
    );
    return id;
  } else {
    const res = await db.run(
      `INSERT INTO force_lock_profiles (name, icon_url, audio_url, message) VALUES (?, ?, ?, ?)`,
      [name, iconUrl, audioUrl, message]
    );
    return res.lastID;
  }
}

async function deleteLockProfile(id) {
  const db = await getDb();
  const active = await db.get(`SELECT value FROM settings WHERE key='force_lock_profile_id'`);
  if (active && active.value === String(id)) {
    await db.run(`UPDATE settings SET value='' WHERE key='force_lock_profile_id'`);
    await db.run(`UPDATE settings SET value='false' WHERE key='force_sleep'`);
  }
  await db.run(`DELETE FROM force_lock_profiles WHERE id = ?`, [id]);
}

function parseDurationToSeconds(durationStr) {
  if (!durationStr) return 0;
  const parts = durationStr.split(':').map(Number);
  if (parts.some(isNaN)) return 0;
  if (parts.length === 2) {
    return parts[0] * 60 + parts[1];
  } else if (parts.length === 3) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }
  if (parts.length === 1) return parts[0];
  return 0;
}

// --- Video Watch Progress ---
async function recordVideoWatch(vhash, playlist) {
  const db = await getDb();
  await db.run(`
    INSERT INTO video_watch_log (vhash, playlist, watch_count, demoted, last_watched)
    VALUES (?, ?, 1, 0, CURRENT_TIMESTAMP)
    ON CONFLICT(vhash, playlist) DO UPDATE SET
      watch_count = watch_count + 1,
      last_watched = CURRENT_TIMESTAMP
  `, [vhash, playlist]);
  const row = await db.get(`SELECT watch_count FROM video_watch_log WHERE vhash=? AND playlist=?`, [vhash, playlist]);

  // Update daily watched duration
  const video = await db.get(`SELECT duration FROM media_cache WHERE vhash = ?`, [vhash]);
  if (video && video.duration) {
    const seconds = parseDurationToSeconds(video.duration);
    if (seconds > 0) {
      const today = new Date().toISOString().slice(0, 10);
      await db.run(`
        INSERT INTO daily_playlist_progress (playlist, date, completed, watched_duration)
        VALUES (?, ?, 0, ?)
        ON CONFLICT(playlist, date) DO UPDATE SET
          watched_duration = watched_duration + ?
      `, [playlist, today, seconds, seconds]);
    }
  }

  return row ? row.watch_count : 1;
}

async function demoteVideo(vhash, playlist) {
  const db = await getDb();
  await db.run(`UPDATE video_watch_log SET demoted=1 WHERE vhash=? AND playlist=?`, [vhash, playlist]);
}

async function getPlaylistWatchLog(playlist) {
  const db = await getDb();
  return await db.all(`SELECT * FROM video_watch_log WHERE playlist=?`, [playlist]);
}

async function resetPlaylistWatchLog(playlist) {
  const db = await getDb();
  await db.run(`DELETE FROM video_watch_log WHERE playlist=?`, [playlist]);
}

async function markPlaylistCompleted(playlist) {
  const db = await getDb();
  const today = new Date().toISOString().slice(0, 10);
  await db.run(`
    INSERT OR REPLACE INTO daily_playlist_progress (playlist, date, completed)
    VALUES (?, ?, 1)
  `, [playlist, today]);
}

async function getVideoPathByHash(hash) {
  const db = await getDb();
  const row = await db.get(`SELECT vpath FROM media_cache WHERE vhash = ?`, [hash]);
  return row ? row.vpath : null;
}

module.exports = {
  initDb, getSettings, setSetting, getOverlay, setOverlay,
  getSchedules, getSchedule, upsertSchedule, deleteSchedule,
  getScheduledDownloads, createScheduledDownload, updateScheduledDownloadStatus, cancelScheduledDownload,
  updateMediaCache, getCachedPlaylists, getCachedVideos, clearOldCache,
  getVideoPathByHash,
  isSystemAsleep, isPlaylistAllowed, getPlaylistsForDisplay,
  getLockProfiles, getLockProfile, upsertLockProfile, deleteLockProfile,
  recordVideoWatch, demoteVideo, getPlaylistWatchLog, resetPlaylistWatchLog, markPlaylistCompleted
};
