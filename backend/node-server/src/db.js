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

  // Default settings
  await db.run("INSERT OR IGNORE INTO settings (key, value) VALUES ('sleep_start', '22:00')");
  await db.run("INSERT OR IGNORE INTO settings (key, value) VALUES ('sleep_end', '06:00')");
  await db.run("INSERT OR IGNORE INTO settings (key, value) VALUES ('force_sleep', 'false')");

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
  await db.run(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`, [key, String(value).toLowerCase()]);
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

async function upsertSchedule(playlist, startTime, endTime) {
  const db = await getDb();
  await db.run(`INSERT OR REPLACE INTO schedules (playlist, start_time, end_time) VALUES (?, ?, ?)`, [playlist, startTime, endTime]);
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
  await db.run(`DELETE FROM media_cache WHERE playlist = ?`, [playlist]);
}

function _parseMins(str) {
  const [h, m] = (str || '00:00').split(':').map(Number);
  return h * 60 + m;
}

async function isSystemAsleep() {
  const s = await getSettings();
  if (s.force_sleep === 'true') return true;
  const now = new Date();
  const nowM = now.getHours() * 60 + now.getMinutes();
  const startM = _parseMins(s.sleep_start || '22:00');
  const endM = _parseMins(s.sleep_end || '06:00');
  return startM < endM ? (nowM >= startM && nowM <= endM) : (nowM >= startM || nowM <= endM);
}

async function isPlaylistAllowed(name) {
  const db = await getDb();
  const row = await db.get(`SELECT * FROM schedules WHERE playlist = ?`, [name]);
  if (!row || !row.start_time || !row.end_time) return true;
  const now = new Date();
  const nowM = now.getHours() * 60 + now.getMinutes();
  const startM = _parseMins(row.start_time);
  const endM = _parseMins(row.end_time);
  return startM < endM ? (nowM >= startM && nowM <= endM) : (nowM >= startM || nowM <= endM);
}

async function getVideoPathByHash(hash) {
  const db = await getDb();
  const row = await db.get(`SELECT vpath FROM media_cache WHERE vhash = ?`, [hash]);
  return row ? row.vpath : null;
}

module.exports = {
  initDb, getSettings, setSetting, getOverlay, setOverlay,
  getSchedules, upsertSchedule, deleteSchedule,
  getScheduledDownloads, createScheduledDownload, updateScheduledDownloadStatus, cancelScheduledDownload,
  updateMediaCache, getCachedPlaylists, getCachedVideos, clearOldCache,
  getVideoPathByHash,
  isSystemAsleep, isPlaylistAllowed,
};
