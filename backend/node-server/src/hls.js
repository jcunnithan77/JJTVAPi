'use strict';

/**
 * HLS Streaming Module
 * 
 * Manages on-demand FFmpeg segmentation of video files.
 * Each video is identified by its MD5 hash to avoid path encoding issues.
 * The hash→path map is populated when the TV requests a playlist.
 */

const { createHash } = require('crypto');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

// Use system environment variables or local binary (Windows)
const FFMPEG_PATH = process.env.FFMPEG_BIN || (os.platform() === 'win32' ? path.join(__dirname, '..', '..', 'ffmpeg.exe') : 'ffmpeg');
const FFPROBE_PATH = process.env.FFPROBE_BIN || (os.platform() === 'win32' ? path.join(__dirname, '..', '..', 'ffprobe.exe') : 'ffprobe');
const HLS_CACHE_PATH = process.env.HLS_CACHE_PATH || path.join(__dirname, '..', 'hls_cache');
const HLS_SEGMENT_DURATION = 6; // seconds per segment (YouTube uses 2-5s, Netflix 4s, we use 6s for stability)

// In-memory map: videoHash -> absoluteVideoPath
const videoHashMap = new Map();

// Track ongoing conversions to avoid starting duplicates
const ongoingConversions = new Set();

// Auto-cleanup: delete HLS cache entries older than 2 hours to prevent disk full
const CACHE_MAX_AGE_MS = 2 * 60 * 60 * 1000;

if (!fs.existsSync(HLS_CACHE_PATH)) {
  fs.mkdirSync(HLS_CACHE_PATH, { recursive: true });
}

/**
 * Compute the deterministic MD5 hash for a video path.
 */
function hashVideoPath(videoPath) {
  return createHash('md5').update(videoPath).digest('hex');
}

/**
 * Register a video in the hash map (called when serving playlist).
 */
function registerVideo(videoPath) {
  const hash = hashVideoPath(videoPath);
  videoHashMap.set(hash, videoPath);
  return hash;
}

/**
 * Start FFmpeg HLS segmentation for a video.
 * Returns a Promise that resolves when index.m3u8 is ready.
 */
function startHlsConversion(videoPath, cacheDir) {
  return new Promise((resolve, reject) => {
    const manifestPath = path.join(cacheDir, 'index.m3u8');

    if (fs.existsSync(manifestPath)) {
      return resolve(true);
    }

    if (ongoingConversions.has(cacheDir)) {
      // Wait for the ongoing conversion to produce the manifest
      return waitForManifest(manifestPath, 30000).then(resolve).catch(reject);
    }

    fs.mkdirSync(cacheDir, { recursive: true });
    ongoingConversions.add(cacheDir);

    const args = [
      '-i', videoPath,
      '-c:v', 'libx264',       // Transcode to H.264 for universal compatibility
      '-preset', 'ultrafast',  // Minimum latency for starting playback
      '-crf', '23',            // Good balance of quality and file size
      '-c:a', 'aac',           // Re-encode audio to AAC
      '-b:a', '128k',
      '-start_number', '0',
      '-hls_time', String(HLS_SEGMENT_DURATION),
      '-hls_list_size', '0',   // Keep all segments (VOD mode)
      '-hls_flags', 'independent_segments',
      '-hls_segment_type', 'mpegts',
      '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', // Ensure even dimensions for H.264
      '-f', 'hls',
      manifestPath,
    ];


    console.log(`[HLS] Starting conversion: ${path.basename(videoPath)}`);
    const ffmpeg = spawn(FFMPEG_PATH, args, { stdio: ['ignore', 'ignore', 'pipe'] });

    let stderr = '';
    ffmpeg.stderr.on('data', d => { stderr += d.toString(); });

    ffmpeg.on('close', code => {
      ongoingConversions.delete(cacheDir);
      if (code === 0) {
        console.log(`[HLS] Conversion complete: ${path.basename(videoPath)}`);
        resolve(true);
      } else {
        console.error(`[HLS] FFmpeg error (${code}) for file ${videoPath}: ${stderr.slice(-500)}`);
        reject(new Error(`FFmpeg exited with code ${code}`));
      }
    });

    // Don't wait for full conversion — resolve as soon as first segment appears
    waitForManifest(manifestPath, 15000).then(resolve).catch(reject);
  });
}

/**
 * Poll until the manifest file exists (first segment ready).
 */
function waitForManifest(manifestPath, timeoutMs) {
  return new Promise((resolve, reject) => {
    const interval = 200;
    let elapsed = 0;
    const timer = setInterval(() => {
      if (fs.existsSync(manifestPath)) {
        clearInterval(timer);
        resolve(true);
      } else {
        elapsed += interval;
        if (elapsed >= timeoutMs) {
          clearInterval(timer);
          reject(new Error('HLS manifest timeout'));
        }
      }
    }, interval);
  });
}

/**
 * Get or trigger HLS for a given hash. Returns cache directory.
 */
async function getOrCreateHls(videoHash) {
  const videoPath = videoHashMap.get(videoHash);
  if (!videoPath) return null;

  const cacheDir = path.join(HLS_CACHE_PATH, videoHash);
  await startHlsConversion(videoPath, cacheDir);
  return cacheDir;
}

/**
 * Cleanup old HLS cache entries to prevent disk exhaustion.
 * Deletes any cache directory not accessed in CACHE_MAX_AGE_MS.
 */
function cleanupOldCache() {
  try {
    const entries = fs.readdirSync(HLS_CACHE_PATH);
    const now = Date.now();
    let cleaned = 0;
    for (const entry of entries) {
      const dir = path.join(HLS_CACHE_PATH, entry);
      try {
        const stat = fs.statSync(dir);
        if (stat.isDirectory() && (now - stat.mtimeMs) > CACHE_MAX_AGE_MS) {
          fs.rmSync(dir, { recursive: true, force: true });
          cleaned++;
        }
      } catch { /* skip */ }
    }
    if (cleaned > 0) console.log(`[HLS] Cleaned ${cleaned} old cache entries.`);
  } catch (e) {
    console.error('[HLS] Cache cleanup error:', e.message);
  }
}

// Run cleanup every 30 minutes
setInterval(cleanupOldCache, 30 * 60 * 1000);

module.exports = { hashVideoPath, registerVideo, getOrCreateHls, HLS_CACHE_PATH };
