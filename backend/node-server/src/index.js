'use strict';

/**
 * JJtv Node.js Server
 * 
 * High-concurrency media streaming backend for Android TV.
 * Features:
 *   - Non-blocking I/O via Node.js event loop
 *   - Fast SQLite integration (better-sqlite3)
 *   - On-demand HLS segmentation (FFmpeg)
 *   - HTTP Range streaming for direct video playback
 *   - YouTube downloading and scheduling
 */

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { setupLogger } = require('./logger');
setupLogger(); // Intercept console output for live streaming

const db = require('./db');
const { startScheduler } = require('./scheduler');
const { startAutoScanner } = require('./scanner');
const tvRoutes = require('./routes/tv');
const adminRoutes = require('./routes/admin');

const app = express();
const PORT = process.env.PORT || 5000;

// ─────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────
let MEDIA_PATH = process.env.MEDIA_PATH || path.join(__dirname, '..', '..', 'videos');
const CONFIG_FILE = process.env.CONFIG_PATH || path.join(__dirname, '..', '..', 'config.json');

if (fs.existsSync(CONFIG_FILE)) {
  try {
    const configData = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    if (configData.media_path) {
      MEDIA_PATH = configData.media_path;
    }
  } catch (e) {
    console.error('[Config] Error loading config.json:', e.message);
  }
}

if (!fs.existsSync(MEDIA_PATH)) {
  fs.mkdirSync(MEDIA_PATH, { recursive: true });
}

console.log(`[Config] Media Path: ${path.resolve(MEDIA_PATH)}`);

// ─────────────────────────────────────────────────────────────
// Middleware
// ─────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());

// Set media path in route modules
tvRoutes.setMediaPath(MEDIA_PATH);
adminRoutes.setMediaPath(MEDIA_PATH);

// ─────────────────────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────────────────────

// 1. Static Files (High Priority)
const STATIC_PATH = process.env.STATIC_PATH || path.join(__dirname, '..', '..', 'static', 'browser');

// Direct file access for logs
app.get('/admin/logs', (req, res) => {
  res.sendFile(path.join(STATIC_PATH, 'logs.html'));
});

// Serve static assets from /admin/
app.use('/admin', express.static(STATIC_PATH));

// 2. Redirects
app.get('/', (req, res) => res.redirect('/admin/'));

// 3. API Routes
app.use('/', tvRoutes.router);
app.use('/', adminRoutes.router);

// 4. Angular Catch-all (Lowest Priority)
app.get('/admin/*', (req, res) => {
  res.sendFile(path.join(STATIC_PATH, 'index.html'));
});

// ─────────────────────────────────────────────────────────────
// Initialization
// ─────────────────────────────────────────────────────────────
(async () => {
  try {
    await db.initDb();
    startScheduler(MEDIA_PATH);
    startAutoScanner(MEDIA_PATH);

    app.listen(PORT, '0.0.0.0', () => {
      console.log(`\n🚀 JJtv Server (Node.js) is running on:`);
      console.log(`   - Local:  http://localhost:${PORT}`);
      console.log(`   - Network: http://0.0.0.0:${PORT}\n`);
      console.log('Press Ctrl+C to stop.');
    });
  } catch (err) {
    console.error('[Fatal] Failed to start server:', err);
    process.exit(1);
  }
})();
