'use strict';

/**
 * YouTube Download Worker
 * Queue-based downloader using yt-dlp CLI.
 * Progress is tracked in memory and served via /admin-api/stats.
 */

const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const path = require('path');
const fs = require('fs');
const { scanFolder } = require('./scanner');

const os = require('os');

// Use system environment variables or local binary (Windows)
const FFMPEG_PATH = process.env.FFMPEG_BIN || (os.platform() === 'win32' ? path.join(__dirname, '..', '..', 'ffmpeg.exe') : 'ffmpeg');

const DEFAULT_THUMB = path.join(__dirname, '..', '..', 'default_thumb.jpg');
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mkv', '.avi', '.mov', '.webm']);
const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp'];

// Public state — read by stats endpoint
const activeDownloads = {};
const downloadQueue = [];
let isWorkerBusy = false;
const emitter = new EventEmitter();

function queueDownload(jobId, url, playlist, mediaPath) {
  activeDownloads[jobId] = { status: 'queued', percent: 0, title: 'Waiting in queue...', playlist };
  downloadQueue.push({ jobId, url, playlist, mediaPath });
  processQueue(mediaPath);
  return jobId;
}

function processQueue(mediaPath) {
  if (isWorkerBusy || downloadQueue.length === 0) return;
  isWorkerBusy = true;
  const job = downloadQueue.shift();
  _doDownload(job.jobId, job.url, job.playlist, job.mediaPath).finally(() => {
    isWorkerBusy = false;
    processQueue(mediaPath);
  });
}

async function _doDownload(jobId, url, playlist, mediaPath) {
  const targetDir = path.join(mediaPath, _sanitize(playlist));
  fs.mkdirSync(targetDir, { recursive: true });

  activeDownloads[jobId] = { status: 'downloading', percent: 0, title: 'Initializing...', playlist };

  const ytdlpArgs = [
    url,
    '-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
    '-o', path.join(targetDir, '%(id)s.%(ext)s'),
    '--merge-output-format', 'mp4',
    '--write-thumbnail',
    '--convert-thumbnails', 'jpg',
    '--write-info-json',
    '--no-overwrites',
    '--ignore-errors',
    '--progress',
    '--newline',
    '--extractor-args', 'youtube:player-client=web',
    '--ffmpeg-location', FFMPEG_PATH,
  ];

  return new Promise((resolve) => {
    const proc = spawn('yt-dlp', ytdlpArgs, { stdio: ['ignore', 'pipe', 'pipe'] });

    proc.stdout.on('data', (chunk) => {
      const lines = chunk.toString().split('\n');
      for (const line of lines) {
        // Parse progress: [download]  45.2% of ...
        const pMatch = line.match(/\[download\]\s+([\d.]+)%/);
        if (pMatch) {
          activeDownloads[jobId].percent = parseFloat(pMatch[1]);
        }
        // Parse title from destination line
        const dMatch = line.match(/\[download\] Destination: .+[\\/](.+)\.(mp4|mkv|webm|avi)/i);
        if (dMatch) {
          activeDownloads[jobId].title = dMatch[1];
        }
        // Merge/process phase
        if (line.includes('[Merger]') || line.includes('[ffmpeg]')) {
          activeDownloads[jobId].status = 'processing';
          activeDownloads[jobId].percent = 100;
        }
      }
    });

    proc.stderr.on('data', (d) => { /* suppress yt-dlp warnings */ });

    proc.on('close', (code) => {
      // Assign default thumbnails to any video that lacks one
      try {
        const files = fs.readdirSync(targetDir);
        for (const f of files) {
          const ext = path.extname(f).toLowerCase();
          if (VIDEO_EXTENSIONS.has(ext)) {
            const base = path.join(targetDir, path.basename(f, ext));
            const hasThumb = IMAGE_EXTENSIONS.some(ie => fs.existsSync(base + ie));
            if (!hasThumb && fs.existsSync(DEFAULT_THUMB)) {
              fs.copyFileSync(DEFAULT_THUMB, base + '.jpg');
            }
          }
        }
      } catch { /* ignore */ }

      activeDownloads[jobId].status = code === 0 ? 'completed' : 'error';
      
      // Trigger scan of the folder to update database cache
      if (code === 0) {
        scanFolder(mediaPath, playlist).catch(e => console.error('[Downloader] Post-scan error:', e.message));
      }

      resolve();
    });
  });
}

function _sanitize(name) {
  // Basic sanitization matching yt-dlp's sanitize_filename
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim();
}

function getActiveDownloads() { return activeDownloads; }
function getQueueSize() { return downloadQueue.length; }

module.exports = { queueDownload, getActiveDownloads, getQueueSize };
