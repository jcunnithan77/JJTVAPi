'use strict';

/**
 * Scheduled Download Scheduler
 * Uses node-cron to check for pending scheduled downloads every minute.
 */

const cron = require('node-cron');
const db = require('./db');
const { queueDownload } = require('./downloader');

let MEDIA_PATH = '';

function startScheduler(mediaPath) {
  MEDIA_PATH = mediaPath;

  // Check every minute for scheduled downloads that are due
  cron.schedule('* * * * *', async () => {
    try {
      const allScheduled = await db.getScheduledDownloads();
      const pending = allScheduled.filter(d => d.status === 'pending');
      const now = new Date();

      for (const job of pending) {
        const runAt = new Date(job.scheduled_at);
        if (runAt <= now) {
          console.log(`[Scheduler] Triggering download: ${job.id} - ${job.url}`);
          await db.updateScheduledDownloadStatus(job.id, 'running');
          queueDownload(`sched_${job.id}`, job.url, job.playlist, MEDIA_PATH);

          // Mark as completed after queueing
          setTimeout(async () => {
            await db.updateScheduledDownloadStatus(job.id, 'completed');
          }, 2000);
        }
      }
    } catch (e) {
      console.error('[Scheduler] Error:', e.message);
    }
  });

  console.log('[Scheduler] Started — checking every minute for scheduled downloads.');
}

// Rotation steps (and other schedule-driven windows) change automatically as time passes -
// nothing "pushes" that to an already-connected TV, so a device sitting on a playing video
// wouldn't notice a step transition (e.g. play -> pause) until it happened to re-fetch on its
// own (video ending, user navigating back). This watches what getPlaylistsForDisplay() would
// currently allow and bumps force_reload_timestamp the moment that set actually changes, which
// the TV app already polls for and reacts to by exiting the player back to the library.
let _lastAllowedKey = null;

function startRotationWatcher(intervalMs = 20000) {
  setInterval(async () => {
    try {
      const display = await db.getPlaylistsForDisplay();
      const key = display.mode === 'priority'
        ? `priority:${[...display.playlists].sort().join(',')}`
        : display.mode;

      if (_lastAllowedKey !== null && key !== _lastAllowedKey) {
        console.log(`[RotationWatcher] Allowed content changed (${_lastAllowedKey} -> ${key}), triggering TV reload`);
        await db.setSetting('force_reload_timestamp', Date.now().toString());
      }
      _lastAllowedKey = key;
    } catch (e) {
      console.error('[RotationWatcher] Error:', e.message);
    }
  }, intervalMs);

  console.log(`[RotationWatcher] Started — checking every ${intervalMs / 1000}s for schedule/rotation transitions.`);
}

module.exports = { startScheduler, startRotationWatcher };
