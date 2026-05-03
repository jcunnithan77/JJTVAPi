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

module.exports = { startScheduler };
