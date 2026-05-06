'use strict';

/**
 * TV API Routes
 */

const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const mime = require('mime-types');
const db = require('../db');
const { registerVideo, getOrCreateHls, HLS_CACHE_PATH, getVideoPath } = require('../hls');

const VIDEO_EXTENSIONS = new Set(['.mp4', '.mkv', '.avi', '.mov', '.webm']);
const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.JPG', '.PNG', '.JPEG', '.WEBP'];

let MEDIA_PATH = '';

function setMediaPath(p) { MEDIA_PATH = p; }

function getVideoFiles(dir) {
  try {
    return fs.readdirSync(dir)
      .filter(f => VIDEO_EXTENSIONS.has(path.extname(f).toLowerCase()))
      .sort();
  } catch {
    return [];
  }
}

function getThumbnail(dir, videoFile = null) {
  try {
    const files = fs.readdirSync(dir);
    if (videoFile) {
      const base = path.basename(videoFile, path.extname(videoFile));
      for (const ext of IMAGE_EXTENSIONS) {
        if (files.includes(base + ext)) return base + ext;
      }
    }
    for (const f of files) {
      if (IMAGE_EXTENSIONS.includes(path.extname(f))) return f;
    }
  } catch { /* ignore */ }
  return null;
}

router.get('/api/status', async (req, res) => {
  try {
    const sleepStatus = await db.isSystemAsleep();
    if (sleepStatus) {
      res.json({
        locked: true,
        message: sleepStatus.message || 'Time for bed!',
        audio: sleepStatus.audio || '',
        image: sleepStatus.image || ''
      });
    } else {
      res.json({
        locked: false,
        message: '',
        audio: '',
        image: ''
      });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/api/playlists', async (req, res) => {
  console.log(`[TV-API] GET /api/playlists from ${req.ip}`);
  if (await db.isSystemAsleep()) return res.json([]);


  try {
    const cached = await db.getCachedPlaylists();
    const result = [];
    
    for (const p of cached) {
      const isAllowed = await db.isPlaylistAllowed(p.name);
      let lockMessage = '';
      let lockAudio = '';
      
      if (!isAllowed) {
        const schedule = await db.getSchedule(p.name);
        if (schedule) {
          lockMessage = schedule.lock_message || 'This playlist is currently locked.';
          lockAudio = schedule.lock_audio || '';
        }
      }

      const itemPath = path.join(MEDIA_PATH, p.name);
      const thumb = getThumbnail(itemPath);
      result.push({
        id: p.name,
        name: p.name,
        count: p.count,
        thumbnail: thumb ? `/images/${encodeURIComponent(p.name)}/${encodeURIComponent(thumb)}` : null,
        locked: !isAllowed,
        lock_message: lockMessage,
        lock_audio: lockAudio
      });
    }
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/api/playlists/:id(*)', async (req, res) => {
  const playlistId = req.params.id;
  console.log(`[TV-API] GET /api/playlists/${playlistId} from ${req.ip}`);


  if (await db.isSystemAsleep() || !await db.isPlaylistAllowed(playlistId)) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  try {
    const videos = await db.getCachedVideos(playlistId);
    
    const videoList = videos.map(v => {
      // Register in hash map for HLS
      registerVideo(v.vpath);

      return {
        filename: v.filename,
        title: v.title,
        url: `/stream/hash/${v.vhash}`,
        hls_url: `/hls/stream/${v.vhash}/index.m3u8`,
        thumbnail: v.thumbnail,
        duration: v.duration,
        size_mb: v.size_mb,
      };
    });

    res.json({ id: playlistId, name: playlistId, videos: videoList });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/api/search', async (req, res) => {
  const query = (req.query.q || '').toLowerCase().trim();
  if (!query) return res.json([]);

  try {
    const dbInst = await db.getDb();
    const results = await dbInst.all(`
      SELECT * FROM media_cache 
      WHERE title LIKE ? OR filename LIKE ?
    `, [`%${query}%`, `%${query}%`]);

    const result = [];
    for (const v of results) {
      if (!await db.isPlaylistAllowed(v.playlist)) continue;
      
      registerVideo(v.vpath);
      result.push({
        id: v.filename,
        title: v.title,
        channel: v.playlist,
        duration: v.duration || '',
        size_mb: v.size_mb,
        thumbnail: v.thumbnail || '',
        url: `/stream/hash/${v.vhash}`,
        hls_url: `/hls/stream/${v.vhash}/index.m3u8`,
      });
    }

    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/api/overlay', async (req, res) => res.json(await db.getOverlay()));

router.get('/images/*', (req, res) => {
  const filePath = req.params[0];
  console.log(`[TV-API] GET /images/${filePath}`);
  
  // filePath is something like "Downloads/Blippi/Misc/video.jpg"
  // Decode it in case there are %20 spaces
  const decodedPath = decodeURIComponent(filePath);
  const imgPath = path.join(MEDIA_PATH, decodedPath);

  if (!fs.existsSync(imgPath)) return res.status(404).send('Not found');
  const mimeType = mime.lookup(imgPath) || 'image/jpeg';
  res.setHeader('Content-Type', mimeType);
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.sendFile(imgPath);
});

// Robust hash-based streaming (handles special characters like ?, #, etc)
router.get('/stream/hash/:hash', async (req, res) => {
  const { hash } = req.params;
  console.log(`[TV-API] GET /stream/hash/${hash} from ${req.ip}`);

  // 1. Check in-memory map first (fast)
  let videoPath = getVideoPath(hash);
  
  // 2. Fallback to database (persistent)
  if (!videoPath) {
    videoPath = await db.getVideoPathByHash(hash);
    if (videoPath) {
      // Re-register in map for future fast lookups
      registerVideo(videoPath);
    }
  }

  if (!videoPath || !fs.existsSync(videoPath)) {
    console.warn(`[TV-API] 404: Video hash ${hash} not found or file missing.`);
    return res.status(404).send('Not found');
  }

  const mimeType = mime.lookup(videoPath) || 'video/mp4';
  res.setHeader('Content-Type', mimeType);
  res.setHeader('Accept-Ranges', 'bytes');

  res.sendFile(videoPath, err => {
    if (err && !res.headersSent) res.status(500).send('Stream error');
  });
});

router.get('/stream/*', async (req, res) => {
  // Ignore hash routes which are matched above
  if (req.params[0].startsWith('hash/')) return res.status(404).send('Not found');

  const filePath = req.params[0];
  const decodedPath = decodeURIComponent(filePath);
  
  // Try to extract playlistId from the first segment if needed for permissions
  const playlistId = decodedPath.split('/')[0];
  console.log(`[TV-API] GET /stream/${decodedPath} from ${req.ip}`);

  if (await db.isSystemAsleep() || !await db.isPlaylistAllowed(playlistId)) return res.status(403).send('Forbidden');

  const videoPath = path.join(MEDIA_PATH, decodedPath);
  if (!fs.existsSync(videoPath)) {
    console.warn(`[TV-API] 404: File not found at ${videoPath}`);
    return res.status(404).send('Not found');
  }

  const mimeType = mime.lookup(videoPath) || 'video/mp4';
  res.setHeader('Content-Type', mimeType);
  res.setHeader('Accept-Ranges', 'bytes');

  res.sendFile(videoPath, err => {
    if (err && !res.headersSent) res.status(500).send('Stream error');
  });
});

router.get('/hls/stream/:hash/index.m3u8', async (req, res) => {
  const { hash } = req.params;
  console.log(`[TV-API] GET HLS Manifest for hash: ${hash} from ${req.ip}`);

  try {
    // Ensure it's in the hash map (fallback to DB)
    if (!getVideoPath(hash)) {
      const vpath = await db.getVideoPathByHash(hash);
      if (vpath) registerVideo(vpath);
    }

    const cacheDir = await getOrCreateHls(hash);
    if (!cacheDir) return res.status(404).send('Video not registered.');
    const manifestPath = path.join(cacheDir, 'index.m3u8');
    if (!fs.existsSync(manifestPath)) return res.status(503).send('HLS conversion in progress.');
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.sendFile(manifestPath);
  } catch (e) {
    res.status(500).send('HLS error: ' + e.message);
  }
});

router.get('/hls/stream/:hash/:segment', (req, res) => {
  const { hash, segment } = req.params;
  if (!segment.endsWith('.ts')) return res.status(400).send('Invalid segment');
  const segPath = path.join(HLS_CACHE_PATH, hash, segment);
  if (!fs.existsSync(segPath)) return res.status(404).send('Segment not found');
  res.setHeader('Content-Type', 'video/mp2t');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.sendFile(segPath);
});

module.exports = { router, setMediaPath };
