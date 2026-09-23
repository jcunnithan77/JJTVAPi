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
    CREATE TABLE IF NOT EXISTS playlist_groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS playlist_group_members (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id INTEGER NOT NULL,
      playlist TEXT NOT NULL,
      UNIQUE(group_id, playlist)
    );
    CREATE TABLE IF NOT EXISTS browser_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      domain TEXT NOT NULL,
      thumbnail TEXT,
      group_name TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS browser_approved_domains (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      link_id INTEGER NOT NULL,
      domain TEXT NOT NULL,
      approved_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(link_id, domain)
    );
    CREATE TABLE IF NOT EXISTS browser_approval_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      link_id INTEGER NOT NULL,
      requested_url TEXT NOT NULL,
      requested_domain TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      resolved_at TEXT
    );
    CREATE TABLE IF NOT EXISTS rotation_groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      enabled INTEGER DEFAULT 0,
      started_at INTEGER DEFAULT 0,
      sort_order INTEGER DEFAULT 0,
      day_mode TEXT DEFAULT 'all',
      days TEXT DEFAULT '[]',
      today_date TEXT
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
  // lock_message/lock_audio (from a much older locked-screen concept) are unused and have
  // no UI - clear any leftover values so they can't do anything surprising.
  try { await db.exec(`UPDATE schedules SET lock_message = NULL, lock_audio = NULL`); } catch(e) {}
  // Per-playlist schedule: an active clock-time window (start_time/end_time, reused from the
  // original scheduler) during which the playlist repeatedly cycles play/pause using these two
  // durations. Only takes effect when cycle_play_minutes > 0 - otherwise this playlist is
  // unaffected and start_time/end_time are ignored, exactly like before this feature existed.
  try { await db.exec(`ALTER TABLE schedules ADD COLUMN cycle_play_minutes INTEGER DEFAULT 0`); } catch(e) {}
  try { await db.exec(`ALTER TABLE schedules ADD COLUMN cycle_pause_minutes INTEGER DEFAULT 0`); } catch(e) {}
  // Admin-curated flag: this playlist should appear in the TV app's Music section. Manual
  // rather than automatic (e.g. "every file in it is an audio extension") so the admin has
  // precise control over what shows up there, rather than a heuristic risking false positives.
  try { await db.exec(`ALTER TABLE schedules ADD COLUMN is_audio_playlist INTEGER DEFAULT 0`); } catch(e) {}
  try { await db.exec(`ALTER TABLE daily_playlist_progress ADD COLUMN watched_duration INTEGER DEFAULT 0`); } catch(e) {}
  try { await db.exec(`ALTER TABLE media_cache ADD COLUMN file_created_at INTEGER DEFAULT 0`); } catch(e) {}

  // Rotation: steps now belong to a named, independently enable/disable-able group,
  // and each play step may have an optional clock-time window and a mandatory lock.
  try { await db.exec(`ALTER TABLE rotation_steps ADD COLUMN group_id INTEGER`); } catch(e) {}
  try { await db.exec(`ALTER TABLE rotation_steps ADD COLUMN start_time TEXT`); } catch(e) {}
  try { await db.exec(`ALTER TABLE rotation_steps ADD COLUMN end_time TEXT`); } catch(e) {}
  try { await db.exec(`ALTER TABLE rotation_steps ADD COLUMN mandatory INTEGER DEFAULT 0`); } catch(e) {}
  try { await db.exec(`ALTER TABLE rotation_groups ADD COLUMN day_mode TEXT DEFAULT 'all'`); } catch(e) {}
  try { await db.exec(`ALTER TABLE rotation_groups ADD COLUMN days TEXT DEFAULT '[]'`); } catch(e) {}
  try { await db.exec(`ALTER TABLE rotation_groups ADD COLUMN today_date TEXT`); } catch(e) {}
  try { await db.exec(`ALTER TABLE browser_links ADD COLUMN group_name TEXT`); } catch(e) {}
  // Some sites are mobile/portrait-only and render broken (or blank) on a landscape TV
  // screen; when set, the app renders that link's WebView rotated 90° to compensate.
  try { await db.exec(`ALTER TABLE browser_links ADD COLUMN force_portrait INTEGER DEFAULT 0`); } catch(e) {}
  // A rotation step can target either a single playlist (default, unchanged) or a
  // Playlist Group (all of the group's playlists become available together while active).
  try { await db.exec(`ALTER TABLE rotation_steps ADD COLUMN target_type TEXT DEFAULT 'playlist'`); } catch(e) {}
  try { await db.exec(`ALTER TABLE rotation_steps ADD COLUMN playlist_group_id INTEGER`); } catch(e) {}
  // A group's mode: 'sequential' (default, unchanged) rotates through its steps one at a
  // time using each step's own duration_minutes/pause steps, exactly as before. 'simple'
  // ignores step ordering/duration entirely and instead allows ALL of the group's member
  // playlists at once, optionally cycling the whole group between play/pause as a unit
  // via cycle_play_minutes/cycle_pause_minutes (0 = always-on while enabled, no cycling).
  try { await db.exec(`ALTER TABLE rotation_groups ADD COLUMN mode TEXT DEFAULT 'sequential'`); } catch(e) {}
  try { await db.exec(`ALTER TABLE rotation_groups ADD COLUMN cycle_play_minutes INTEGER DEFAULT 0`); } catch(e) {}
  try { await db.exec(`ALTER TABLE rotation_groups ADD COLUMN cycle_pause_minutes INTEGER DEFAULT 0`); } catch(e) {}
  // Per-pause background playlist: a 'pause' step (sequential mode) or a whole group's pause
  // phase (simple mode) can pick a playlist whose audio loops for that specific pause,
  // overriding the global Settings -> Pause-Time Background Music default just for it.
  try { await db.exec(`ALTER TABLE rotation_steps ADD COLUMN pause_playlist TEXT`); } catch(e) {}
  try { await db.exec(`ALTER TABLE rotation_groups ADD COLUMN pause_playlist TEXT`); } catch(e) {}
  // Daily active-hours window for a whole group (independent of day_mode's day-of-week
  // scope) - outside it the group is simply off, same as a wrong day. Deliberately no SQL
  // DEFAULT here so pre-existing groups stay unrestricted (24h) after this migration;
  // createRotationGroup() sets 08:00-22:00 explicitly for newly created groups only.
  try { await db.exec(`ALTER TABLE rotation_groups ADD COLUMN start_time TEXT`); } catch(e) {}
  try { await db.exec(`ALTER TABLE rotation_groups ADD COLUMN end_time TEXT`); } catch(e) {}
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

  // Custom TV-app menus (a generalization of the Music section): an admin-named, admin-
  // enabled nav entry with its own manually-assigned playlists and an optional bound
  // Rotation Group whose play/pause status locks ONLY that menu - independent of every
  // other menu and of the old whole-app lock, so e.g. a video rotation's mandatory break
  // doesn't also interrupt a Music-style menu that isn't part of it.
  await db.exec(`
    CREATE TABLE IF NOT EXISTS menus (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      icon TEXT DEFAULT '📁',
      enabled INTEGER DEFAULT 1,
      rotation_group_id INTEGER,
      sort_order INTEGER DEFAULT 0
    )
  `);
  await db.exec(`
    CREATE TABLE IF NOT EXISTS menu_playlists (
      menu_id INTEGER NOT NULL,
      playlist TEXT NOT NULL,
      PRIMARY KEY (menu_id, playlist)
    )
  `);

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
  // Only normalize actual boolean flags (compared elsewhere as === 'true'/'false') - lowercasing
  // every setting unconditionally also mangled free text like lock/sleep messages and, worse,
  // playlist names (e.g. pause_lock_playlist), which are looked up with a case-sensitive exact
  // match against the real folder name and would silently fail to find any videos once lowercased.
  const str = String(value);
  const lower = str.toLowerCase();
  const storedValue = (lower === 'true' || lower === 'false') ? lower : str;
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

async function upsertSchedule(playlist, priority, minDuration, watchLimit, mandatoryView, isBlocked, reqAck, minRepeat, maxRepeat, startTime, endTime, cyclePlayMinutes, cyclePauseMinutes, isAudioPlaylist) {
  const db = await getDb();
  // A play/pause cycle only takes effect when both a window and cyclePlayMinutes are set;
  // otherwise this playlist behaves exactly as if the feature didn't exist.
  const hasWindow = !!(startTime && endTime);
  const hasCycle = hasWindow && cyclePlayMinutes > 0;
  await db.run(
    `INSERT OR REPLACE INTO schedules (playlist, priority, min_duration, watch_limit, mandatory_view, is_blocked, req_ack, min_repeat, max_repeat, start_time, end_time, cycle_play_minutes, cycle_pause_minutes, is_audio_playlist)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      playlist, priority || 0, minDuration || 0, watchLimit || 3, mandatoryView || 0, isBlocked || 0, reqAck || 0, minRepeat || 1, maxRepeat || 3,
      hasWindow ? startTime : null,
      hasWindow ? endTime : null,
      hasCycle ? cyclePlayMinutes : 0,
      hasCycle ? (cyclePauseMinutes || 0) : 0,
      isAudioPlaylist ? 1 : 0
    ]
  );
}

async function deleteSchedule(playlist) {
  const db = await getDb();
  await db.run(`DELETE FROM schedules WHERE playlist = ?`, [playlist]);
}

// --- Playlist Groups (created in Media Manager; selectable as a single Rotation step target) ---

async function getPlaylistGroups() {
  const db = await getDb();
  const groups = await db.all(`SELECT * FROM playlist_groups ORDER BY name ASC`);
  const members = await db.all(`SELECT * FROM playlist_group_members ORDER BY group_id ASC, playlist ASC`);
  return groups.map(g => ({
    id: g.id,
    name: g.name,
    playlists: members.filter(m => m.group_id === g.id).map(m => m.playlist)
  }));
}

async function createPlaylistGroup(name) {
  const db = await getDb();
  const result = await db.run(`INSERT INTO playlist_groups (name) VALUES (?)`, [name]);
  return result.lastID;
}

async function renamePlaylistGroup(groupId, name) {
  const db = await getDb();
  await db.run(`UPDATE playlist_groups SET name = ? WHERE id = ?`, [name, groupId]);
}

async function deletePlaylistGroup(groupId) {
  const db = await getDb();
  await db.run(`DELETE FROM playlist_group_members WHERE group_id = ?`, [groupId]);
  await db.run(`DELETE FROM playlist_groups WHERE id = ?`, [groupId]);
  // Any rotation steps pointing at this group fall back to "no playlists" until re-pointed.
  await db.run(`UPDATE rotation_steps SET playlist_group_id = NULL WHERE playlist_group_id = ?`, [groupId]);
}

async function setPlaylistGroupMembers(groupId, playlists) {
  const db = await getDb();
  await db.run(`DELETE FROM playlist_group_members WHERE group_id = ?`, [groupId]);
  const clean = Array.isArray(playlists) ? [...new Set(playlists.filter(p => typeof p === 'string' && p))] : [];
  for (const p of clean) {
    await db.run(`INSERT OR IGNORE INTO playlist_group_members (group_id, playlist) VALUES (?, ?)`, [groupId, p]);
  }
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

// True if `group` is in its day-scope today: 'all' (always), 'specific' (today's
// weekday is in its days list), or 'today' (a self-expiring one-off - only true on
// the exact calendar date it was set, in the configured timezone).
function _isGroupActiveToday(group, now) {
  const mode = group.day_mode || 'all';
  if (mode === 'today') {
    return group.today_date === _dateStr(now);
  }
  if (mode === 'specific') {
    const days = group.days || [];
    return days.includes(now.getDay()); // 0=Sun .. 6=Sat
  }
  return true; // 'all'
}

function _dateStr(now) {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// Resolves what a 'play' step actually unlocks: a single playlist, or (when it targets a
// Playlist Group) every playlist currently in that group. `groupPlaylistsById` maps
// playlist_group_id -> string[] of playlists, from getPlaylistGroups().
function _stepPlaylists(step, groupPlaylistsById) {
  if (step.target_type === 'group' && step.playlist_group_id != null) {
    return (groupPlaylistsById && groupPlaylistsById.get(step.playlist_group_id)) || [];
  }
  return step.playlist ? [step.playlist] : [];
}

// Pure computation of a single group's current state — no DB access, so it can be
// reused for both the live scheduling decision and the admin status display without
// re-querying. `now` = current Date (configured timezone); `nowM` = minutes since
// local midnight, for each step's optional time window; `groupPlaylistsById` resolves
// any step that targets a Playlist Group rather than a single playlist.
function _computeGroupStatus(group, now, nowM, groupPlaylistsById) {
  const steps = group.steps || [];
  const base = { groupId: group.id, name: group.name, enabled: group.enabled, steps, dayMode: group.day_mode || 'all', days: group.days || [], todayDate: group.today_date || null, groupMode: group.mode || 'sequential', startTime: group.start_time || null, endTime: group.end_time || null };

  if (!_isGroupActiveToday(group, now)) {
    return { ...base, mode: 'off', reason: 'wrong-day' };
  }

  // Daily active-hours window, independent of (and in addition to) the day-of-week scope
  // above - a group with no window set (start_time/end_time both null) is unrestricted, same
  // as before this feature existed.
  if (!_inClockWindow(group.start_time, group.end_time, nowM)) {
    return { ...base, mode: 'off', reason: 'outside-window' };
  }

  if (!group.enabled || steps.length === 0) {
    return { ...base, mode: 'off' };
  }

  if (group.mode === 'simple') {
    return _computeSimpleGroupStatus(group, base, steps, groupPlaylistsById);
  }

  // A mandatory step locks the group onto it indefinitely — ignoring elapsed-time
  // cycling and its own time window — until an admin clears the mandatory flag.
  const mandatoryIdx = steps.findIndex(s => s.mandatory === 1 && s.type === 'play' && _stepPlaylists(s, groupPlaylistsById).length > 0);
  if (mandatoryIdx !== -1) {
    const playlists = _stepPlaylists(steps[mandatoryIdx], groupPlaylistsById);
    return {
      ...base,
      mode: 'play',
      playlists,
      playlist: playlists[0] || null,
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
          return { ...base, mode: 'pause', gated: true, stepIndex: i, remainingMs, totalMs, pausePlaylist: null };
        }
        const playlists = _stepPlaylists(s, groupPlaylistsById);
        return { ...base, mode: 'play', playlists, playlist: playlists[0] || null, mandatory: false, stepIndex: i, remainingMs, totalMs };
      }
      return { ...base, mode: 'pause', stepIndex: i, remainingMs, totalMs, pausePlaylist: s.pause_playlist || null };
    }
    acc += durMs;
  }

  // Rounding safety net - treat as the final step's pause.
  return { ...base, mode: 'pause', stepIndex: steps.length - 1, remainingMs: 0, totalMs, pausePlaylist: steps[steps.length - 1]?.pause_playlist || null };
}

// 'simple' mode: no per-step ordering/duration - every member playlist (steps targeting a
// single playlist or a Playlist Group, flattened and de-duped) is allowed together as one
// unit, optionally cycling the whole group between play/pause via cycle_play_minutes /
// cycle_pause_minutes rather than each step timing itself individually.
function _computeSimpleGroupStatus(group, base, steps, groupPlaylistsById) {
  const allPlaylists = [...new Set(steps.flatMap(s => _stepPlaylists(s, groupPlaylistsById)))];
  if (allPlaylists.length === 0) {
    return { ...base, mode: 'off' };
  }

  const playMinutes = group.cycle_play_minutes || 0;
  if (playMinutes <= 0) {
    // No cycle configured - simply on for as long as the group is enabled.
    return { ...base, mode: 'play', playlists: allPlaylists, playlist: allPlaylists[0], mandatory: false, remainingMs: null, totalMs: null };
  }

  const playMs = playMinutes * 60000;
  const pauseMs = (group.cycle_pause_minutes || 0) * 60000;
  const totalMs = playMs + pauseMs;
  const startedAt = group.started_at || Date.now();
  let elapsed = (Date.now() - startedAt) % totalMs;
  if (elapsed < 0) elapsed += totalMs;

  if (elapsed < playMs) {
    return { ...base, mode: 'play', playlists: allPlaylists, playlist: allPlaylists[0], mandatory: false, remainingMs: playMs - elapsed, totalMs };
  }
  return { ...base, mode: 'pause', remainingMs: totalMs - elapsed, totalMs, pausePlaylist: group.pause_playlist || null };
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
    day_mode: g.day_mode || 'all',
    days: _parseDays(g.days),
    today_date: g.today_date || null,
    mode: g.mode === 'simple' ? 'simple' : 'sequential',
    cycle_play_minutes: g.cycle_play_minutes || 0,
    cycle_pause_minutes: g.cycle_pause_minutes || 0,
    pause_playlist: g.pause_playlist || null,
    start_time: g.start_time || null,
    end_time: g.end_time || null,
    steps: steps.filter(s => s.group_id === g.id)
  }));
}

function _parseDays(raw) {
  try {
    const arr = JSON.parse(raw || '[]');
    return Array.isArray(arr) ? arr.filter(n => Number.isInteger(n) && n >= 0 && n <= 6) : [];
  } catch (e) {
    return [];
  }
}

// Sets a group's day-of-week scope. mode: 'all' (always active), 'specific' (only on
// the given weekdays, 0=Sun..6=Sat), or 'today' (a self-expiring one-off for the
// current calendar date - naturally stops applying once the date moves on).
async function setGroupSchedule(groupId, dayMode, days) {
  const db = await getDb();
  const mode = ['all', 'specific', 'today'].includes(dayMode) ? dayMode : 'all';
  let daysJson = '[]';
  let todayDate = null;
  if (mode === 'specific') {
    const clean = Array.isArray(days) ? [...new Set(days.map(n => parseInt(n)).filter(n => Number.isInteger(n) && n >= 0 && n <= 6))] : [];
    daysJson = JSON.stringify(clean);
  } else if (mode === 'today') {
    const now = await getNowInConfiguredTimezone();
    todayDate = _dateStr(now);
  }
  await db.run(
    `UPDATE rotation_groups SET day_mode = ?, days = ?, today_date = ? WHERE id = ?`,
    [mode, daysJson, todayDate, groupId]
  );
}

async function createRotationGroup(name) {
  const db = await getDb();
  const row = await db.get(`SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM rotation_groups`);
  // New groups default to an 8am-10pm active window (adjustable/clearable afterward) -
  // pre-existing groups from before this feature stay unrestricted (see the migration above).
  const result = await db.run(
    `INSERT INTO rotation_groups (name, enabled, started_at, sort_order, start_time, end_time) VALUES (?, 0, 0, ?, '08:00', '22:00')`,
    [name || 'New Group', row.next]
  );
  return result.lastID;
}

// Sets (or clears, passing '') the group's daily active-hours window.
async function setGroupWindow(groupId, startTime, endTime) {
  const db = await getDb();
  const start = startTime && startTime.trim() ? startTime.trim() : null;
  const end = endTime && endTime.trim() ? endTime.trim() : null;
  await db.run(`UPDATE rotation_groups SET start_time = ?, end_time = ? WHERE id = ?`, [start, end, groupId]);
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

    const targetsGroup = type === 'play' && step.target_type === 'group';
    const playlist = type === 'play' && !targetsGroup ? (step.playlist || '') : null;
    const playlistGroupId = targetsGroup ? parseInt(step.playlist_group_id) : null;
    if (type === 'play' && !targetsGroup && !playlist) continue; // a playlist step needs a playlist
    if (type === 'play' && targetsGroup && !playlistGroupId) continue; // a group step needs a group

    const hasWindow = type === 'play' && step.start_time && step.end_time;
    const startTime = hasWindow ? step.start_time : null;
    const endTime = hasWindow ? step.end_time : null;

    // Only one mandatory (repeat-until-disabled) step per group.
    let mandatory = 0;
    if (type === 'play' && step.mandatory && !mandatoryClaimed) {
      mandatory = 1;
      mandatoryClaimed = true;
    }

    // A pause step can override the global Settings background playlist just for itself.
    const pausePlaylist = type === 'pause' && step.pause_playlist ? step.pause_playlist : null;

    await db.run(
      `INSERT INTO rotation_steps (group_id, step_order, type, playlist, duration_minutes, start_time, end_time, mandatory, target_type, playlist_group_id, pause_playlist)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [groupId, order, type, playlist, minutes, startTime, endTime, mandatory, targetsGroup ? 'group' : 'playlist', playlistGroupId, pausePlaylist]
    );
    order++;
  }
  await db.run(`UPDATE rotation_groups SET started_at = ? WHERE id = ?`, [Date.now(), groupId]);
}

async function setGroupMode(groupId, mode) {
  const db = await getDb();
  const clean = mode === 'simple' ? 'simple' : 'sequential';
  await db.run(`UPDATE rotation_groups SET mode = ? WHERE id = ?`, [clean, groupId]);
}

async function setGroupCycle(groupId, playMinutes, pauseMinutes) {
  const db = await getDb();
  const play = Math.max(0, parseInt(playMinutes) || 0);
  const pause = Math.max(0, parseInt(pauseMinutes) || 0);
  await db.run(`UPDATE rotation_groups SET cycle_play_minutes = ?, cycle_pause_minutes = ? WHERE id = ?`, [play, pause, groupId]);
}

// Only meaningful for a 'simple' mode group's own pause phase - overrides the global
// Settings background playlist just for this group's pauses. Pass '' to clear the override.
async function setGroupPausePlaylist(groupId, playlist) {
  const db = await getDb();
  await db.run(`UPDATE rotation_groups SET pause_playlist = ? WHERE id = ?`, [playlist || null, groupId]);
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
  const groupPlaylistsById = await _playlistGroupLookup();
  return groups.map(g => _computeGroupStatus(g, now, nowM, groupPlaylistsById));
}

async function _playlistGroupLookup() {
  const groups = await getPlaylistGroups();
  return new Map(groups.map(g => [g.id, g.playlists]));
}

// --- Browser Links (admin-curated kiosk-mode web links, with a per-link ---
// --- domain allowlist and an admin-approval queue for anything outside it) ---

function _normalizeDomain(hostname) {
  return (hostname || '').toLowerCase().replace(/^www\./, '');
}

function _domainOf(url) {
  try {
    return _normalizeDomain(new URL(url).hostname);
  } catch (e) {
    return '';
  }
}

async function getBrowserLinks() {
  const db = await getDb();
  return await db.all(`SELECT * FROM browser_links ORDER BY id ASC`);
}

async function getBrowserLink(linkId) {
  const db = await getDb();
  const link = await db.get(`SELECT * FROM browser_links WHERE id = ?`, [linkId]);
  if (!link) return null;
  const domains = await db.all(`SELECT domain FROM browser_approved_domains WHERE link_id = ?`, [linkId]);
  return { ...link, approvedDomains: domains.map(d => d.domain) };
}

async function createBrowserLink(name, url, thumbnail, groupName, forcePortrait) {
  const db = await getDb();
  const domain = _domainOf(url);
  if (!domain) throw new Error('Invalid URL');
  const result = await db.run(
    `INSERT INTO browser_links (name, url, domain, thumbnail, group_name, force_portrait) VALUES (?, ?, ?, ?, ?, ?)`,
    [name, url, domain, thumbnail || null, groupName || null, forcePortrait ? 1 : 0]
  );
  await db.run(
    `INSERT OR IGNORE INTO browser_approved_domains (link_id, domain) VALUES (?, ?)`,
    [result.lastID, domain]
  );
  return result.lastID;
}

async function setBrowserLinkPortrait(linkId, forcePortrait) {
  const db = await getDb();
  await db.run(`UPDATE browser_links SET force_portrait = ? WHERE id = ?`, [forcePortrait ? 1 : 0, linkId]);
}

async function deleteBrowserLink(linkId) {
  const db = await getDb();
  await db.run(`DELETE FROM browser_approved_domains WHERE link_id = ?`, [linkId]);
  await db.run(`DELETE FROM browser_approval_requests WHERE link_id = ?`, [linkId]);
  await db.run(`DELETE FROM browser_links WHERE id = ?`, [linkId]);
}

// Checks whether `url` is already allowed for this link; if not, files (or reuses) a
// pending approval request for an admin to review. Auto-resume relies on the caller
// polling getApprovalStatus() with the returned requestId once denied/pending.
async function checkOrRequestApproval(linkId, url) {
  const db = await getDb();
  const domain = _domainOf(url);
  if (!domain) return { allowed: false, error: 'Invalid URL' };

  const approved = await db.get(
    `SELECT 1 FROM browser_approved_domains WHERE link_id = ? AND domain = ?`,
    [linkId, domain]
  );
  if (approved) return { allowed: true };

  const existing = await db.get(
    `SELECT id FROM browser_approval_requests WHERE link_id = ? AND requested_domain = ? AND status = 'pending'`,
    [linkId, domain]
  );
  if (existing) return { allowed: false, requestId: existing.id };

  const result = await db.run(
    `INSERT INTO browser_approval_requests (link_id, requested_url, requested_domain) VALUES (?, ?, ?)`,
    [linkId, url, domain]
  );
  return { allowed: false, requestId: result.lastID };
}

async function getApprovalStatus(requestId) {
  const db = await getDb();
  const row = await db.get(`SELECT * FROM browser_approval_requests WHERE id = ?`, [requestId]);
  if (!row) return { status: 'not_found' };
  return { status: row.status, requestedUrl: row.requested_url, requestedDomain: row.requested_domain };
}

async function getPendingApprovals() {
  const db = await getDb();
  return await db.all(`
    SELECT r.*, l.name AS link_name
    FROM browser_approval_requests r
    JOIN browser_links l ON l.id = r.link_id
    WHERE r.status = 'pending'
    ORDER BY r.created_at ASC
  `);
}

async function resolveApproval(requestId, approve) {
  const db = await getDb();
  const row = await db.get(`SELECT * FROM browser_approval_requests WHERE id = ?`, [requestId]);
  if (!row) return false;
  await db.run(
    `UPDATE browser_approval_requests SET status = ?, resolved_at = CURRENT_TIMESTAMP WHERE id = ?`,
    [approve ? 'approved' : 'denied', requestId]
  );
  if (approve) {
    await db.run(
      `INSERT OR IGNORE INTO browser_approved_domains (link_id, domain) VALUES (?, ?)`,
      [row.link_id, row.requested_domain]
    );
  }
  return true;
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

const AUDIO_ONLY_EXTENSIONS = new Set(['.mp3', '.m4a', '.aac', '.opus', '.ogg', '.flac', '.wav']);

// Playlists the admin has explicitly marked as audio (Media Manager's "🎵 Audio playlist"
// toggle) - used for both the TV app's Music section and the pause-lock background music
// picker. Deliberately manual rather than an automatic "every file in it is an audio
// extension" heuristic: that guessed wrong often enough (e.g. a playlist folder that
// coincidentally only had audio files cached so far, but isn't meant to be a music playlist)
// that admin control is more reliable.
async function getAudioOnlyPlaylists() {
  const db = await getDb();
  const rows = await db.all(`SELECT playlist FROM schedules WHERE is_audio_playlist = 1 ORDER BY playlist ASC`);
  return rows.map(r => r.playlist);
}

// Best-effort suggestion only (every cached file in the playlist has an audio extension) -
// used solely to pre-check the Media Manager toggle for playlists that look like an obvious
// fit, saving the admin from having to hunt every one down manually. Never used to decide
// what actually shows in the Music section - see getAudioOnlyPlaylists() above for that.
async function suggestAudioOnlyPlaylists() {
  const db = await getDb();
  const rows = await db.all(`SELECT playlist, filename FROM media_cache ORDER BY playlist ASC`);
  const byPlaylist = new Map();
  for (const r of rows) {
    if (!byPlaylist.has(r.playlist)) byPlaylist.set(r.playlist, []);
    byPlaylist.get(r.playlist).push(r.filename);
  }
  const result = [];
  for (const [playlist, filenames] of byPlaylist) {
    if (filenames.length === 0) continue;
    const allAudio = filenames.every(f => {
      const dot = f.lastIndexOf('.');
      const ext = dot >= 0 ? f.slice(dot).toLowerCase() : '';
      return AUDIO_ONLY_EXTENSIONS.has(ext);
    });
    if (allAudio) result.push(playlist);
  }
  return result;
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

  // Two independent sources can force a playlist "on": Rotation Groups (each running its
  // own ordered play/pause cycle) and a playlist's own scheduled window+cycle (set directly
  // on the playlist in Media Manager). Whatever any of them currently wants on is unioned
  // together; if nothing does, fall through to normal scheduling below. `anyPausing` tracks
  // whether at least one of these sources is specifically in its pause phase right now (as
  // opposed to simply not being configured at all) - isSystemAsleep() uses that to show a
  // full-screen pause message instead of silently falling back to open browsing.
  const forced = new Set();
  let anyPausing = false;
  // The specific pause's chosen background playlist, if any (a pause step or a simple-mode
  // group's own pause_playlist) - overrides the global Settings default just for that pause.
  // If multiple pauses happen to overlap with different overrides, the first one found wins;
  // an edge case not worth resolving more precisely.
  let pausingPlaylist = null;
  // Countdown to the app's own top-bar clock: however many ms remain until whichever cycle
  // is currently playing switches to its pause phase, or until the current pause switches
  // back to play - null when nothing cycling is active (e.g. a non-cycling schedule, or nothing
  // configured at all), same "first one found wins" caveat as pausingPlaylist above.
  let nextPauseMs = null;
  let pausingRemainingMs = null;

  const rotationGroups = await getRotationGroups();
  if (rotationGroups.length > 0) {
    const groupPlaylistsById = await _playlistGroupLookup();
    for (const g of rotationGroups) {
      if (!g.enabled) continue;
      const status = _computeGroupStatus(g, now, nowM, groupPlaylistsById);
      if (status.mode === 'play') {
        for (const p of (status.playlists || [])) forced.add(p);
        if (nextPauseMs === null && status.remainingMs != null) nextPauseMs = status.remainingMs;
      } else if (status.mode === 'pause') {
        anyPausing = true;
        if (!pausingPlaylist && status.pausePlaylist) pausingPlaylist = status.pausePlaylist;
        if (pausingRemainingMs === null && status.remainingMs != null) pausingRemainingMs = status.remainingMs;
      }
    }
  }

  // Per-playlist scheduled window+cycle: only playlists with cycle_play_minutes > 0 (set via
  // the schedule form) participate - everything else is completely unaffected by this.
  for (const s of schedules) {
    if (s.is_blocked === 1) continue;
    if (!s.cycle_play_minutes || s.cycle_play_minutes <= 0) continue;
    if (!s.start_time || !s.end_time) continue;
    if (!_inClockWindow(s.start_time, s.end_time, nowM)) continue;

    const startM = _parseMins(s.start_time);
    let minutesSinceStart = nowM - startM;
    if (minutesSinceStart < 0) minutesSinceStart += 1440; // window wraps past midnight
    const cycleLen = s.cycle_play_minutes + (s.cycle_pause_minutes || 0);
    const posInCycle = cycleLen > 0 ? (minutesSinceStart % cycleLen) : 0;
    if (posInCycle < s.cycle_play_minutes) {
      forced.add(s.playlist);
      const remaining = (s.cycle_play_minutes - posInCycle) * 60000;
      if (nextPauseMs === null || remaining < nextPauseMs) nextPauseMs = remaining;
    } else {
      // Currently in this playlist's own pause phase.
      anyPausing = true;
      const remaining = (cycleLen - posInCycle) * 60000;
      if (pausingRemainingMs === null || remaining < pausingRemainingMs) pausingRemainingMs = remaining;
    }
  }

  const activePlaylists = [];
  const minDurationMap = {};

  for (const s of schedules) {
    if (s.is_blocked === 1) continue; // Skip entirely for normal scheduling
    activePlaylists.push(s.playlist);
    minDurationMap[s.playlist] = s.min_duration || 0;
  }

  // Computed up front (rather than only in the non-forced path below) so a playlist's own
  // daily quota is still honored even when a Rotation Group is also forcing it "on" - a
  // playlist being a group member shouldn't let the group override that playlist's own
  // schedule settings once they're already satisfied for the day.
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

  if (forced.size > 0) {
    const eligible = [...forced].filter(p => {
      if (blockedNames.some(b => p === b || p.startsWith(b + '/'))) return false;
      // Only a playlist with its own quota configured can be "done for the day" - one with
      // none set has nothing of its own to obey, so the group's forcing still applies.
      if ((minDurationMap[p] || 0) > 0 && completedSet.has(p)) return false;
      return true;
    });
    if (eligible.length > 0) {
      return { mode: 'priority', playlists: eligible, blocked: blockedNames, nextPauseMs };
    }
    // Every forced playlist already met its own daily quota - fall through to normal
    // scheduling below instead of force-repeating content the playlist's own settings
    // say is done for today.
  }

  if (activePlaylists.length === 0) {
    return { mode: 'fallback', playlists: null, blocked: blockedNames, pausing: anyPausing, pausingPlaylist, pausingRemainingMs };
  }

  const pending = activePlaylists.filter(p => !completedSet.has(p));

  // If any mandatory (min_duration) schedule is pending, show ONLY those until done
  const pendingMandatory = pending.filter(p => (minDurationMap[p] || 0) > 0);
  if (pendingMandatory.length > 0) {
    return { mode: 'priority', playlists: pendingMandatory, blocked: blockedNames };
  }

  // No mandatory quotas pending - show all content (still respecting blocks)
  return { mode: 'fallback', playlists: null, blocked: blockedNames, pausing: anyPausing, pausingPlaylist, pausingRemainingMs };
}

const PAUSE_MESSAGES = [
  '📚 Study Time!',
  '🧸 Play Time!',
  '🌳 Outside Time!',
  '🎨 Creative Time!',
  '🍎 Snack Time!',
  '😴 Break Time!'
];

// A schedule or Rotation group can be actively in its own pause phase (as opposed to just
// not being configured at all) - when that's the only thing going on right now, the whole
// screen locks with a friendly break message, the same way bedtime already does. Kept
// separate from isSystemAsleep() (rather than folded into it) since that function has
// several early-return branches this shouldn't have to thread through, and because bedtime
// should always win if both are somehow true at once - callers check isSystemAsleep() first.
// How long each pause message/emoji stays up before rotating to the next one.
const PAUSE_MESSAGE_ROTATE_MS = 12000;

function _currentPauseMessage() {
  // Picking randomly on every poll (the TV app polls status every 5s) meant the message
  // could re-roll to something new - or flicker back to the same one - on every single poll,
  // instead of holding steady and then rotating. Deriving the index from the current time
  // instead makes it hold for a fixed window and cycle through all of them in order.
  return PAUSE_MESSAGES[Math.floor(Date.now() / PAUSE_MESSAGE_ROTATE_MS) % PAUSE_MESSAGES.length];
}

// Admin can pick an existing playlist (or several) to keep playing in the background - just
// the audio, since the lock screen itself covers the video - for as long as a pause lasts.
// `override` is a single-playlist pause/group-specific value that takes precedence over the
// global Settings default when set. Either can be a JSON array (multi-select) or an older
// plain-string value (pre-multi-select, treated as a single-item selection).
async function _resolvePauseAudioPlaylist(override, globalDefault) {
  const playlistSetting = override || globalDefault || '';
  let playlistNames = [];
  if (playlistSetting) {
    try {
      const parsed = JSON.parse(playlistSetting);
      playlistNames = Array.isArray(parsed) ? parsed : [playlistSetting];
    } catch (e) {
      playlistNames = [playlistSetting];
    }
  }
  const audioPlaylist = [];
  for (const name of playlistNames) {
    if (!name) continue;
    const videos = await getCachedVideos(name);
    // Titled (not just bare URLs) so the pause screen can show a real track list to pick
    // from, rather than just auto-looping blindly through the whole playlist.
    audioPlaylist.push(...videos.map(v => ({ title: v.title || v.filename, url: `/stream/hash/${v.vhash}` })));
  }
  return audioPlaylist;
}

async function getPauseLockStatus() {
  const display = await getPlaylistsForDisplay();
  if (!display.pausing) return false;
  const settings = await getSettings();
  const audioPlaylist = await _resolvePauseAudioPlaylist(display.pausingPlaylist, settings.pause_lock_playlist);
  return { locked: true, message: _currentPauseMessage(), audio: '', image: '', audioPlaylist, remainingMs: display.pausingRemainingMs };
}

// Per-menu lock status: a menu with no bound Rotation Group is never locked by this
// mechanism at all - it's just a plain playlist listing. A bound group's own play/pause
// cycle governs ONLY this menu, independent of every other menu and of the old whole-app
// pause lock, so unrelated content (e.g. a video rotation's mandatory break) never bleeds
// into a menu that isn't part of that group.
async function getMenuLockStatus(menuId) {
  const db = await getDb();
  const menu = await db.get(`SELECT * FROM menus WHERE id = ?`, [menuId]);
  if (!menu || !menu.rotation_group_id) return { locked: false };

  const groups = await getRotationGroups();
  const group = groups.find(g => g.id === menu.rotation_group_id);
  if (!group) return { locked: false };

  const now = await getNowInConfiguredTimezone();
  const nowM = now.getHours() * 60 + now.getMinutes();
  const groupPlaylistsById = await _playlistGroupLookup();
  const status = _computeGroupStatus(group, now, nowM, groupPlaylistsById);
  if (status.mode !== 'pause') return { locked: false };

  const settings = await getSettings();
  const audioPlaylist = await _resolvePauseAudioPlaylist(status.pausePlaylist, settings.pause_lock_playlist);
  return { locked: true, message: _currentPauseMessage(), audioPlaylist, remainingMs: status.remainingMs };
}

// A fresh menu's default icon, before the admin picks their own - random rather than always
// the same folder icon, so a row of newly created menus is visually distinguishable at a
// glance in both the admin panel and the TV app's nav row.
const MENU_ICON_CHOICES = ['🎬', '🎵', '📚', '🎨', '🧩', '🎮', '🌟', '🚀', '🦄', '🐻', '🍿', '🎈', '🏆', '🎯', '🌈', '🦖'];

async function createMenu(name, icon) {
  const db = await getDb();
  const row = await db.get(`SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM menus`);
  const chosenIcon = icon || MENU_ICON_CHOICES[Math.floor(Math.random() * MENU_ICON_CHOICES.length)];
  const res = await db.run(
    `INSERT INTO menus (name, icon, enabled, sort_order) VALUES (?, ?, 1, ?)`,
    [name, chosenIcon, row.n]
  );
  return res.lastID;
}

async function getMenus() {
  const db = await getDb();
  const menus = await db.all(`SELECT * FROM menus ORDER BY sort_order ASC, id ASC`);
  const playlistRows = await db.all(`SELECT menu_id, playlist FROM menu_playlists`);
  // A menu bound to a Rotation Group pulls its playlists automatically from that group's
  // steps - no manual per-playlist selection needed, and it stays in sync as the group's
  // steps change. manualPlaylists (the raw menu_playlists rows) is preserved separately so
  // nothing is lost if the admin later unbinds the group and goes back to hand-picking.
  const rotationGroups = await getRotationGroups();
  const groupPlaylistsById = await _playlistGroupLookup();
  for (const m of menus) {
    const manualPlaylists = playlistRows.filter(p => p.menu_id === m.id).map(p => p.playlist);
    m.manualPlaylists = manualPlaylists;
    if (m.rotation_group_id) {
      const group = rotationGroups.find(g => g.id === m.rotation_group_id);
      m.playlists = group
        ? [...new Set((group.steps || []).flatMap(s => _stepPlaylists(s, groupPlaylistsById)))]
        : manualPlaylists;
    } else {
      m.playlists = manualPlaylists;
    }
  }
  return menus;
}

async function updateMenu(id, { name, icon, enabled, rotation_group_id }) {
  const db = await getDb();
  await db.run(
    `UPDATE menus SET name = ?, icon = ?, enabled = ?, rotation_group_id = ? WHERE id = ?`,
    [name, icon || '📁', enabled ? 1 : 0, rotation_group_id || null, id]
  );
}

async function setMenuPlaylists(menuId, playlists) {
  const db = await getDb();
  await db.run(`DELETE FROM menu_playlists WHERE menu_id = ?`, [menuId]);
  for (const p of playlists) {
    if (!p) continue;
    await db.run(`INSERT OR IGNORE INTO menu_playlists (menu_id, playlist) VALUES (?, ?)`, [menuId, p]);
  }
}

async function deleteMenu(id) {
  const db = await getDb();
  await db.run(`DELETE FROM menu_playlists WHERE menu_id = ?`, [id]);
  await db.run(`DELETE FROM menus WHERE id = ?`, [id]);
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
  updateMediaCache, getCachedPlaylists, getCachedVideos, getAudioOnlyPlaylists, suggestAudioOnlyPlaylists, clearOldCache, searchMediaCache,
  getVideoPathByHash,
  isSystemAsleep, isPlaylistAllowed, getPlaylistsForDisplay, getPauseLockStatus,
  getMenuLockStatus, createMenu, getMenus, updateMenu, setMenuPlaylists, deleteMenu,
  getLockProfiles, getLockProfile, upsertLockProfile, deleteLockProfile,
  recordVideoWatch, demoteVideo, getPlaylistWatchLog, resetPlaylistWatchLog, markPlaylistCompleted,
  clearDailyProgress, getPlaylistProgress, addPlaylistProgress,
  getLiveStreams, addLiveStream, deleteLiveStream,
  setPlaylistAcknowledgement, isPlaylistAcknowledged,
  renamePlaylist, renameVideo,
  getRotationGroups, createRotationGroup, renameRotationGroup, deleteRotationGroup,
  setGroupSteps, setGroupEnabled, restartGroupCycle, setStepMandatory, getAllGroupStatuses,
  setGroupSchedule, setGroupMode, setGroupCycle, setGroupPausePlaylist, setGroupWindow,
  getPlaylistGroups, createPlaylistGroup, renamePlaylistGroup, deletePlaylistGroup, setPlaylistGroupMembers,
  getBrowserLinks, getBrowserLink, createBrowserLink, deleteBrowserLink, setBrowserLinkPortrait,
  checkOrRequestApproval, getApprovalStatus, getPendingApprovals, resolveApproval
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
