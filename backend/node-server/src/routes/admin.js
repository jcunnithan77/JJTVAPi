'use strict';

/**
 * Admin API Routes
 */

const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { v4: uuidv4 } = require('uuid');
const mime = require('mime-types');
const db = require('../db');
const logger = require('../logger');
const { queueDownload, getActiveDownloads, getQueueSize } = require('../downloader');
const { scanAll } = require('../scanner');

let repairProcess = null;
let repairLogs = [];
const MAX_REPAIR_LOGS = 100;

function addRepairLog(msg) {
  repairLogs.push(`[${new Date().toLocaleTimeString()}] ${msg}`);
  if (repairLogs.length > MAX_REPAIR_LOGS) repairLogs.shift();
}

const VIDEO_EXTENSIONS = new Set(['.mp4', '.mkv', '.avi', '.mov', '.webm']);
const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp'];

let MEDIA_PATH = '';

function setMediaPath(p) { MEDIA_PATH = p; }

router.get('/admin-api/settings', async (req, res) => res.json(await db.getSettings()));

router.post('/admin-api/settings', async (req, res) => {
  for (const [k, v] of Object.entries(req.body || {})) await db.setSetting(k, v);
  res.json(await db.getSettings());
});

router.get('/admin-api/schedules', async (req, res) => {
  const scheduleMap = {};
  const schedules = await db.getSchedules();
  for (const row of schedules) {
    scheduleMap[row.playlist] = { 
      start_time: row.start_time, 
      end_time: row.end_time,
      lock_message: row.lock_message || '',
      lock_audio: row.lock_audio || ''
    };
  }
  try {
    for (const item of fs.readdirSync(MEDIA_PATH)) {
      if (fs.statSync(path.join(MEDIA_PATH, item)).isDirectory() && !scheduleMap[item]) {
        scheduleMap[item] = { start_time: '', end_time: '', lock_message: '', lock_audio: '' };
      }
    }
  } catch { /* ignore */ }
  res.json(scheduleMap);
});

router.post('/admin-api/schedules', async (req, res) => {
  const { playlist, start_time, end_time, lock_message, lock_audio } = req.body || {};
  await db.upsertSchedule(playlist, start_time || '', end_time || '', lock_message || '', lock_audio || '');
  res.json({ success: true });
});

router.delete('/admin-api/schedules/:playlist(*)', async (req, res) => {
  await db.deleteSchedule(req.params.playlist);
  res.json({ success: true });
});

router.get('/admin-api/overlay', async (req, res) => res.json(await db.getOverlay()));

router.post('/admin-api/overlay', async (req, res) => {
  const allowed = new Set(['enabled', 'banner_text', 'music_url', 'music_volume', 'banner_position', 'banner_color']);
  for (const [k, v] of Object.entries(req.body || {})) {
    if (allowed.has(k)) await db.setOverlay(k, v);
  }
  res.json({ success: true });
});

function extractVideoId(url) {
  if (!url) return null;
  const match = url.match(/(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/i);
  return match ? match[1] : null;
}

router.post('/admin-api/download', async (req, res) => {
  const { url, playlist = 'Downloads', force = false } = req.body || {};
  if (!url) return res.status(400).json({ error: 'URL required' });

  if (force !== true && force !== 'true') {
    const videoId = extractVideoId(url);
    if (videoId) {
      try {
        const sdb = await db.getDb();
        const cachedVideo = await sdb.get("SELECT * FROM media_cache WHERE filename LIKE ?", [`%${videoId}%`]);
        if (cachedVideo) {
          return res.json({
            success: false,
            alreadyDownloaded: true,
            filename: cachedVideo.filename,
            job_id: ''
          });
        }
      } catch (e) {
        console.error('[Admin API] Duplicate check failed', e);
      }
    }
  }

  const jobId = String(Date.now());
  queueDownload(jobId, url, playlist, MEDIA_PATH);
  res.json({ success: true, job_id: jobId });
});

router.get('/admin-api/download/scheduled', async (req, res) => {
  res.json(await db.getScheduledDownloads());
});

router.post('/admin-api/download/scheduled', async (req, res) => {
  const { url, playlist, scheduled_at } = req.body || {};
  if (!url) return res.status(400).json({ error: 'URL required' });
  if (!playlist) return res.status(400).json({ error: 'Playlist name required' });
  if (!scheduled_at) return res.status(400).json({ error: 'scheduled_at required (ISO format)' });

  const runAt = new Date(scheduled_at);
  if (isNaN(runAt.getTime())) return res.status(400).json({ error: 'Invalid datetime format' });
  if (runAt <= new Date()) return res.status(400).json({ error: 'Scheduled time must be in the future' });

  const id = uuidv4().slice(0, 8);
  await db.createScheduledDownload(id, url, playlist, scheduled_at);
  res.json({ success: true, id, scheduled_at });
});

router.delete('/admin-api/download/scheduled/:jobId', async (req, res) => {
  await db.cancelScheduledDownload(req.params.jobId);
  res.json({ success: true });
});

// ─────────────────────────────────────────────────────────────
// Logs
// ─────────────────────────────────────────────────────────────
router.get('/admin-api/logs', (req, res) => {
  res.json(logger.getRecentLogs());
});

router.get('/admin-api/logs/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // Send recent history first
  const history = logger.getRecentLogs();
  for (const line of history) {
    res.write(`data: ${JSON.stringify({ message: line })}\n\n`);
  }

  const logHandler = (msg) => {
    res.write(`data: ${JSON.stringify({ message: msg })}\n\n`);
  };

  logger.onLog(logHandler);

  let cleanedUp = false;
  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    logger.offLog(logHandler);
  };

  req.on('close', cleanup);
  req.on('end', cleanup);
  res.on('close', cleanup);
  res.on('finish', cleanup);
  res.on('error', cleanup);
});

router.get('/admin-api/youtube/search', async (req, res) => {
  const q = (req.query.q || '').trim();
  const limit = parseInt(req.query.limit || '15', 10);
  if (!q) return res.status(400).json({ error: 'Query required' });

  const isUrl = q.startsWith('http://') || q.startsWith('https://');

  if (!isUrl) {
    try {
      const ytSearch = require('yt-search');
      const r = await ytSearch(q);
      const results = r.all.slice(0, limit).map(entry => {
        let title = entry.title || entry.name || 'Unknown';
        let channel = entry.author?.name || entry.name || '';
        let type = entry.type || 'video';
        let url = entry.url || '';
        if (url.startsWith('/')) url = 'https://youtube.com' + url;

        return {
          id: entry.videoId || entry.listId || entry.id || '',
          title,
          channel,
          channel_url: entry.author?.url || '',
          type, // 'video', 'list', 'channel'
          duration: entry.timestamp || '',
          thumbnail: entry.image || entry.thumbnail || `https://via.placeholder.com/160x90/1a1a24/888?text=No+Thumb`,
          url,
          view_count: entry.views || entry.subCount || entry.videoCount || 0,
        };
      });
      return res.json(results);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // If query is a URL, use yt-dlp to extract its contents
  const ytdlpArgs = [
    q,
    '--flat-playlist',
    '--no-warnings',
    '--print-json',
    '--playlist-end', String(limit * 5)
  ];

  const isPlaylistsUrl = isUrl && q.includes('/playlists');

  const ytdlp = spawn('yt-dlp', ytdlpArgs);

  let output = '';
  let errOutput = '';
  ytdlp.stdout.on('data', d => { output += d.toString(); });
  ytdlp.stderr.on('data', d => { errOutput += d.toString(); });

  ytdlp.on('close', (code) => {
    if (code !== 0 && !output) {
      return res.status(500).json({ error: errOutput.slice(-300) || 'yt-dlp error' });
    }

    const results = [];
    for (const line of output.trim().split('\n')) {
      try {
        const entry = JSON.parse(line);
        const id = entry.id || '';
        const dur = entry.duration;
        results.push({
          id,
          title: entry.title || 'Unknown',
          channel: entry.uploader || entry.channel || '',
          channel_url: entry.uploader_url || entry.channel_url || '',
          type: isPlaylistsUrl ? 'list' : 'video', // yt-dlp flat-playlist returns playlists or videos
          duration: dur ? _fmtDuration(dur) : '',
          thumbnail: entry.thumbnail || `https://img.youtube.com/vi/${id}/mqdefault.jpg`,
          url: entry.url || entry.webpage_url || `https://www.youtube.com/watch?v=${id}`,
          view_count: entry.view_count || 0,
        });
      } catch { /* skip */ }
    }
    res.json(results.slice(0, limit));
  });
});

function _fmtDuration(seconds) {
  if (!seconds) return '';
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h ? `${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}` : `${m}:${String(sec).padStart(2,'0')}`;
}

router.get('/admin-api/stats', async (req, res) => {
  try {
    const { execSync } = require('child_process');
    let total = 0, free = 0;
    
    if (process.platform === 'win32') {
      try {
        const out = execSync(`wmic logicaldisk where "DeviceID='D:'" get Size,FreeSpace /value`, { encoding: 'utf8' });
        const freeMatch = out.match(/FreeSpace=(\d+)/);
        const sizeMatch = out.match(/Size=(\d+)/);
        if (freeMatch) free = parseInt(freeMatch[1]);
        if (sizeMatch) total = parseInt(sizeMatch[1]);
      } catch { /* ignore */ }
    } else {
      // Linux/Docker: Check the mount point of MEDIA_PATH
      try {
        const out = execSync(`df -B1 "${MEDIA_PATH}" | tail -n 1`, { encoding: 'utf8' });
        const parts = out.split(/\s+/);
        if (parts.length >= 4) {
          total = parseInt(parts[1]); // 1-indexed (Filesystem, 1K-blocks/Bytes, Used, Available)
          free = parseInt(parts[3]);
        }
      } catch (e) {
        console.error('[Admin-API] Error getting Linux stats:', e.message);
      }
    }

    const used = total - free;
    res.json({
      disk: {
        total_gb: total ? +(total / 1e9).toFixed(2) : null,
        used_gb: total ? +(used / 1e9).toFixed(2) : null,
        free_gb: total ? +(free / 1e9).toFixed(2) : null,
        percent_used: total ? +((used / total) * 100).toFixed(1) : null,
      },
      downloads: getActiveDownloads(),
      queue_size: getQueueSize(),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/admin-api/media', async (req, res) => {
  const result = [];
  try {
    const playlists = await db.getCachedPlaylists();
    for (const p of playlists) {
      const videos = await db.getCachedVideos(p.name);
      result.push({
        playlist: p.name,
        videos: videos.map(v => ({
          filename: v.filename,
          title: v.title,
          size_mb: v.size_mb,
          thumbnail: v.thumbnail,
          vpath: v.vpath,
          vhash: v.vhash,
          url: `/stream/hash/${v.vhash}`,
          playlist: v.playlist,
          duration: v.duration
        }))

      });
    }
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/admin-api/media/:playlist/:filename(*)', async (req, res) => {
  const videoPath = path.join(MEDIA_PATH, req.params.playlist, req.params.filename);
  if (!fs.existsSync(videoPath)) return res.status(404).json({ error: 'File not found' });
  try {
    fs.unlinkSync(videoPath);
    const base = videoPath.replace(/\.[^.]+$/, '');
    for (const ext of IMAGE_EXTENSIONS) {
      const tp = base + ext;
      if (fs.existsSync(tp)) { fs.unlinkSync(tp); break; }
    }
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────
// Media Manager Controls
// ─────────────────────────────────────────────────────────────

router.post('/admin-api/media/scan', async (req, res) => {
  console.log('[Admin-API] Manual scan triggered');
  // Run in background
  scanAll(MEDIA_PATH).catch(e => console.error('[Scanner] Manual scan error:', e));
  res.json({ success: true, message: 'Scan started' });
});

router.get('/admin-api/media/repair-audio/status', (req, res) => {
  res.json({
    running: repairProcess !== null,
    logs: repairLogs
  });
});

router.post('/admin-api/media/repair-audio/start', (req, res) => {
  if (repairProcess) return res.status(400).json({ error: 'Repair already running' });

  console.log('[Admin-API] Starting repair audio process');
  repairLogs = [];
  addRepairLog('Starting repair process...');

  let scriptPath = path.join(__dirname, '..', '..', '..', 'fix_audio.py');
  // Fallback for Docker environment structure
  if (!fs.existsSync(scriptPath)) {
    scriptPath = path.join(__dirname, '..', '..', 'fix_audio.py');
  }
  
  // Use python3 in Docker/Linux, python in Windows
  const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';
  
  repairProcess = spawn(pythonCmd, [scriptPath], {
    env: { ...process.env, MEDIA_PATH }
  });

  repairProcess.stdout.on('data', (data) => {
    const lines = data.toString().split('\n');
    lines.forEach(line => line.trim() && addRepairLog(line));
  });

  repairProcess.stderr.on('data', (data) => {
    addRepairLog(`ERROR: ${data.toString()}`);
  });

  repairProcess.on('close', (code) => {
    addRepairLog(`Process exited with code ${code}`);
    repairProcess = null;
  });

  res.json({ success: true });
});

router.post('/admin-api/media/repair-audio/stop', (req, res) => {
  if (!repairProcess) return res.status(400).json({ error: 'Repair not running' });
  
  addRepairLog('Stopping repair process manually...');
  repairProcess.kill();
  repairProcess = null;
  res.json({ success: true });
});

router.post('/admin-api/media/move', async (req, res) => {
  const { playlist, filename, newPlaylist } = req.body || {};
  if (!playlist || !filename || !newPlaylist) {
    return res.status(400).json({ error: 'Missing parameters' });
  }

  const oldDir = path.join(MEDIA_PATH, playlist);
  const newDir = path.join(MEDIA_PATH, newPlaylist);
  const oldVideoPath = path.join(oldDir, filename);
  const newVideoPath = path.join(newDir, filename);

  if (!fs.existsSync(oldVideoPath)) {
    return res.status(404).json({ error: 'Source file not found' });
  }

  try {
    if (!fs.existsSync(newDir)) {
      fs.mkdirSync(newDir, { recursive: true });
    }

    fs.renameSync(oldVideoPath, newVideoPath);

    const oldBase = oldVideoPath.replace(/\.[^.]+$/, '');
    const newBase = newVideoPath.replace(/\.[^.]+$/, '');
    for (const ext of IMAGE_EXTENSIONS) {
      const oldThumb = oldBase + ext;
      const newThumb = newBase + ext;
      if (fs.existsSync(oldThumb)) {
        fs.renameSync(oldThumb, newThumb);
        break;
      }
    }

    const dbInst = await db.getDb();
    const newVpath = path.relative(MEDIA_PATH, newVideoPath).replace(/\\/g, '/');
    await dbInst.run(`
      UPDATE media_cache 
      SET playlist = ?, vpath = ?
      WHERE playlist = ? AND filename = ?
    `, [newPlaylist, newVpath, playlist, filename]);

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const multer = require('multer');

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(MEDIA_PATH, 'uploads');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const uniqueName = `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`;
    cb(null, uniqueName);
  }
});

const upload = multer({ storage });

router.post('/admin-api/upload', upload.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }
  const relativeUrl = `/uploads/${req.file.filename}`;
  res.json({ success: true, url: relativeUrl });
});

const videoStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const tempDir = path.join(MEDIA_PATH, 'uploads', 'temp');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
    cb(null, tempDir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const uniqueName = `video-${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`;
    cb(null, uniqueName);
  }
});

const uploadVideo = multer({ storage: videoStorage });

router.post('/admin-api/upload-video', uploadVideo.single('file'), async (req, res) => {
  const { playlist } = req.body || {};
  if (!playlist) {
    return res.status(400).json({ error: 'Missing playlist parameter' });
  }
  if (!req.file) {
    return res.status(400).json({ error: 'No video file uploaded' });
  }

  const ext = path.extname(req.file.originalname).toLowerCase();
  const baseName = path.basename(req.file.originalname, ext);
  const destDir = path.join(MEDIA_PATH, playlist);

  if (!fs.existsSync(destDir)) {
    fs.mkdirSync(destDir, { recursive: true });
  }

  const destPath = path.join(destDir, `${baseName}.mp4`);

  if (ext === '.mp4') {
    try {
      let finalDestPath = destPath;
      if (fs.existsSync(destPath)) {
        finalDestPath = path.join(destDir, `${baseName}-${Date.now()}.mp4`);
      }
      fs.renameSync(req.file.path, finalDestPath);
      const scanner = require('../scanner');
      await scanner.scanFolder(MEDIA_PATH, playlist);
      res.json({ success: true, message: '✓ Video uploaded successfully!' });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  } else {
    const { exec } = require('child_process');
    const os = require('os');
    const FFMPEG_PATH = process.env.FFMPEG_BIN || (os.platform() === 'win32' ? path.join(__dirname, '..', '..', 'ffmpeg.exe') : 'ffmpeg');
    
    let finalDestPath = destPath;
    if (fs.existsSync(destPath)) {
      finalDestPath = path.join(destDir, `${baseName}-${Date.now()}.mp4`);
    }

    const cmd = `"${FFMPEG_PATH}" -y -i "${req.file.path}" -c:v libx264 -preset fast -crf 23 -c:a aac -b:a 128k "${finalDestPath}"`;
    
    console.log(`[Transcoder] Starting transcode: ${req.file.originalname} -> ${finalDestPath}`);
    
    res.json({ 
      success: true, 
      message: '✓ Upload received! Converting video to MP4 format in background...' 
    });

    exec(cmd, async (err) => {
      try { fs.unlinkSync(req.file.path); } catch {}
      
      if (err) {
        console.error('[Transcoder] FFmpeg transcode failed:', err.message);
      } else {
        console.log('[Transcoder] Transcode successful:', finalDestPath);
        const scanner = require('../scanner');
        await scanner.scanFolder(MEDIA_PATH, playlist);
      }
    });
  }
});

router.post('/admin-api/create-playlist', uploadVideo.fields([
  { name: 'video', maxCount: 1 },
  { name: 'thumbnail', maxCount: 1 }
]), async (req, res) => {
  const { name } = req.body || {};
  if (!name) {
    return res.status(400).json({ error: 'Playlist name is required' });
  }

  const videoFile = req.files && req.files.video ? req.files.video[0] : null;
  const thumbnailFile = req.files && req.files.thumbnail ? req.files.thumbnail[0] : null;

  if (!videoFile) {
    return res.status(400).json({ error: 'Initial video file is required' });
  }

  const destDir = path.join(MEDIA_PATH, name);
  if (!fs.existsSync(destDir)) {
    fs.mkdirSync(destDir, { recursive: true });
  }

  if (thumbnailFile) {
    const thumbExt = path.extname(thumbnailFile.originalname).toLowerCase();
    const thumbDestPath = path.join(destDir, `thumbnail${thumbExt}`);
    try {
      fs.renameSync(thumbnailFile.path, thumbDestPath);
    } catch (e) {
      console.error('[PlaylistCreator] Error saving thumbnail:', e.message);
    }
  }

  const videoExt = path.extname(videoFile.originalname).toLowerCase();
  const videoBase = path.basename(videoFile.originalname, videoExt);
  const videoDestPath = path.join(destDir, `${videoBase}.mp4`);

  if (videoExt === '.mp4') {
    try {
      fs.renameSync(videoFile.path, videoDestPath);
      const scanner = require('../scanner');
      await scanner.scanFolder(MEDIA_PATH, name);
      res.json({ success: true, message: `✓ Playlist "${name}" created and video uploaded successfully!` });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  } else {
    const { exec } = require('child_process');
    const os = require('os');
    const FFMPEG_PATH = process.env.FFMPEG_BIN || (os.platform() === 'win32' ? path.join(__dirname, '..', '..', 'ffmpeg.exe') : 'ffmpeg');

    const cmd = `"${FFMPEG_PATH}" -y -i "${videoFile.path}" -c:v libx264 -preset fast -crf 23 -c:a aac -b:a 128k "${videoDestPath}"`;

    console.log(`[PlaylistCreator] Starting background transcode for playlist "${name}": ${videoFile.originalname}`);

    res.json({
      success: true,
      message: `✓ Playlist "${name}" created! Video is converting to MP4 format in background...`
    });

    exec(cmd, async (err) => {
      try { fs.unlinkSync(videoFile.path); } catch {}
      if (err) {
        console.error('[PlaylistCreator] FFmpeg transcoding failed:', err.message);
      } else {
        console.log('[PlaylistCreator] Background transcode complete:', videoDestPath);
        const scanner = require('../scanner');
        await scanner.scanFolder(MEDIA_PATH, name);
      }
    });
  }
});

module.exports = { router, setMediaPath };
