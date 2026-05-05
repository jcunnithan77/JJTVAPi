'use strict';

/**
 * Simple Log Capturer
 * Stores the last N lines of logs in memory and broadcasts them to listeners.
 */

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const LOG_FILE = path.join(__dirname, '..', '..', 'jjtv_node.log');
const MAX_MEMORY_LINES = 500;
const logBuffer = [];
const emitter = new EventEmitter();
emitter.setMaxListeners(0); // Unlimited listeners for SSE connections

// Clear log file on startup
fs.writeFileSync(LOG_FILE, '');

function setupLogger() {
  const originalLog = console.log;
  const originalError = console.error;

  console.log = (...args) => {
    const msg = `[${new Date().toLocaleTimeString()}] ${args.join(' ')}`;
    _log(msg);
    originalLog.apply(console, args);
  };

  console.warn = (...args) => {
    const msg = `[${new Date().toLocaleTimeString()}] WARN: ${args.join(' ')}`;
    _log(msg);
    originalLog.apply(console, args);
  };

  console.error = (...args) => {
    const msg = `[${new Date().toLocaleTimeString()}] ERROR: ${args.join(' ')}`;
    _log(msg);
    originalError.apply(console, args);
  };
}

function _log(msg) {
  // Push to buffer
  logBuffer.push(msg);
  if (logBuffer.length > MAX_MEMORY_LINES) logBuffer.shift();

  // Write to file
  try {
    fs.appendFileSync(LOG_FILE, msg + '\n');
  } catch { /* ignore */ }

  // Broadcast to SSE listeners
  emitter.emit('log', msg);
}

function getRecentLogs() {
  return logBuffer;
}

function onLog(callback) {
  emitter.on('log', callback);
}

function offLog(callback) {
  emitter.off('log', callback);
}

module.exports = { setupLogger, getRecentLogs, onLog, offLog };
