'use strict';

/**
 * Media Scanner Module
 * 
 * Periodically scans the physical disk and updates the database cache.
 * This makes library listing instantaneous on the TV.
 */

const fs = require('fs');
const path = require('path');
const db = require('./db');
const { hashVideoPath } = require('./hls');
const { execSync } = require('child_process');

const os = require('os');

// Use system environment variables or local binary (Windows)
const FFPROBE_PATH = process.env.FFPROBE_BIN || (os.platform() === 'win32' ? path.join(__dirname, '..', '..', 'ffprobe.exe') : 'ffprobe');



const VIDEO_EXTENSIONS = new Set(['.mp4', '.mkv', '.avi', '.mov', '.webm']);
const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.JPG', '.PNG', '.JPEG', '.WEBP'];

let isScanning = false;

async function scanAll(mediaPath) {
  if (isScanning) return;
  isScanning = true;
  console.log(`[Scanner] Starting full disk scan in: ${mediaPath}`);

  try {
    const foldersWithVideos = new Set();
    
    function walk(dir, relPath = '') {
      try {
        const items = fs.readdirSync(dir, { withFileTypes: true });
        let hasVideo = false;
        for (const item of items) {
          if (item.isDirectory()) {
            walk(path.join(dir, item.name), path.join(relPath, item.name));
          } else if (item.isFile() && VIDEO_EXTENSIONS.has(path.extname(item.name).toLowerCase())) {
            hasVideo = true;
          }
        }
        if (hasVideo) foldersWithVideos.add(relPath || '.');
      } catch { /* ignore permission errors */ }
    }

    walk(mediaPath);
    const folders = Array.from(foldersWithVideos);

    for (const folder of folders) {
      await scanFolder(mediaPath, folder);
    }

    // Clean up DB: remove any playlists that no longer exist on disk
    const cachedPlaylists = await db.getCachedPlaylists();
    for (const cached of cachedPlaylists) {
      if (!folders.includes(cached.name)) {
        await db.clearOldCache(cached.name);
      }
    }

    console.log('[Scanner] Full scan complete.');
  } catch (e) {
    console.error('[Scanner] Scan error:', e.message);
  } finally {
    isScanning = false;
  }
}

async function scanFolder(mediaPath, folderName) {
  const folderPath = path.join(mediaPath, folderName);
  try {
    const files = fs.readdirSync(folderPath);
    const videos = files.filter(f => VIDEO_EXTENSIONS.has(path.extname(f).toLowerCase()));

    // Clear current cache for this folder before re-inserting
    await db.clearOldCache(folderName);

    for (const v of videos) {
      const vPath = path.join(folderPath, v);
      let stats;
      try { stats = fs.statSync(vPath); } catch { continue; }
      
      const sizeMb = +(stats.size / (1024 * 1024)).toFixed(1);
      const ext = path.extname(v);
      const base = path.basename(v, ext);
      
      let title = base;
      let durationStr = null;
      let customThumb = null;

      // Try to read metadata from info.json
      const jsonPath = path.join(folderPath, `${base}.info.json`);
      if (fs.existsSync(jsonPath)) {
        try {
          const info = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
          if (info.title) title = info.title;
          if (info.duration) durationStr = formatDuration(info.duration);
          
          // Optionally extract a reliable thumbnail from json if local image is missing
          // But local image check comes next anyway.
        } catch (e) {
          console.error(`[Scanner] Error reading JSON for ${v}:`, e.message);
        }
      }
      
      // Find thumbnail: flexible matching
      let thumb = null;
      const baseNoExt = v.slice(0, v.lastIndexOf('.'));
      
      // Look for any image file that starts with the video name
      const possibleThumbs = files.filter(f => {
        const fLower = f.toLowerCase();
        const isImg = IMAGE_EXTENSIONS.some(ie => fLower.endsWith(ie.toLowerCase()));
        return isImg && (f.startsWith(baseNoExt) || f.startsWith(v));
      });

      if (possibleThumbs.length > 0) {
        // Prefer the one that matches exactly or is .temp.temp.jpg
        const bestThumb = possibleThumbs.find(t => t.includes('.temp.temp') || t.startsWith(v)) || possibleThumbs[0];
        
        // Encode each path segment individually so slashes are preserved
        const safeFolder = folderName.split(/[/\\]/).map(encodeURIComponent).join('/');
        thumb = `/images/${safeFolder}/${encodeURIComponent(bestThumb)}`;
      }

      const hash = hashVideoPath(vPath);
      const duration = durationStr || getDuration(vPath);
      
      await db.updateMediaCache(
        vPath,
        folderName,
        v,
        title, // Use title extracted from JSON (or base fallback)
        thumb,
        duration,
        sizeMb,
        hash
      );

    }
  } catch (e) {
    console.error(`[Scanner] Error scanning folder ${folderName}:`, e.message);
  }
}

function startAutoScanner(mediaPath, intervalMins = 30) {
  // Initial scan
  scanAll(mediaPath);

  // Periodic scan
  setInterval(() => scanAll(mediaPath), intervalMins * 60 * 1000);
}

function getDuration(videoPath) {
  try {
    const cmd = `"${FFPROBE_PATH}" -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${videoPath}"`;
    const seconds = parseFloat(execSync(cmd, { timeout: 5000 }).toString().trim());
    return formatDuration(seconds);
  } catch (e) {
    return null;
  }
}

function formatDuration(seconds) {
  if (isNaN(seconds)) return null;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

module.exports = { startAutoScanner, scanFolder, scanAll };

