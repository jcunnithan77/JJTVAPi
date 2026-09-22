'use strict';

/**
 * TV API Routes
 */

const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const mime = require('mime-types');
const os = require('os');
const db = require('../db');
const { registerVideo, getOrCreateHls, HLS_CACHE_PATH, getVideoPath, touchStream } = require('../hls');
const { getPlayableUrl } = require('../liveResolver');

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

function getLocalIpAddress(reqIp = '') {
  const interfaces = os.networkInterfaces();
  let bestIp = null;
  let fallbackIp = null;

  // Clean up reqIp (e.g. ::ffff:192.168.1.5 -> 192.168.1.5)
  const cleanReqIp = reqIp.replace(/^.*:/, '');
  const reqPrefix = cleanReqIp.split('.').slice(0, 3).join('.');

  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        const ip = iface.address;
        
        // 1. Exact subnet match with the requester (TV)
        if (reqPrefix && ip.startsWith(reqPrefix + '.')) {
          return ip;
        }

        // 2. Prioritize common home LANs (192.168.x.x) over Docker/VPNs
        if (ip.startsWith('192.168.')) {
          bestIp = ip;
        } else if (!bestIp && (ip.startsWith('10.') || ip.startsWith('172.'))) {
          fallbackIp = ip;
        } else if (!bestIp && !fallbackIp) {
          fallbackIp = ip;
        }
      }
    }
  }
  return bestIp || fallbackIp || 'localhost';
}

router.get('/api/status', async (req, res) => {
  try {
    const sleepStatus = await db.isSystemAsleep();
    const allSettings = await db.getSettings();
    const streamThroughLan = allSettings['stream_through_lan'] === 'true';
    const serverLanIpOverride = allSettings['server_lan_ip'];
    const lanIp = (serverLanIpOverride && serverLanIpOverride.trim() !== '') 
        ? serverLanIpOverride.trim() 
        : getLocalIpAddress(req.ip);
    const port = req.socket.localPort || process.env.PORT || 5000;
    const lanUrl = `http://${lanIp}:${port}`;

    let response = {
      locked: false,
      message: '',
      audio: '',
      image: '',
      stream_through_lan: streamThroughLan,
      lan_ip: lanUrl,
      force_reload: Number(allSettings['force_reload_timestamp'] || 0),
      // The server's own clock, not the caller's - lets the admin panel (which may be opened
      // from a different device/timezone) and the TV app both show the actual system time
      // this backend uses for schedule/quota/lock evaluation, rather than a local device clock.
      server_time: new Date().toISOString()
    };

    if (sleepStatus && sleepStatus.locked) {
      response.locked = true;
      response.message = sleepStatus.message ?? 'Time for bed!';
      response.audio = sleepStatus.audio ?? '';
      response.image = sleepStatus.image ?? '';
    } else {
      // Bedtime always wins; only check for a schedule/rotation pause if it's not active.
      const pauseStatus = await db.getPauseLockStatus();
      if (pauseStatus && pauseStatus.locked) {
        response.locked = true;
        response.message = pauseStatus.message;
        response.audio = pauseStatus.audio;
        response.image = pauseStatus.image;
        response.audioPlaylist = pauseStatus.audioPlaylist || [];
      }
    }

    res.json(response);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Browser Links (kiosk-mode web browsing, admin-curated with an approval queue) ---

router.get('/api/browser-links', async (req, res) => {
  if (await db.isSystemAsleep()) return res.json([]);
  try {
    const links = await db.getBrowserLinks();
    res.json(links.map(l => ({ id: l.id, name: l.name, url: l.url, thumbnail: l.thumbnail, group_name: l.group_name, force_portrait: l.force_portrait === 1 })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Single link detail, including its currently-approved domains - the app fetches this
// once when opening the browser screen so the starting page never has to wait on a
// navigation-check round trip.
router.get('/api/browser-links/:id', async (req, res) => {
  if (await db.isSystemAsleep()) return res.status(403).json({ error: 'Forbidden' });
  try {
    const link = await db.getBrowserLink(parseInt(req.params.id));
    if (!link) return res.status(404).json({ error: 'Not found' });
    res.json({ id: link.id, name: link.name, url: link.url, thumbnail: link.thumbnail, force_portrait: link.force_portrait === 1, approvedDomains: link.approvedDomains });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Called before following ANY navigation inside the browser view (including the
// link's own starting URL) - returns {allowed:true} if the target's domain is
// approved, otherwise files (or reuses) a pending admin-approval request.
router.post('/api/browser-links/:id/navigate', async (req, res) => {
  if (await db.isSystemAsleep()) return res.status(403).json({ error: 'Forbidden' });
  const { url } = req.body || {};
  if (!url) return res.status(400).json({ error: 'url is required' });
  try {
    const result = await db.checkOrRequestApproval(parseInt(req.params.id), url);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Poll target for the app to auto-resume once an admin approves (or denies) a request.
router.get('/api/browser-links/:id/approval/:requestId', async (req, res) => {
  try {
    const status = await db.getApprovalStatus(parseInt(req.params.requestId));
    res.json(status);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/api/playlists', async (req, res) => {
  console.log(`[TV-API] GET /api/playlists from ${req.ip}`);
  if (await db.isSystemAsleep()) return res.json([]);

  try {
    const displayInfo = await db.getPlaylistsForDisplay();
    const cached = await db.getCachedPlaylists();
    const result = [];

    function isAllowed(name) {
      // Check blocked
      if (displayInfo.blocked && displayInfo.blocked.some(b => name === b || name.startsWith(b + '/'))) return false;
      if (displayInfo.mode === 'all') return true;
      if (displayInfo.mode === 'priority') {
        return displayInfo.playlists.some(p => name === p || name.startsWith(p + '/'));
      }
      // fallback mode
      if (displayInfo.excludeScheduled) {
        for (const ex of displayInfo.excludeScheduled) {
          if (name === ex || name.startsWith(ex + '/')) return false;
        }
      }
      return true;
    }
    
    for (const p of cached) {
      if (!isAllowed(p.name)) continue;

      const itemPath = path.join(MEDIA_PATH, p.name);
      const thumb = getThumbnail(itemPath);
      result.push({
        id: p.name,
        name: p.name,
        count: p.count,
        thumbnail: thumb ? `/images/${encodeURIComponent(p.name)}/${encodeURIComponent(thumb)}` : null,
        locked: false,
        lock_message: '',
        lock_audio: ''
      });
    }

    // Check Live Streams
    if (db.getLiveStreams) {
      const liveStreams = await db.getLiveStreams();
      if (liveStreams && liveStreams.length > 0) {
        if (isAllowed('Live')) {
          result.push({
            id: 'Live',
            name: 'Live TV',
            count: liveStreams.length,
            thumbnail: null,
            locked: false,
            lock_message: '',
            lock_audio: ''
          });
        }
      }
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
    let videos = [];
    if (playlistId === 'Live' && db.getLiveStreams) {
      const streams = await db.getLiveStreams();
      // Admin-configured live entries are often a YouTube watch/share link rather than a
      // direct media URL, which ExoPlayer can't play as-is - resolve each to a real
      // playable stream URL (cached briefly server-side; see liveResolver.js) before
      // handing it to the TV app.
      const playableUrls = await Promise.all(streams.map(s => getPlayableUrl(s.id, s.url)));
      videos = streams.map((s, i) => ({
        filename: s.title,
        title: s.title,
        url: playableUrls[i],
        hls_url: playableUrls[i],
        thumbnail: s.thumbnail,
        duration: '',
        size_mb: 0,
        vhash: 'live_' + s.id,
        vpath: '',
        playlist: 'Live'
      }));
    } else {
      videos = await db.getCachedVideos(playlistId);
    }
    
    const watchLog = await db.getPlaylistWatchLog(playlistId);
    const demotedSet = new Set(watchLog.filter(r => r.demoted === 1).map(r => r.vhash));

    let sorted = [
      ...videos.filter(v => !demotedSet.has(v.vhash)),
      ...videos.filter(v => demotedSet.has(v.vhash)),
    ];
    
    let isMandatory = false;
    let minDuration = 0;
    let reqAck = false;
    let minRepeat = 1;
    let maxRepeat = 3;
    let parentScheduleName = playlistId;

    let parts = playlistId.split('/');
    for (let i = parts.length; i > 0; i--) {
      const parentName = parts.slice(0, i).join('/');
      const parentSchedule = await db.getSchedule(parentName);
      if (parentSchedule) {
        if (parentSchedule.mandatory_view === 1) isMandatory = true;
        if (parentSchedule.min_duration > 0) minDuration = parentSchedule.min_duration;
        if (parentSchedule.req_ack === 1) reqAck = true;
        if (parentSchedule.min_repeat !== undefined) minRepeat = parentSchedule.min_repeat;
        if (parentSchedule.max_repeat !== undefined) maxRepeat = parentSchedule.max_repeat;
        parentScheduleName = parentName;
        break;
      }
    }

    const isAcknowledged = await db.isPlaylistAcknowledged(playlistId);

    let remainingTimeMsg = '';
    let remainingSecsInt = 0;
    if (minDuration > 0) {
      const watchedSecs = await db.getPlaylistProgress(parentScheduleName);
      remainingSecsInt = (minDuration * 60) - watchedSecs;
      if (remainingSecsInt > 0) {
        remainingTimeMsg = `Mandatory: ${Math.ceil(remainingSecsInt / 60)} minutes remaining`;
      } else {
        remainingSecsInt = 0;
      }
    }

    if (isMandatory && remainingSecsInt > 0) {
      // Still needs more watch time - only show the NEXT unwatched video to enforce mandatory viewing
      const nextVideo = sorted.find(v => !demotedSet.has(v.vhash));
      if (nextVideo) {
        sorted = [nextVideo];
      } else if (sorted.length > 0) {
        // If all are demoted, they finished the whole playlist before reset
        sorted = [sorted[0]];
      }
    }
    // If mandatory time is fulfilled (remainingSecsInt === 0), show ALL videos freely

    const videoList = sorted.map(v => {
      // Register in hash map for HLS
      registerVideo(v.vpath);

      return {
        filename: v.filename,
        title: v.title,
        url: v.url || `/stream/hash/${v.vhash}`,
        hls_url: v.hls_url || `/hls/stream/${v.vhash}/index.m3u8`,
        thumbnail: v.thumbnail,
        duration: v.duration,
        size_mb: v.size_mb,
        vhash: v.vhash,
        playlist: playlistId,
        demoted: demotedSet.has(v.vhash),
        watch_count: watchLog.find(l => l.vhash === v.vhash)?.watch_count || 0,
      };
    });

    res.json({ 
      id: playlistId, 
      name: playlistId, 
      videos: videoList, 
      mandatory_view: isMandatory, 
      notification: remainingTimeMsg,
      remaining_mandatory_seconds: remainingSecsInt,
      req_ack: reqAck,
      min_repeat: minRepeat,
      max_repeat: maxRepeat,
      acknowledged: isAcknowledged
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/api/playlists/:id(*)/ack_status', async (req, res) => {
  const playlistId = req.params.id;
  try {
    const isAcknowledged = await db.isPlaylistAcknowledged(playlistId);
    res.json({ acknowledged: isAcknowledged });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/api/video/progress', async (req, res) => {
  const { playlist, watched_seconds } = req.body || {};
  if (!playlist || typeof watched_seconds !== 'number') {
    return res.status(400).json({ error: 'Missing params' });
  }
  try {
    await db.addPlaylistProgress(playlist, watched_seconds);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/api/video/watched', async (req, res) => {
  const { vhash, playlist } = req.body || {};
  if (!vhash || !playlist) return res.status(400).json({ error: 'Missing params' });

  try {
    const count = await db.recordVideoWatch(vhash, playlist);

    const schedule = await db.getSchedule(playlist);
    const watchLimit = (schedule && schedule.watch_limit) ? schedule.watch_limit : 3;

    if (count >= watchLimit) {
      await db.demoteVideo(vhash, playlist);
    }

    // Check if ALL non-demoted videos in the playlist have now been demoted
    const log = await db.getPlaylistWatchLog(playlist);
    const allVideos = await db.getCachedVideos(playlist);
    const demotedHashes = new Set(log.filter(r => r.demoted === 1).map(r => r.vhash));
    const allDemoted = allVideos.length > 0 && allVideos.every(v => demotedHashes.has(v.vhash));

    if (allDemoted) {
      // Full rotation complete → reset all locks
      await db.resetPlaylistWatchLog(playlist);
      // Also check if this is a priority playlist and mark as completed
      if (schedule) {
        await db.markPlaylistCompleted(playlist);
      }
    }

    res.json({ success: true, watch_count: count, rotation_reset: allDemoted });
  } catch (e) {
    console.error(`[TV-API] Error recording video watch: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

router.get('/api/search', async (req, res) => {
  const query = (req.query.q || '').toLowerCase().trim();
  if (!query) return res.json([]);

  try {
    const results = await db.searchMediaCache(query);

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
        vhash: v.vhash,
      });
    }

    res.json(result);
  } catch (e) {
    console.error(`[TV-API] Search error:`, e);
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

router.get('/uploads/*', (req, res) => {
  const filePath = req.params[0];
  const decodedPath = decodeURIComponent(filePath);
  const fullPath = path.join(MEDIA_PATH, 'uploads', decodedPath);

  if (!fs.existsSync(fullPath)) return res.status(404).send('Not found');
  const mimeType = mime.lookup(fullPath) || 'application/octet-stream';
  res.setHeader('Content-Type', mimeType);
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.sendFile(fullPath);
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

  if (req.query.download === '1') {
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(path.basename(videoPath))}"`);
  }

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

  if (req.query.download === '1') {
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(path.basename(videoPath))}"`);
  }

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

  // Mark this stream as actively being watched — prevents cache cleanup mid-play
  touchStream(hash);

  res.setHeader('Content-Type', 'video/mp2t');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.sendFile(segPath);
});

module.exports = { router, setMediaPath };
