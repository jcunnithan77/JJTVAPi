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
    CREATE TABLE IF NOT EXISTS rotation_groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      enabled INTEGER DEFAULT 0,
      started_at INTEGER DEFAULT 0,
      sort_order INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS rotation_steps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id INTEGER NOT NULL,
      step_order INTEGER NOT NULL,
      type TEXT NOT NULL,
      playlist TEXT,
      duration_minutes INTEGER NOT NULL,
      start_time TEXT,
      end_time TEXT,
      mandatory INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS media_cache (
      vpath TEXT PRIMARY KEY,
      playlist TEXT,
      filename TEXT,
      title TEXT,
      thumbnail TEXT,
      duration TEXT,
      size_mb REAL,
      vhash TEXT,
      file_created_at INTEGER DEFAULT 0,
      last_seen DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  try { await db.exec(`ALTER TABLE schedules ADD COLUMN lock_message TEXT`); } catch(e) {}
  try { await db.exec(`ALTER TABLE schedules ADD COLUMN lock_audio TEXT`); } catch(e) {}
  try { await db.exec(`ALTER TABLE schedules ADD COLUMN priority INTEGER DEFAULT 0`); } catch(e) {}
  try { await db.exec(`ALTER TABLE schedules ADD COLUMN min_duration INTEGER DEFAULT 0`); } catch(e) {}
  try { await db.exec(`ALTER TABLE schedules ADD COLUMN watch_limit INTEGER DEFAULT 3`); } catch(e) {}
  try { await db.exec(`ALTER TABLE schedules ADD COLUMN mandatory_view INTEGER DEFAULT 0`); } catch(e) {}
  try { await db.exec(`ALTER TABLE schedules ADD COLUMN is_blocked INTEGER DEFAULT 0`); } catch(e) {}
  try { await db.exec(`ALTER TABLE schedules ADD COLUMN req_ack INTEGER DEFAULT 0`); } catch(e) {}
  try { await db.exec(`ALTER TABLE schedules ADD COLUMN min_repeat INTEGER DEFAULT 1`); } catch(e) {}
  try { await db.exec(`ALTER TABLE schedules ADD COLUMN max_repeat INTEGER DEFAULT 3`); } catch(e) {}
  // The time-window scheduler (start_time/end_time/lock_message/lock_audio) was retired
  // in favor of Rotation; clear any leftover values so they can't silently restrict playback.
  try { await db.exec(`UPDATE schedules SET start_time = NULL, end_time = NULL, lock_message = NULL, lock_audio = NULL`); } catch(e) {}
  try { await db.exec(`ALTER TABLE daily_playlist_progress ADD COLUMN watched_duration INTEGER DEFAULT 0`); } catch(e) {}
  try { await db.exec(`ALTER TABLE media_cache ADD COLUMN file_created_at INTEGER DEFAULT 0`); } catch(e) {}

  // Rotation: steps now belong to a named, independently enable/disable-able group,
  // and each play step may have an optional clock-time window and a mandatory lock.
  try { await db.exec(`ALTER TABLE rotation_steps ADD COLUMN group_id INTEGER`); } catch(e) {}
  try { await db.exec(`ALTER TABLE rotation_steps ADD COLUMN start_time TEXT`); } catch(e) {}
  try { await db.exec(`ALTER TABLE rotation_steps ADD COLUMN end_time TEXT`); } catch(e) {}
  try { await db.exec(`ALTER TABLE rotation_steps ADD COLUMN mandatory INTEGER DEFAULT 0`); } catch(e) {}
  try {
    // One-time migration: wrap any pre-existing flat (ungrouped) rotation steps,
    // plus the old global rotation_enabled/rotation_started_at settings, into a "Default" group.
    const orphaned = await db.get(`SELECT COUNT(*) AS c FROM rotation_steps WHERE group_id IS NULL`);
    if (orphaned && orphaned.c > 0) {
      const oldEnabledRow = await db.get(`SELECT value FROM settings WHERE key = 'rotation_enabled'`);
      const oldStartedRow = await db.get(`SELECT value FROM settings WHERE key = 'rotation_started_at'`);
      const oldEnabled = oldEnabledRow && oldEnabledRow.value === 'true' ? 1 : 0;
      const oldStarted = parseInt((oldStartedRow && oldStartedRow.value) || '0') || Date.now();
      const g = await db.run(
        `INSERT INTO rotation_groups (name, enabled, started_at, sort_order) VALUES ('Default', ?, ?, 0)`,
        [oldEnabled, oldStarted]
      );
      await db.run(`UPDATE rotation_steps SET group_id = ? WHERE group_id IS NULL`, [g.lastID]);
    }
  } catch(e) {}

  await db.exec(`
    CREATE TABLE IF NOT EXISTS force_lock_profiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      icon_url TEXT DEFAULT '',
      audio_url TEXT DEFAULT '',
      message TEXT DEFAULT '',
      duration_minutes INTEGER DEFAULT 0,
      activated_at TEXT DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS live_streams (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      url TEXT NOT NULL,
      thumbnail TEXT DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS active_acknowledgements (
      playlist TEXT PRIMARY KEY,
      acknowledged INTEGER DEFAULT 0,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
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
  try { await db.exec(`ALTER TABLE force_lock_profiles ADD COLUMN duration_minutes INTEGER DEFAULT 0`); } catch(e) {}

  await db.run("INSERT OR IGNORE INTO settings (key, value) VALUES ('force_lock_profile_id', '')");
  await db.run("INSERT OR IGNORE INTO settings (key, value) VALUES ('force_lock_activated_at', '')");

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
  await db.run("INSERT OR IGNORE INTO settings (key, value) VALUES ('rotation_enabled', 'false')");
  await db.run("INSERT OR IGNORE INTO settings (key, value) VALUES ('rotation_started_at', '')");

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

async function upsertSchedule(playlist, priority, minDuration, watchLimit, mandatoryView, isBlocked, reqAck, minRepeat, maxRepeat) {
  const db = await getDb();
  // start_time/end_time/lock_message/lock_audio are legacy columns from the
  // retired time-window scheduler; left NULL going forward (superseded by Rotation).
  await db.run(
    `INSERT OR REPLACE INTO schedules (playlist, priority, min_duration, watch_limit, mandatory_view, is_blocked, req_ack, min_repeat, max_repeat)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [playlist, priority || 0, minDuration || 0, watchLimit || 3, mandatoryView || 0, isBlocked || 0, reqAck || 0, minRepeat || 1, maxRepeat || 3]
  );
}

async function deleteSchedule(playlist) {
  const db = await getDb();
  await db.run(`DELETE FROM schedules WHERE playlist = ?`, [playlist]);
}

// --- Rotation (named groups of repeating play/pause cycles, each independently on/off) ---

// True while nowM falls inside [startTime, endTime) (wrapping past midnight if end < start).
// No window defined on either end means "always eligible".
function _inClockWindow(startTime, endTime, nowM) {
  if (!startTime || !endTime) return true;
  const startM = _parseMins(startTime);
  const endM = _parseMins(endTime);
  return startM < endM ? (nowM >= startM && nowM <= endM) : (nowM >= startM || nowM <= endM);
}

// Pure computation of a single group's current state — no DB access, so it can be
// reused for both the live scheduling decision and the admin status display without
// re-querying. `nowM` = minutes since local midnight, for each step's optional time window.
function _computeGroupStatus(group, nowM) {
  const steps = group.steps || [];
  const base = { groupId: group.id, name: group.name, enabled: group.enabled, steps };

  if (!group.enabled || steps.length === 0) {
    return { ...base, mode: 'off' };
  }

  // A mandatory step locks the group onto it indefinitely — ignoring elapsed-time
  // cycling and its own time window — until an admin clears the mandatory flag.
  const mandatoryIdx = steps.findIndex(s => s.mandatory === 1 && s.type === 'play' && s.playlist);
  if (mandatoryIdx !== -1) {
    return {
      ...base,
      mode: 'play',
      playlist: steps[mandatoryIdx].playlist,
      mandatory: true,
      stepIndex: mandatoryIdx,
      remainingMs: null,
      totalMs: null
    };
  }

  const totalMs = steps.reduce((sum, s) => sum + s.duration_minutes * 60000, 0);
  if (totalMs <= 0) {
    return { ...base, mode: 'off' };
  }

  const startedAt = group.started_at || Date.now();
  let elapsed = (Date.now() - startedAt) % totalMs;
  if (elapsed < 0) elapsed += totalMs;

  let acc = 0;
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    const durMs = s.duration_minutes * 60000;
    if (elapsed < acc + durMs) {
      const remainingMs = (acc + durMs) - elapsed;
      if (s.type === 'play') {
        if (!_inClockWindow(s.start_time, s.end_time, nowM)) {
          // Outside this step's allowed clock window - sit this turn out.
          return { ...base, mode: 'pause', gated: true, stepIndex: i, remainingMs, totalMs };
        }
        return { ...base, mode: 'play', playlist: s.playlist, mandatory: false, stepIndex: i, remainingMs, totalMs };
      }
      return { ...base, mode: 'pause', stepIndex: i, remainingMs, totalMs };
    }
    acc += durMs;
  }

  // Rounding safety net - treat as the final step's pause.
  return { ...base, mode: 'pause', stepIndex: steps.length - 1, remainingMs: 0, totalMs };
}

async function getRotationGroups() {
  const db = await getDb();
  const groups = await db.all(`SELECT * FROM rotation_groups ORDER BY sort_order ASC, id ASC`);
  const steps = await db.all(`SELECT * FROM rotation_steps ORDER BY group_id ASC, step_order ASC`);
  return groups.map(g => ({
    id: g.id,
    name: g.name,
    enabled: g.enabled === 1,
    started_at: g.started_at || 0,
    steps: steps.filter(s => s.group_id === g.id)
  }));
}

async function createRotationGroup(name) {
  const db = await getDb();
  const row = await db.get(`SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM rotation_groups`);
  const result = await db.run(
    `INSERT INTO rotation_groups (name, enabled, started_at, sort_order) VALUES (?, 0, 0, ?)`,
    [name || 'New Group', row.next]
  );
  return result.lastID;
}

async function renameRotationGroup(groupId, name) {
  const db = await getDb();
  await db.run(`UPDATE rotation_groups SET name = ? WHERE id = ?`, [name, groupId]);
}

async function deleteRotationGroup(groupId) {
  const db = await getDb();
  await db.run(`DELETE FROM rotation_steps WHERE group_id = ?`, [groupId]);
  await db.run(`DELETE FROM rotation_groups WHERE id = ?`, [groupId]);
}

// Replaces a group's whole step sequence and (re)starts its cycle from step 1.
async function setGroupSteps(groupId, steps) {
  const db = await getDb();
  await db.run(`DELETE FROM rotation_steps WHERE group_id = ?`, [groupId]);
  let order = 0;
  let mandatoryClaimed = false;
  for (const step of (steps || [])) {
    const type = step.type === 'pause' ? 'pause' : 'play';
    const minutes = Math.max(1, parseInt(step.duration_minutes) || 0);
    if (!minutes) continue;
    const playlist = type === 'play' ? (step.playlist || '') : null;
    if (type === 'play' && !playlist) continue; // a play step needs a playlist

    const hasWindow = type === 'play' && step.start_time && step.end_time;
    const startTime = hasWindow ? step.start_time : null;
    const endTime = hasWindow ? step.end_time : null;

    // Only one mandatory (repeat-until-disabled) step per group.
    let mandatory = 0;
    if (type === 'play' && step.mandatory && !mandatoryClaimed) {
      mandatory = 1;
      mandatoryClaimed = true;
    }

    await db.run(
      `INSERT INTO rotation_steps (group_id, step_order, type, playlist, duration_minutes, start_time, end_time, mandatory)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [groupId, order, type, playlist, minutes, startTime, endTime, mandatory]
    );
    order++;
  }
  await db.run(`UPDATE rotation_groups SET started_at = ? WHERE id = ?`, [Date.now(), groupId]);
}

async function setGroupEnabled(groupId, enabled) {
  const db = await getDb();
  if (enabled) {
    await db.run(`UPDATE rotation_groups SET enabled = 1, started_at = ? WHERE id = ?`, [Date.now(), groupId]);
  } else {
    await db.run(`UPDATE rotation_groups SET enabled = 0 WHERE id = ?`, [groupId]);
  }
}

async function restartGroupCycle(groupId) {
  const db = await getDb();
  await db.run(`UPDATE rotation_groups SET started_at = ? WHERE id = ?`, [Date.now(), groupId]);
}

// Sets (or clears) a single step's mandatory lock, scoped to its own group -
// takes effect immediately on the next status check, with no cycle reset needed.
async function setStepMandatory(stepId, mandatory) {
  const db = await getDb();
  const step = await db.get(`SELECT * FROM rotation_steps WHERE id = ?`, [stepId]);
  if (!step) return;
  if (mandatory) {
    await db.run(`UPDATE rotation_steps SET mandatory = 0 WHERE group_id = ?`, [step.group_id]);
    await db.run(`UPDATE rotation_steps SET mandatory = 1 WHERE id = ?`, [stepId]);
  } else {
    await db.run(`UPDATE rotation_steps SET mandatory = 0 WHERE id = ?`, [stepId]);
  }
}

// Live status of every group, for the admin UI.
async function getAllGroupStatuses() {
  const groups = await getRotationGroups();
  const now = await getNowInConfiguredTimezone();
  const nowM = now.getHours() * 60 + now.getMinutes();
  return groups.map(g => _computeGroupStatus(g, nowM));
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

async function updateMediaCache(vpath, playlist, filename, title, thumbnail, duration, size_mb, vhash, fileCreatedAt) {
  const db = await getDb();
  await db.run(`
    INSERT OR REPLACE INTO media_cache (vpath, playlist, filename, title, thumbnail, duration, size_mb, vhash, file_created_at, last_seen)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `, [vpath, playlist, filename, title, thumbnail, duration, size_mb, vhash, fileCreatedAt || 0]);
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
    ORDER BY file_created_at ASC, filename ASC
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

async function searchMediaCache(query) {
  const db = await getDb();
  return await db.all(`
    SELECT * FROM media_cache 
    WHERE title LIKE ? OR filename LIKE ?
  `, [`%${query}%`, `%${query}%`]);
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
    const activatedAt = parseInt(s.force_lock_activated_at || '0');
    
    let profileData = {};
    if (profileId) {
      const profile = await getLockProfile(parseInt(profileId));
      if (profile) {
        // Check duration expiry
        if (profile.duration_minutes > 0 && activatedAt > 0) {
          const expiresAt = activatedAt + (profile.duration_minutes * 60 * 1000);
          if (Date.now() >= expiresAt) {
            console.log(`[DB] Force lock profile ${profile.name} expired. Unlocking...`);
            await setSetting('force_sleep', 'false');
            await setSetting('force_lock_profile_id', '');
            await setSetting('force_lock_activated_at', '');
            return false; // Automatically unlock
          }
        }
      
        profileData = {
          message: profile.message ?? s.force_lock_message ?? defaultMsg,
          audio:   profile.audio_url ?? s.force_lock_audio ?? defaultAudio,
          image:   profile.icon_url  ?? s.force_lock_image ?? defaultImage,
        };
      }
    }
    return {
      locked: true,
      message: profileData.message ?? s.force_lock_message ?? defaultMsg,
      audio:   profileData.audio   ?? s.force_lock_audio   ?? defaultAudio,
      image:   profileData.image   ?? s.force_lock_image   ?? defaultImage,
      profile_id: profileId || null,
    };
  }

  const now = await getNowInConfiguredTimezone();
  const nowM = now.getHours() * 60 + now.getMinutes();

  // Free Time overrides ALL sleep/lock schedules
  if (s.free_time_slots) {
    try {
      const freeSlots = JSON.parse(s.free_time_slots);
      if (Array.isArray(freeSlots)) {
        for (const slot of freeSlots) {
          if (!slot.start || isNaN(parseInt(slot.duration))) continue;
          const startM = _parseMins(slot.start);
          const duration = parseInt(slot.duration);
          const endM = (startM + duration) % 1440;
          let inFreeTime = false;
          if (startM < endM) {
            inFreeTime = (nowM >= startM && nowM < endM);
          } else {
            inFreeTime = (nowM >= startM || nowM < endM);
          }
          if (inFreeTime) {
            return false; // System is awake during free time
          }
        }
      }
    } catch (e) {
      console.error('[DB] Failed to parse free_time_slots', e);
    }
  }


  if (s.sleep_slots) {
    try {
      const slots = JSON.parse(s.sleep_slots);
      if (Array.isArray(slots)) {
        if (slots.length === 0) return false;
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

  const startStr = s.sleep_start === undefined ? '22:00' : s.sleep_start;
  const endStr = s.sleep_end === undefined ? '06:00' : s.sleep_end;

  if (startStr === '' || endStr === '' || startStr === 'false') {
    return false; // Sleep mode disabled
  }

  const startM = _parseMins(startStr);
  const endM = _parseMins(endStr);
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

  const schedules = await db.all(`SELECT * FROM schedules`);

  // Inject cached playlists that aren't in schedules yet, so they act as defaults
  const cachedNames = await db.all(`SELECT playlist FROM media_cache GROUP BY playlist`);
  const scheduledNamesSet = new Set(schedules.map(s => s.playlist));
  for (const c of cachedNames) {
    if (c.playlist && !scheduledNamesSet.has(c.playlist)) {
      schedules.push({
        playlist: c.playlist,
        is_blocked: 0,
        min_duration: 0
      });
    }
  }

  const blockedNames = schedules.filter(s => s.is_blocked === 1).map(s => s.playlist);

  const settings = await getSettings();
  if (settings.mandatory_override_until) {
    const overrideUntil = parseInt(settings.mandatory_override_until);
    if (!isNaN(overrideUntil) && Date.now() < overrideUntil) {
      return { mode: 'all', blocked: blockedNames }; // Bypass all schedules, but respect blocks
    }
  }

  // Check for automatic Free Time slots
  if (settings.free_time_slots) {
    try {
      const freeSlots = JSON.parse(settings.free_time_slots);
      if (Array.isArray(freeSlots)) {
        for (const slot of freeSlots) {
          if (slot.start && slot.duration) {
            const startM = _parseMins(slot.start);
            const duration = parseInt(slot.duration);
            if (!isNaN(duration) && duration > 0) {
              const endM = (startM + duration) % 1440;
              let inFreeTime = false;
              if (startM < endM) {
                inFreeTime = (nowM >= startM && nowM < endM);
              } else {
                inFreeTime = (nowM >= startM || nowM < endM); // Wraps around midnight
              }
              if (inFreeTime) {
                return { mode: 'all', blocked: blockedNames }; // Automatic Free Time active
              }
            }
          }
        }
      }
    } catch (e) {
      console.error('[DB] Failed to parse free_time_slots', e);
    }
  }

  // Rotation: every enabled group runs its own ordered play/pause cycle independently.
  // Whatever playlist any enabled group currently wants "on" becomes forced (union across
  // groups); if no enabled group currently wants anything on, fall through to normal scheduling.
  const rotationGroups = await getRotationGroups();
  if (rotationGroups.length > 0) {
    const forced = new Set();
    for (const g of rotationGroups) {
      if (!g.enabled) continue;
      const status = _computeGroupStatus(g, nowM);
      if (status.mode === 'play' && status.playlist) {
        forced.add(status.playlist);
      }
    }
    if (forced.size > 0) {
      const notBlocked = [...forced].filter(p => !blockedNames.some(b => p === b || p.startsWith(b + '/')));
      if (notBlocked.length > 0) {
        return { mode: 'priority', playlists: notBlocked, blocked: blockedNames };
      }
    }
  }

  const activePlaylists = [];
  const minDurationMap = {};

  for (const s of schedules) {
    if (s.is_blocked === 1) continue; // Skip entirely for normal scheduling
    activePlaylists.push(s.playlist);
    minDurationMap[s.playlist] = s.min_duration || 0;
  }

  if (activePlaylists.length === 0) {
    return { mode: 'fallback', playlists: null, blocked: blockedNames };
  }

  const completionRows = await db.all(
    `SELECT playlist, completed, watched_duration FROM daily_playlist_progress WHERE date = ?`,
    [today]
  );

  const completedSet = new Set();
  for (const scheduledPlaylist of activePlaylists) {
    const minDur = minDurationMap[scheduledPlaylist];
    let totalWatched = 0;
    let anyCompleted = false;

    for (const row of completionRows) {
      if (row.playlist && (row.playlist === scheduledPlaylist || row.playlist.startsWith(scheduledPlaylist + '/'))) {
        totalWatched += row.watched_duration;
        if (row.completed === 1) {
          anyCompleted = true;
        }
      }
    }

    if (anyCompleted) {
      completedSet.add(scheduledPlaylist);
    } else if (minDur > 0 && totalWatched >= minDur * 60) {
      completedSet.add(scheduledPlaylist);
    }
  }

  const pending = activePlaylists.filter(p => !completedSet.has(p));

  // If any mandatory (min_duration) schedule is pending, show ONLY those until done
  const pendingMandatory = pending.filter(p => (minDurationMap[p] || 0) > 0);
  if (pendingMandatory.length > 0) {
    return { mode: 'priority', playlists: pendingMandatory, blocked: blockedNames };
  }

  // No mandatory quotas pending - show all content (still respecting blocks)
  return { mode: 'fallback', playlists: null, blocked: blockedNames };
}

async function isPlaylistAllowed(name) {
  const result = await getPlaylistsForDisplay();
  
  if (result.blocked && result.blocked.some(b => name === b || name.startsWith(b + '/'))) {
    return false;
  }

  if (result.mode === 'all') return true;
  if (result.mode === 'priority') {
    return result.playlists.some(p => name === p || name.startsWith(p + '/'));
  }
  if (result.mode === 'fallback') {
    if (result.excludeScheduled) {
      for (const ex of result.excludeScheduled) {
        if (name === ex || name.startsWith(ex + '/')) return false;
      }
    }
    return true;
  }
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

async function upsertLockProfile(id, name, iconUrl, audioUrl, message, durationMinutes) {
  const db = await getDb();
  const duration = parseInt(durationMinutes) || 0;
  if (id) {
    await db.run(
      `UPDATE force_lock_profiles SET name=?, icon_url=?, audio_url=?, message=?, duration_minutes=? WHERE id=?`,
      [name, iconUrl, audioUrl, message, duration, id]
    );
    return id;
  } else {
    const res = await db.run(
      `INSERT INTO force_lock_profiles (name, icon_url, audio_url, message, duration_minutes) VALUES (?, ?, ?, ?, ?)`,
      [name, iconUrl, audioUrl, message, duration]
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
  return row ? row.watch_count : 1;
}

async function addPlaylistProgress(playlist, seconds) {
  if (seconds <= 0) return;
  const db = await getDb();
  const today = new Date().toISOString().slice(0, 10);
  await db.run(`
    INSERT INTO daily_playlist_progress (playlist, date, completed, watched_duration)
    VALUES (?, ?, 0, ?)
    ON CONFLICT(playlist, date) DO UPDATE SET
      watched_duration = watched_duration + ?
  `, [playlist, today, seconds, seconds]);
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

async function clearDailyProgress() {
  const db = await getDb();
  const today = new Date().toISOString().slice(0, 10);
  await db.run(`DELETE FROM daily_playlist_progress WHERE date = ?`, [today]);
  console.log('[DB] Cleared daily_playlist_progress for', today);
}

async function getPlaylistProgress(playlist) {
  const db = await getDb();
  const today = new Date().toISOString().slice(0, 10);
  const rows = await db.all(`SELECT playlist, watched_duration FROM daily_playlist_progress WHERE date = ?`, [today]);
  
  let total = 0;
  for (const r of rows) {
    if (r.playlist && (r.playlist === playlist || r.playlist.startsWith(playlist + '/'))) {
      total += r.watched_duration;
    }
  }
  return total;
}

// --- Acknowledgements ---
async function setPlaylistAcknowledgement(playlist, acknowledged) {
  const db = await getDb();
  await db.run(`
    INSERT OR REPLACE INTO active_acknowledgements (playlist, acknowledged, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
  `, [playlist, acknowledged ? 1 : 0]);
}

async function isPlaylistAcknowledged(playlist) {
  const db = await getDb();
  const row = await db.get(`SELECT acknowledged FROM active_acknowledgements WHERE playlist = ?`, [playlist]);
  return row ? row.acknowledged === 1 : false;
}

async function renamePlaylist(oldName, newName) {
  const db = await getDb();
  await db.run(`UPDATE schedules SET playlist = ? WHERE playlist = ?`, [newName, oldName]);
  await db.run(`UPDATE daily_playlist_progress SET playlist = ? WHERE playlist = ?`, [newName, oldName]);
  await db.run(`UPDATE video_watch_log SET playlist = ? WHERE playlist = ?`, [newName, oldName]);
  await db.run(`UPDATE active_acknowledgements SET playlist = ? WHERE playlist = ?`, [newName, oldName]);
  await db.run(`UPDATE scheduled_downloads SET playlist = ? WHERE playlist = ?`, [newName, oldName]);

  const videos = await db.all(`SELECT vpath FROM media_cache WHERE playlist = ?`, [oldName]);
  for (const v of videos) {
    const rest = v.vpath.substring(oldName.length);
    const newVpath = newName + rest;
    await db.run(`UPDATE media_cache SET playlist = ?, vpath = ? WHERE vpath = ?`, [newName, newVpath, v.vpath]);
  }
}

async function renameVideo(playlist, oldFilename, newFilename, newTitle, newVpath) {
  const db = await getDb();
  await db.run(
    `UPDATE media_cache SET filename = ?, title = ?, vpath = ? WHERE playlist = ? AND filename = ?`,
    [newFilename, newTitle, newVpath, playlist, oldFilename]
  );
}

module.exports = {
  initDb, getSettings, setSetting, getOverlay, setOverlay,
  getSchedules, getSchedule, upsertSchedule, deleteSchedule,
  getScheduledDownloads, createScheduledDownload, updateScheduledDownloadStatus, cancelScheduledDownload,
  updateMediaCache, getCachedPlaylists, getCachedVideos, clearOldCache, searchMediaCache,
  getVideoPathByHash,
  isSystemAsleep, isPlaylistAllowed, getPlaylistsForDisplay,
  getLockProfiles, getLockProfile, upsertLockProfile, deleteLockProfile,
  recordVideoWatch, demoteVideo, getPlaylistWatchLog, resetPlaylistWatchLog, markPlaylistCompleted,
  clearDailyProgress, getPlaylistProgress, addPlaylistProgress,
  getLiveStreams, addLiveStream, deleteLiveStream,
  setPlaylistAcknowledgement, isPlaylistAcknowledged,
  renamePlaylist, renameVideo,
  getRotationGroups, createRotationGroup, renameRotationGroup, deleteRotationGroup,
  setGroupSteps, setGroupEnabled, restartGroupCycle, setStepMandatory, getAllGroupStatuses
};

// --- Live Streams ---
async function getLiveStreams() {
  const db = await getDb();
  return await db.all(`SELECT * FROM live_streams ORDER BY id ASC`);
}

async function addLiveStream(id, title, url, thumbnail) {
  const db = await getDb();
  if (id) {
    await db.run(
      `UPDATE live_streams SET title = ?, url = ?, thumbnail = ? WHERE id = ?`,
      [title, url, thumbnail || '', id]
    );
    return id;
  } else {
    const result = await db.run(
      `INSERT INTO live_streams (title, url, thumbnail) VALUES (?, ?, ?)`,
      [title, url, thumbnail || '']
    );
    return result.lastID;
  }
}

async function deleteLiveStream(id) {
  const db = await getDb();
  await db.run(`DELETE FROM live_streams WHERE id = ?`, [id]);
}
