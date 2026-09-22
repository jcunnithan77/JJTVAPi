'use strict';

/**
 * Resolves a configured "live stream" URL into an actual playable stream URL.
 *
 * Admin-configured live entries are often just a YouTube watch/share link
 * (e.g. https://youtu.be/xyz) rather than a direct .m3u8/media URL, which
 * ExoPlayer on the TV app cannot play as-is. This shells out to yt-dlp
 * (already bundled in the Docker image for the downloader feature) to
 * extract the real underlying stream URL, and caches the result briefly
 * since YouTube's signed URLs are only valid for a few hours and resolving
 * is too slow (a few seconds, spawns a process) to do on every request.
 */

const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');

// YouTube's signed stream URLs are typically valid for ~6 hours; re-resolving
// well before that avoids ever handing the TV app a URL that's about to expire
// mid-playback.
const CACHE_TTL_MS = 4 * 60 * 60 * 1000;

const cache = new Map(); // streamId -> { url, resolvedAt }
const inFlight = new Map(); // streamId -> Promise, de-dupes concurrent resolves for the same stream

function isYoutubeUrl(url) {
  return /(?:youtube\.com|youtu\.be)/i.test(url || '');
}

function resolveYoutubeUrl(url) {
  return new Promise((resolve, reject) => {
    const args = [
      '-g',
      '-f', 'best[protocol*=m3u8]/best',
      '--no-warnings',
      '--extractor-args', 'youtube:player-client=ios,android,mweb,web'
    ];
    const cookiesPath = path.join(__dirname, '..', '..', 'cookies.txt');
    if (fs.existsSync(cookiesPath)) {
      args.push('--cookies', cookiesPath);
    }
    args.push(url);

    execFile('yt-dlp', args, { timeout: 20000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr?.toString().trim() || err.message));
      const resolvedUrl = stdout.toString().trim().split('\n')[0];
      if (!resolvedUrl) return reject(new Error('yt-dlp returned no URL'));
      resolve(resolvedUrl);
    });
  });
}

/**
 * Returns a URL safe to hand to the TV app's player for the given live
 * stream. Non-YouTube URLs (already-direct stream links) pass through
 * untouched. On resolve failure, falls back to a stale cached URL if one
 * exists (still better odds than definitely serving an unplayable page
 * link), otherwise the original URL.
 */
async function getPlayableUrl(streamId, originalUrl) {
  if (!isYoutubeUrl(originalUrl)) return originalUrl;

  const cached = cache.get(streamId);
  if (cached && (Date.now() - cached.resolvedAt) < CACHE_TTL_MS) {
    return cached.url;
  }

  const key = String(streamId);
  if (inFlight.has(key)) return inFlight.get(key);

  const task = (async () => {
    try {
      const resolvedUrl = await resolveYoutubeUrl(originalUrl);
      cache.set(streamId, { url: resolvedUrl, resolvedAt: Date.now() });
      return resolvedUrl;
    } catch (e) {
      console.error(`[LiveResolver] Failed to resolve ${originalUrl}:`, e.message);
      return cached ? cached.url : originalUrl;
    } finally {
      inFlight.delete(key);
    }
  })();

  inFlight.set(key, task);
  return task;
}

module.exports = { getPlayableUrl };
