import os
import hashlib
import sqlite3
import threading
import queue
import time
import datetime
import subprocess
import shutil
import mimetypes
import uuid
from flask import Flask, jsonify, send_file, request, send_from_directory, abort, Response, stream_with_context
from flask_cors import CORS
import yt_dlp
from yt_dlp.utils import sanitize_filename
import json
import urllib.parse
from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.date import DateTrigger

app = Flask(__name__, static_folder='static')
CORS(app)

MEDIA_PATH = os.environ.get('MEDIA_PATH', './videos')
CONFIG_FILE = 'config.json'
if os.path.exists(CONFIG_FILE):
    try:
        with open(CONFIG_FILE, 'r') as f:
            config_data = json.load(f)
            if 'media_path' in config_data:
                MEDIA_PATH = config_data['media_path']
    except Exception as e:
        print(f"Error loading config.json: {e}")

HLS_CACHE_PATH = os.path.join(os.getcwd(), 'hls_cache')
if not os.path.exists(HLS_CACHE_PATH):
    os.makedirs(HLS_CACHE_PATH)

if not os.path.exists(MEDIA_PATH):
    os.makedirs(MEDIA_PATH, exist_ok=True)

DB_PATH = 'jjtv_config.db'
VIDEO_EXTENSIONS = {'.mp4', '.mkv', '.avi', '.mov', '.webm'}

# Global state
active_downloads = {}
download_queue = queue.Queue()
video_hash_map = {}  # hash -> video_path
HLS_CACHE_PATH = 'hls_cache'

# APScheduler
scheduler = BackgroundScheduler(daemon=True)

# --- DATABASE SETUP ---
def init_db():
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    # Settings: key-val
    c.execute('''CREATE TABLE IF NOT EXISTS settings
                 (key TEXT PRIMARY KEY, value TEXT)''')
    # Schedules: playlist_name -> start_time, end_time, priority, min_duration, watch_limit
    c.execute('''CREATE TABLE IF NOT EXISTS schedules
                 (playlist TEXT PRIMARY KEY,
                  start_time TEXT,
                  end_time TEXT,
                  lock_message TEXT DEFAULT '',
                  lock_audio TEXT DEFAULT '',
                  priority INTEGER DEFAULT 0,
                  min_duration INTEGER DEFAULT 0,
                  watch_limit INTEGER DEFAULT 3)''')
    # Migrate old schema: add columns if missing
    for col, col_def in [
        ('lock_message', 'TEXT DEFAULT ""'),
        ('lock_audio',   'TEXT DEFAULT ""'),
        ('priority',     'INTEGER DEFAULT 0'),
        ('min_duration', 'INTEGER DEFAULT 0'),
        ('watch_limit',  'INTEGER DEFAULT 3'),
    ]:
        try:
            c.execute(f'ALTER TABLE schedules ADD COLUMN {col} {col_def}')
        except Exception:
            pass  # column already exists
    # Daily playlist progress for quota tracking
    c.execute('''CREATE TABLE IF NOT EXISTS daily_playlist_progress
                 (playlist TEXT,
                  date TEXT,
                  watched_duration INTEGER DEFAULT 0,
                  completed INTEGER DEFAULT 0,
                  PRIMARY KEY (playlist, date))''')
    # Scheduled downloads
    c.execute('''CREATE TABLE IF NOT EXISTS scheduled_downloads
                 (id TEXT PRIMARY KEY,
                  url TEXT NOT NULL,
                  playlist TEXT NOT NULL,
                  scheduled_at TEXT NOT NULL,
                  status TEXT DEFAULT 'pending',
                  created_at TEXT DEFAULT CURRENT_TIMESTAMP)''')
    # Overlay config
    c.execute('''CREATE TABLE IF NOT EXISTS overlay_config
                 (key TEXT PRIMARY KEY, value TEXT)''')

    # Set defaults if empty
    c.execute("INSERT OR IGNORE INTO settings (key, value) VALUES ('sleep_start', '22:00')")
    c.execute("INSERT OR IGNORE INTO settings (key, value) VALUES ('sleep_end', '06:00')")
    c.execute("INSERT OR IGNORE INTO settings (key, value) VALUES ('force_sleep', 'false')")

    # Overlay defaults
    c.execute("INSERT OR IGNORE INTO overlay_config (key, value) VALUES ('enabled', 'false')")
    c.execute("INSERT OR IGNORE INTO overlay_config (key, value) VALUES ('banner_text', 'Welcome to JJtv!')")
    c.execute("INSERT OR IGNORE INTO overlay_config (key, value) VALUES ('music_url', '')")
    c.execute("INSERT OR IGNORE INTO overlay_config (key, value) VALUES ('music_volume', '0.3')")
    c.execute("INSERT OR IGNORE INTO overlay_config (key, value) VALUES ('banner_position', 'bottom')")
    c.execute("INSERT OR IGNORE INTO overlay_config (key, value) VALUES ('banner_color', '#1a1a2e')")
    conn.commit()
    conn.close()

init_db()

def get_db_connection():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

# --- SYSTEM LOGIC ---
def is_system_asleep():
    conn = get_db_connection()
    c = conn.cursor()
    c.execute("SELECT * FROM settings")
    settings = {row['key']: row['value'] for row in c.fetchall()}
    conn.close()

    if settings.get('force_sleep') == 'true':
        return True

    start_str = settings.get('sleep_start', '22:00')
    end_str = settings.get('sleep_end', '06:00')

    try:
        now = datetime.datetime.now().time()
        start = datetime.datetime.strptime(start_str, "%H:%M").time()
        end = datetime.datetime.strptime(end_str, "%H:%M").time()

        if start < end:
            return start <= now <= end
        else:  # Crosses midnight
            return now >= start or now <= end
    except:
        return False

def get_today():
    return datetime.datetime.now().strftime('%Y-%m-%d')


def get_priority_display_mode():
    """Returns ('all', None) | ('priority', [playlist,...]) | ('fallback', {scheduled_set})"""
    conn = get_db_connection()
    schedules = conn.execute(
        """SELECT * FROM schedules
           WHERE (start_time IS NOT NULL AND start_time != '')
              OR (min_duration IS NOT NULL AND min_duration > 0)
           ORDER BY priority DESC"""
    ).fetchall()

    if not schedules:
        conn.close()
        return ('all', None)

    now = datetime.datetime.now().time()
    today = get_today()

    active_priority = []
    scheduled_names = set()

    for s in schedules:
        playlist = s['playlist']
        start_str = s['start_time'] or ''
        end_str = s['end_time'] or ''
        min_dur = s['min_duration'] or 0

        in_window = False
        if start_str and end_str:
            try:
                start = datetime.datetime.strptime(start_str, "%H:%M").time()
                end = datetime.datetime.strptime(end_str, "%H:%M").time()
                if start < end:
                    in_window = (start <= now <= end)
                else:
                    in_window = (now >= start or now <= end)
            except:
                pass
            scheduled_names.add(playlist)
        elif min_dur > 0:
            # No time window but has a quota — always active until quota met
            in_window = True

        if in_window:
            active_priority.append(s)

    if not active_priority:
        conn.close()
        return ('all', None)

    # Check completion for each active priority playlist (highest priority first)
    remaining = []
    for s in active_priority:
        playlist = s['playlist']
        min_dur_mins = s['min_duration'] or 0

        row = conn.execute(
            "SELECT watched_duration, completed FROM daily_playlist_progress WHERE playlist=? AND date=?",
            (playlist, today)
        ).fetchone()

        if row:
            if row['completed']:
                continue  # Already done today
            if min_dur_mins > 0 and row['watched_duration'] >= min_dur_mins * 60:
                # Mark completed
                conn.execute(
                    "UPDATE daily_playlist_progress SET completed=1 WHERE playlist=? AND date=?",
                    (playlist, today)
                )
                conn.commit()
                continue

        remaining.append(playlist)

    conn.close()

    if not remaining:
        # All priority playlists done — show everything except scheduled ones
        return ('fallback', scheduled_names)

    # Show only the SINGLE highest-priority uncompleted playlist
    return ('priority', [remaining[0]])


def is_playlist_allowed(playlist_name):
    mode, data = get_priority_display_mode()
    if mode == 'all':
        return True
    if mode == 'priority':
        return playlist_name in data
    if mode == 'fallback':
        return playlist_name not in data
    return True


def record_watch_time(playlist, seconds):
    """Add seconds to today's watched_duration for a playlist."""
    today = get_today()
    conn = get_db_connection()
    conn.execute(
        """INSERT INTO daily_playlist_progress (playlist, date, watched_duration, completed)
           VALUES (?, ?, ?, 0)
           ON CONFLICT(playlist, date) DO UPDATE SET watched_duration = watched_duration + ?""",
        (playlist, today, seconds, seconds)
    )
    conn.commit()
    conn.close()

# --- DOWNLOADER WORKER ---
def _do_download(url, target_playlist, job_id):
    """Core download logic — called both by queue worker and scheduler."""
    active_downloads[job_id] = {"status": "downloading", "percent": 0, "title": "Initializing...", "playlist": target_playlist}

    target_dir = os.path.join(MEDIA_PATH, sanitize_filename(target_playlist))
    os.makedirs(target_dir, exist_ok=True)

    # Fetch metadata / folder thumbnail
    try:
        with yt_dlp.YoutubeDL({'quiet': True}) as ydl:
            info = ydl.extract_info(url, download=False)
            if not any(f.endswith(('.jpg', '.png', '.jpeg', '.webp')) for f in os.listdir(target_dir)):
                thumb_url = info.get('thumbnail')
                if thumb_url:
                    try:
                        with yt_dlp.YoutubeDL({'outtmpl': os.path.join(target_dir, 'folder.jpg'), 'quiet': True}) as ydl_thumb:
                            ydl_thumb.download([thumb_url])
                    except:
                        pass
    except:
        pass

    def progress_hook(d):
        if d['status'] == 'downloading':
            percent_str = d.get('_percent_str', '0%').replace('\x1b[0;94m', '').replace('\x1b[0m', '').replace('%', '').strip()
            try:
                p = float(percent_str)
            except:
                p = 0

            title = "Video"
            if d.get('info_dict'):
                title = d['info_dict'].get('title', 'Video')
                p_index = d['info_dict'].get('playlist_index')
                p_count = d['info_dict'].get('playlist_count')
                if p_index and p_count:
                    title = f"[{p_index}/{p_count}] {title}"

            active_downloads[job_id]['percent'] = p
            active_downloads[job_id]['title'] = title
        elif d['status'] == 'finished':
            active_downloads[job_id]['percent'] = 100
            active_downloads[job_id]['status'] = 'processing'

    local_ffmpeg = os.path.join(os.getcwd(), 'ffmpeg.exe')

    ydl_opts = {
        'format': 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
        'outtmpl': os.path.join(target_dir, '%(title)s.%(ext)s'),
        'merge_output_format': 'mp4',
        'writethumbnail': True,
        'progress_hooks': [progress_hook],
        'ignoreerrors': True,
        'nooverwrites': True,
        'sleep_interval': 1,
        'max_sleep_interval': 3,
        'ffmpeg_location': local_ffmpeg if os.path.exists(local_ffmpeg) else None,
        'postprocessors': [
            {'key': 'FFmpegVideoConvertor', 'preferedformat': 'mp4'},
            {'key': 'FFmpegThumbnailsConvertor', 'format': 'jpg'}
        ],
    }

    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            ydl.download([url])

        DEFAULT_THUMB_SOURCE = 'default_thumb.jpg'
        if os.path.exists(target_dir):
            for f in os.listdir(target_dir):
                f_path = os.path.join(target_dir, f)
                if os.path.isfile(f_path):
                    ext = os.path.splitext(f)[1].lower()
                    if ext in VIDEO_EXTENSIONS:
                        base_name = os.path.splitext(f)[0]
                        has_thumb = False
                        for img_ext in ['.jpg', '.jpeg', '.png', '.webp']:
                            if os.path.exists(os.path.join(target_dir, base_name + img_ext)):
                                has_thumb = True
                                break
                        if not has_thumb and os.path.exists(DEFAULT_THUMB_SOURCE):
                            shutil.copy(DEFAULT_THUMB_SOURCE, os.path.join(target_dir, base_name + '.jpg'))
                            print(f"Assigned default thumbnail to {f}")

        active_downloads[job_id]['status'] = 'completed'
    except Exception as e:
        print(f"DL Error: {e}")
        active_downloads[job_id]['status'] = 'error'
        active_downloads[job_id]['error_msg'] = str(e)


def download_worker():
    while True:
        job = download_queue.get()
        if job is None:
            break
        _do_download(job['url'], job['playlist'], job['id'])
        download_queue.task_done()


# Scheduled download trigger function
def run_scheduled_download(job_db_id, url, playlist):
    job_id = f"sched_{job_db_id}"
    # Update DB status to running
    try:
        conn = get_db_connection()
        conn.execute("UPDATE scheduled_downloads SET status='running' WHERE id=?", (job_db_id,))
        conn.commit()
        conn.close()
    except:
        pass

    _do_download(url, playlist, job_id)

    # Update DB status to completed/error
    try:
        final_status = active_downloads.get(job_id, {}).get('status', 'completed')
        conn = get_db_connection()
        conn.execute("UPDATE scheduled_downloads SET status=? WHERE id=?", (final_status, job_db_id))
        conn.commit()
        conn.close()
    except:
        pass


def load_pending_scheduled_jobs():
    """On startup, reload pending scheduled jobs into APScheduler."""
    conn = get_db_connection()
    rows = conn.execute("SELECT * FROM scheduled_downloads WHERE status='pending'").fetchall()
    conn.close()
    now = datetime.datetime.now()
    for row in rows:
        try:
            run_at = datetime.datetime.fromisoformat(row['scheduled_at'])
            if run_at > now:
                scheduler.add_job(
                    run_scheduled_download,
                    trigger=DateTrigger(run_date=run_at),
                    args=[row['id'], row['url'], row['playlist']],
                    id=f"sched_{row['id']}"
                )
                print(f"Re-scheduled download {row['id']} at {run_at}")
            else:
                # Overdue — run immediately
                threading.Thread(
                    target=run_scheduled_download,
                    args=(row['id'], row['url'], row['playlist']),
                    daemon=True
                ).start()
        except Exception as e:
            print(f"Error loading scheduled job {row['id']}: {e}")


# Start background threads
threading.Thread(target=download_worker, daemon=True).start()
scheduler.start()
load_pending_scheduled_jobs()

# --- TV APP Endpoints ---
IMAGE_EXTENSIONS = {'.jpg', '.jpeg', '.png', '.webp'}


def get_video_files(directory):
    videos = []
    if os.path.isdir(directory):
        for f in os.listdir(directory):
            if os.path.isfile(os.path.join(directory, f)):
                ext = os.path.splitext(f)[1].lower()
                if ext in VIDEO_EXTENSIONS:
                    videos.append(f)
    return sorted(videos)


def get_thumbnail(directory, video_filename=None):
    if not os.path.isdir(directory):
        return None

    if video_filename:
        base_name = os.path.splitext(video_filename)[0]
        for ext in IMAGE_EXTENSIONS:
            thumb_name = base_name + ext
            if os.path.isfile(os.path.join(directory, thumb_name)):
                return thumb_name
    else:
        for f in os.listdir(directory):
            if os.path.isfile(os.path.join(directory, f)):
                ext = os.path.splitext(f)[1].lower()
                if ext in IMAGE_EXTENSIONS:
                    return f
    return None


import threading

def _generate_duration_cache(filepath, cache_file, local_ffprobe):
    try:
        cmd = [
            local_ffprobe,
            '-v', 'error',
            '-show_entries', 'format=duration',
            '-of', 'default=noprint_wrappers=1:nokey=1',
            filepath
        ]
        result = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        seconds = float(result.stdout.strip())
        d = datetime.timedelta(seconds=int(seconds))
        parts = str(d).split(':')
        
        formatted_duration = ""
        if parts[0] == '0':
            formatted_duration = f"{int(parts[1])}:{parts[2]}"
        else:
            formatted_duration = str(d)
            
        try:
            with open(cache_file, 'w') as f:
                f.write(formatted_duration)
        except:
            pass
    except:
        pass

def get_video_duration(filepath):
    local_ffprobe = os.path.join(os.getcwd(), 'ffprobe.exe')
    if not os.path.exists(local_ffprobe):
        return None
        
    cache_file = filepath + ".duration"
    if os.path.exists(cache_file):
        try:
            with open(cache_file, 'r') as f:
                return f.read().strip()
        except:
            pass

    # If the cache doesn't exist, generate it in the background to avoid blocking the TV UI.
    # The first time the video loads it will not have a duration displayed, but subsequent times it will.
    threading.Thread(target=_generate_duration_cache, args=(filepath, cache_file, local_ffprobe), daemon=True).start()
    return None


@app.route('/api/playlists', methods=['GET'])
def list_playlists():
    if is_system_asleep():
        return jsonify([])

    playlists = []
    try:
        items = os.listdir(MEDIA_PATH)
        for item in items:
            item_path = os.path.join(MEDIA_PATH, item)
            if os.path.isdir(item_path):
                if is_playlist_allowed(item):
                    videos = get_video_files(item_path)
                    if videos:
                        thumb = get_thumbnail(item_path)
                        playlists.append({
                            'id': item,
                            'name': item,
                            'count': len(videos),
                            'thumbnail': f'/images/{urllib.parse.quote(item)}/{urllib.parse.quote(thumb)}' if thumb else None
                        })
    except Exception as e:
        return jsonify({'error': str(e)}), 500
    return jsonify(sorted(playlists, key=lambda x: x['name']))


@app.route('/api/playlists/<path:playlist_id>', methods=['GET'])
def get_playlist(playlist_id):
    if is_system_asleep() or not is_playlist_allowed(playlist_id):
        abort(403)

    playlist_path = os.path.join(MEDIA_PATH, playlist_id)
    if not os.path.isdir(playlist_path):
        return jsonify({'error': 'Playlist not found'}), 404

    videos = get_video_files(playlist_path)
    video_list = []
    for v in videos:
        v_path = os.path.join(playlist_path, v)
        thumb = get_thumbnail(playlist_path, v)
        # Skip duration calculation in the main loop to prevent timeouts on large folders
        # duration = get_video_duration(v_path) 
        video_hash = hashlib.md5(v_path.encode()).hexdigest()
        video_hash_map[video_hash] = v_path
        
        video_list.append({
            'filename': v,
            'title': os.path.splitext(v)[0],
            'url': f'/stream/{urllib.parse.quote(playlist_id)}/{urllib.parse.quote(v)}',
            'hls_url': f'/hls/stream/{video_hash}/index.m3u8',
            'thumbnail': f'/images/{urllib.parse.quote(playlist_id)}/{urllib.parse.quote(thumb)}' if thumb else None,
            'duration': None, # Durations are slow to calculate, skip for now
            'vhash': video_hash,
            'playlist': playlist_id,
            'demoted': False
        })
    return jsonify({'id': playlist_id, 'name': playlist_id, 'videos': video_list})


@app.route('/images/<playlist_id>/<filename>', methods=['GET'])
def serve_image(playlist_id, filename):
    image_path = os.path.join(MEDIA_PATH, playlist_id, filename)
    if not os.path.isfile(image_path):
        abort(404)
    mimetype, _ = mimetypes.guess_type(image_path)
    return send_file(image_path, mimetype=mimetype or 'image/jpeg')


def generate_range(path, start, end, chunk_size=1024*1024):
    """Generator for streaming a file in chunks for better network stability."""
    with open(path, 'rb') as f:
        f.seek(start)
        remaining = end - start + 1
        while remaining > 0:
            chunk = f.read(min(chunk_size, remaining))
            if not chunk:
                break
            remaining -= len(chunk)
            yield chunk


@app.route('/stream/<playlist_id>/<path:filename>', methods=['GET'])
def stream_video(playlist_id, filename):
    if is_system_asleep() or not is_playlist_allowed(playlist_id):
        abort(403)

    video_path = os.path.join(MEDIA_PATH, playlist_id, filename)
    if not os.path.isfile(video_path):
        return "File not found", 404

    file_size = os.path.getsize(video_path)
    range_header = request.headers.get('Range', None)
    mimetype, _ = mimetypes.guess_type(video_path)
    mimetype = mimetype or 'video/mp4'

    if not range_header:
        # Standard full-file request
        return send_file(video_path, mimetype=mimetype, conditional=True)

    # Manual Range Request handling (mimics production servers like Nginx)
    try:
        # Parse 'bytes=start-end'
        byte_range = range_header.replace('bytes=', '').split('-')
        start = int(byte_range[0])
        end = int(byte_range[1]) if (len(byte_range) > 1 and byte_range[1]) else file_size - 1
    except (ValueError, IndexError):
        return "Invalid Range Header", 416

    if start >= file_size or end >= file_size:
        return "Range Not Satisfiable", 416

    # Create chunked response
    response = Response(
        stream_with_context(generate_range(video_path, start, end)),
        status=206,
        mimetype=mimetype,
        direct_passthrough=True
    )
    response.headers.add('Content-Range', f'bytes {start}-{end}/{file_size}')
    response.headers.add('Accept-Ranges', 'bytes')
    response.headers.add('Content-Length', str(end - start + 1))
    return response


# HLS Streaming Logic
def start_hls_conversion(video_path, cache_dir):
    """Run FFmpeg to segment the video for HLS if not already done."""
    local_ffmpeg = os.path.join(os.getcwd(), 'ffmpeg.exe')
    playlist_path = os.path.join(cache_dir, 'index.m3u8')
    
    if os.path.exists(playlist_path):
        return True

    cmd = [
        local_ffmpeg,
        '-i', video_path,
        '-codec:', 'copy',
        '-start_number', '0',
        '-hls_time', '6',
        '-hls_list_size', '0',
        '-f', 'hls',
        playlist_path
    ]
    try:
        # We run this synchronously for the first request, but since it's just 'copy', it's very fast.
        subprocess.run(cmd, check=True, capture_output=True)
        return True
    except Exception as e:
        print(f"HLS Conversion Error: {e}")
        return False


@app.route('/hls/stream/<vhash>/index.m3u8', methods=['GET'])
def get_hls_playlist_by_hash(vhash):
    cache_dir = os.path.join(HLS_CACHE_PATH, vhash)
    playlist_path = os.path.join(cache_dir, 'index.m3u8')
    
    # If cache missing, try to recover from map
    if not os.path.exists(playlist_path):
        video_path = video_hash_map.get(vhash)
        if not video_path:
            abort(404)
        
        os.makedirs(cache_dir, exist_ok=True)
        if not start_hls_conversion(video_path, cache_dir):
            abort(500)
    
    # Wait up to 3 seconds for index.m3u8 to be written if it was just started
    for _ in range(30):
        if os.path.exists(playlist_path):
            break
        time.sleep(0.1)
    else:
        abort(404)

    response = send_from_directory(cache_dir, 'index.m3u8')
    response.headers['Content-Type'] = 'application/vnd.apple.mpegurl'
    # Disable caching for the manifest to ensure updates are seen
    response.headers['Cache-Control'] = 'no-cache, no-store, must-revalidate'
    return response


@app.route('/hls/stream/<vhash>/<segment>', methods=['GET'])
def serve_hls_segment_by_hash(vhash, segment):
    cache_dir = os.path.join(HLS_CACHE_PATH, vhash)
    if not segment.endswith('.ts'):
        abort(404)
    return send_from_directory(cache_dir, segment)


@app.route('/api/search', methods=['GET'])
def local_search():
    query = request.args.get('q', '').lower().strip()
    if not query:
        return jsonify([])
        
    results = []
    try:
        for playlist in sorted(os.listdir(MEDIA_PATH)):
            playlist_path = os.path.join(MEDIA_PATH, playlist)
            if os.path.isdir(playlist_path) and is_playlist_allowed(playlist):
                videos = get_video_files(playlist_path)
                for v in videos:
                    if query in v.lower():
                        v_path = os.path.join(playlist_path, v)
                        thumb = get_thumbnail(playlist_path, v)
                        duration = get_video_duration(v_path)
                        video_hash = hashlib.md5(v_path.encode()).hexdigest()
                        video_hash_map[video_hash] = v_path
                        
                        results.append({
                            'id': v,
                            'title': os.path.splitext(v)[0],
                            'channel': playlist,
                            'duration': duration or "",
                            'thumbnail': f'/images/{urllib.parse.quote(playlist)}/{urllib.parse.quote(thumb)}' if thumb else "",
                            'url': f'/stream/{urllib.parse.quote(playlist)}/{urllib.parse.quote(v)}',
                            'hls_url': f'/hls/stream/{video_hash}/index.m3u8',
                            'vhash': video_hash
                        })
    except Exception as e:
        print(f"Search Error: {e}")
        return jsonify({'error': str(e)}), 500
        
    return jsonify(results)


# TV Overlay endpoint
@app.route('/api/overlay', methods=['GET'])
def get_tv_overlay():
    conn = get_db_connection()
    cfg = {row['key']: row['value'] for row in conn.execute("SELECT * FROM overlay_config")}
    conn.close()
    return jsonify(cfg)


@app.route('/api/video/watched', methods=['POST'])
def record_video_watched():
    """Called by the Android TV app when a video finishes playing."""
    data = request.json or {}
    vhash = data.get('vhash', '').strip()
    playlist = data.get('playlist', '').strip()

    if not vhash:
        return jsonify({'success': False, 'error': 'vhash required'}), 400

    conn = get_db_connection()
    conn.execute('''CREATE TABLE IF NOT EXISTS watched_videos
                    (vhash TEXT PRIMARY KEY, playlist TEXT, watch_count INTEGER DEFAULT 0,
                     last_watched TEXT DEFAULT CURRENT_TIMESTAMP)''')
    existing = conn.execute("SELECT watch_count FROM watched_videos WHERE vhash=?", (vhash,)).fetchone()
    if existing:
        new_count = existing['watch_count'] + 1
        conn.execute("UPDATE watched_videos SET watch_count=?, last_watched=CURRENT_TIMESTAMP WHERE vhash=?",
                     (new_count, vhash))
    else:
        new_count = 1
        conn.execute("INSERT INTO watched_videos (vhash, playlist, watch_count) VALUES (?,?,1)",
                     (vhash, playlist))
    conn.commit()
    conn.close()

    return jsonify({'success': True, 'watch_count': new_count, 'rotation_reset': False})



@app.route('/api/status', methods=['GET'])
def get_system_status():
    """Used by the Android TV app to check lock state and streaming config."""
    locked = is_system_asleep()

    # Read lock screen overlay settings
    conn = get_db_connection()
    settings = {row['key']: row['value'] for row in conn.execute("SELECT * FROM settings")}
    conn.close()

    lock_message = settings.get('lock_message', 'Time for bed!')
    lock_audio = settings.get('lock_audio', '')
    lock_image = settings.get('lock_image', '')

    # Determine the LAN IP of this machine so the TV can stream via local network
    lan_ip = ''
    stream_through_lan = True  # Always prefer LAN for video streaming
    try:
        import socket
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(('8.8.8.8', 80))
        lan_ip = s.getsockname()[0]
        s.close()
        # Build full URL with port so the Android app can use it directly
        lan_ip = f'http://{lan_ip}:5000'
    except Exception:
        stream_through_lan = False

    return jsonify({
        'locked': locked,
        'message': lock_message if locked else '',
        'audio': lock_audio if locked else '',
        'image': lock_image if locked else '',
        'stream_through_lan': stream_through_lan,
        'lan_ip': lan_ip
    })


# --- ADMIN API Endpoints ---
@app.route('/admin')
@app.route('/admin/')
def admin_root():
    return send_from_directory('static', 'index.html')


@app.route('/admin/<path:path>')
def admin_static(path):
    static_file = os.path.join('static', path)
    if os.path.isfile(static_file):
        return send_from_directory('static', path)
    return send_from_directory('static', 'index.html')


@app.route('/admin-api/settings', methods=['GET', 'POST'])
def manage_settings():
    conn = get_db_connection()
    if request.method == 'POST':
        data = request.json
        c = conn.cursor()
        for k, v in data.items():
            c.execute("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", (k, str(v).lower()))
        conn.commit()

    settings = {row['key']: row['value'] for row in conn.execute("SELECT * FROM settings")}
    conn.close()
    return jsonify(settings)


@app.route('/admin-api/schedules', methods=['GET', 'POST'])
def manage_schedules():
    conn = get_db_connection()
    if request.method == 'POST':
        data = request.json
        c = conn.cursor()
        playlist = data.get('playlist')
        start = data.get('start_time', '')
        end = data.get('end_time', '')
        lock_message = data.get('lock_message', '')
        lock_audio = data.get('lock_audio', '')
        priority = int(data.get('priority', 0) or 0)
        min_duration = int(data.get('min_duration', 0) or 0)
        watch_limit = int(data.get('watch_limit', 3) or 3)
        c.execute(
            """INSERT OR REPLACE INTO schedules
               (playlist, start_time, end_time, lock_message, lock_audio, priority, min_duration, watch_limit)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (playlist, start, end, lock_message, lock_audio, priority, min_duration, watch_limit)
        )
        conn.commit()

    schedules = {
        row['playlist']: {
            'start_time':   row['start_time'],
            'end_time':     row['end_time'],
            'lock_message': row['lock_message'] or '',
            'lock_audio':   row['lock_audio'] or '',
            'priority':     row['priority'] or 0,
            'min_duration': row['min_duration'] or 0,
            'watch_limit':  row['watch_limit'] if row['watch_limit'] is not None else 3,
        }
        for row in conn.execute("SELECT * FROM schedules")
    }

    # Add root-level folders that have no schedule yet
    try:
        items = os.listdir(MEDIA_PATH)
        for f in sorted(items):
            if os.path.isdir(os.path.join(MEDIA_PATH, f)) and f not in schedules:
                schedules[f] = {
                    'start_time': '', 'end_time': '',
                    'lock_message': '', 'lock_audio': '',
                    'priority': 0, 'min_duration': 0, 'watch_limit': 3
                }
    except:
        pass

    conn.close()
    return jsonify(schedules)


@app.route('/admin-api/schedules/<path:playlist>', methods=['DELETE'])
def delete_schedule(playlist):
    conn = get_db_connection()
    conn.execute("DELETE FROM schedules WHERE playlist=?", (playlist,))
    conn.commit()
    conn.close()
    return jsonify({'success': True})


@app.route('/admin-api/force-reload', methods=['POST'])
def force_reload():
    """Clears daily progress so all priority quotas reset immediately."""
    today = get_today()
    conn = get_db_connection()
    conn.execute("DELETE FROM daily_playlist_progress WHERE date=?", (today,))
    conn.commit()
    conn.close()
    return jsonify({'success': True, 'message': 'Daily progress cleared. Priority playlists are now active again.'})


@app.route('/admin-api/download', methods=['POST'])
def queue_download():
    data = request.json
    url = data.get('url')
    playlist = data.get('playlist', 'Downloads')

    if not url:
        return jsonify({'error': 'URL required'}), 400

    job_id = str(int(time.time() * 1000))
    job = {'id': job_id, 'url': url, 'playlist': playlist}

    active_downloads[job_id] = {"status": "queued", "percent": 0, "title": "Waiting in queue...", "playlist": playlist}
    download_queue.put(job)
    return jsonify({'success': True, 'job_id': job_id})


# --- YOUTUBE SEARCH ---
@app.route('/admin-api/youtube/search', methods=['GET'])
def youtube_search():
    q = request.args.get('q', '').strip()
    limit = int(request.args.get('limit', 10))
    if not q:
        return jsonify({'error': 'Query required'}), 400

    try:
        search_url = f"ytsearch{limit}:{q}"
        ydl_opts = {
            'quiet': True,
            'extract_flat': True,
            'skip_download': True,
        }
        results = []
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(search_url, download=False)
            entries = info.get('entries', [])
            for entry in entries:
                if not entry:
                    continue
                vid_id = entry.get('id', '')
                results.append({
                    'id': vid_id,
                    'title': entry.get('title', 'Unknown'),
                    'channel': entry.get('uploader') or entry.get('channel', ''),
                    'duration': entry.get('duration_string') or _fmt_duration(entry.get('duration')),
                    'thumbnail': entry.get('thumbnail') or f"https://img.youtube.com/vi/{vid_id}/mqdefault.jpg",
                    'url': entry.get('url') or f"https://www.youtube.com/watch?v={vid_id}",
                    'view_count': entry.get('view_count', 0),
                })
        return jsonify(results)
    except Exception as e:
        return jsonify({'error': str(e)}), 500


def _fmt_duration(seconds):
    if not seconds:
        return ''
    try:
        s = int(seconds)
        h, rem = divmod(s, 3600)
        m, sec = divmod(rem, 60)
        if h:
            return f"{h}:{m:02}:{sec:02}"
        return f"{m}:{sec:02}"
    except:
        return ''


# --- SCHEDULED DOWNLOADS ---
@app.route('/admin-api/download/scheduled', methods=['GET'])
def list_scheduled_downloads():
    conn = get_db_connection()
    rows = conn.execute("SELECT * FROM scheduled_downloads ORDER BY scheduled_at DESC").fetchall()
    conn.close()
    return jsonify([dict(r) for r in rows])


@app.route('/admin-api/download/scheduled', methods=['POST'])
def create_scheduled_download():
    data = request.json
    url = data.get('url', '').strip()
    playlist = data.get('playlist', '').strip()
    scheduled_at_str = data.get('scheduled_at', '').strip()

    if not url:
        return jsonify({'error': 'URL required'}), 400
    if not playlist:
        return jsonify({'error': 'Playlist name required'}), 400
    if not scheduled_at_str:
        return jsonify({'error': 'scheduled_at required (ISO format)'}), 400

    try:
        run_at = datetime.datetime.fromisoformat(scheduled_at_str)
    except ValueError:
        return jsonify({'error': 'Invalid datetime format. Use ISO 8601 e.g. 2026-04-23T14:30:00'}), 400

    if run_at <= datetime.datetime.now():
        return jsonify({'error': 'Scheduled time must be in the future'}), 400

    job_db_id = str(uuid.uuid4())[:8]
    conn = get_db_connection()
    conn.execute(
        "INSERT INTO scheduled_downloads (id, url, playlist, scheduled_at, status) VALUES (?,?,?,?,?)",
        (job_db_id, url, playlist, scheduled_at_str, 'pending')
    )
    conn.commit()
    conn.close()

    scheduler.add_job(
        run_scheduled_download,
        trigger=DateTrigger(run_date=run_at),
        args=[job_db_id, url, playlist],
        id=f"sched_{job_db_id}"
    )
    return jsonify({'success': True, 'id': job_db_id, 'scheduled_at': scheduled_at_str})


@app.route('/admin-api/download/scheduled/<job_id>', methods=['DELETE'])
def cancel_scheduled_download(job_id):
    try:
        scheduler.remove_job(f"sched_{job_id}")
    except:
        pass  # May already be running

    conn = get_db_connection()
    conn.execute("UPDATE scheduled_downloads SET status='cancelled' WHERE id=? AND status='pending'", (job_id,))
    conn.commit()
    conn.close()
    return jsonify({'success': True})


# --- OVERLAY CONFIG ---
@app.route('/admin-api/overlay', methods=['GET'])
def admin_get_overlay():
    conn = get_db_connection()
    cfg = {row['key']: row['value'] for row in conn.execute("SELECT * FROM overlay_config")}
    conn.close()
    return jsonify(cfg)


@app.route('/admin-api/overlay', methods=['POST'])
def admin_set_overlay():
    data = request.json
    allowed_keys = {'enabled', 'banner_text', 'music_url', 'music_volume', 'banner_position', 'banner_color'}
    conn = get_db_connection()
    for k, v in data.items():
        if k in allowed_keys:
            conn.execute("INSERT OR REPLACE INTO overlay_config (key, value) VALUES (?,?)", (k, str(v)))
    conn.commit()
    conn.close()
    return jsonify({'success': True})


# --- STATS ---
@app.route('/admin-api/stats', methods=['GET'])
def get_stats():
    try:
        total, used, free = shutil.disk_usage(os.path.abspath(MEDIA_PATH))
    except Exception as e:
        print(f"Error getting disk usage: {e}")
        total, used, free = (1, 1, 1) # Prevent division by zero
    
    return jsonify({
        'disk': {
            'total_gb': round(total / (1024 ** 3), 2),
            'used_gb': round(used / (1024 ** 3), 2),
            'free_gb': round(free / (1024 ** 3), 2),
            'percent_used': round((used / total) * 100, 1) if total > 1 else 0
        },
        'downloads': active_downloads,
        'queue_size': download_queue.qsize()
    })


@app.route('/admin-api/media', methods=['GET'])
def list_media():
    result = []
    try:
        for item in sorted(os.listdir(MEDIA_PATH)):
            item_path = os.path.join(MEDIA_PATH, item)
            if os.path.isdir(item_path):
                videos = []
                for f in sorted(os.listdir(item_path)):
                    f_path = os.path.join(item_path, f)
                    if os.path.isfile(f_path):
                        ext = os.path.splitext(f)[1].lower()
                        if ext in VIDEO_EXTENSIONS:
                            size_mb = round(os.path.getsize(f_path) / (1024 * 1024), 1)
                            thumb = get_thumbnail(item_path, f)
                            videos.append({
                                'filename': f,
                                'title': os.path.splitext(f)[0],
                                'size_mb': size_mb,
                                'thumbnail': f'/images/{urllib.parse.quote(item)}/{urllib.parse.quote(thumb)}' if thumb else None
                            })
                if videos:
                    result.append({'playlist': item, 'videos': videos})
    except Exception as e:
        return jsonify({'error': str(e)}), 500
    return jsonify(result)


@app.route('/admin-api/media/<path:playlist>/<path:filename>', methods=['DELETE'])
def delete_media(playlist, filename):
    video_path = os.path.join(MEDIA_PATH, playlist, filename)
    if not os.path.isfile(video_path):
        return jsonify({'error': 'File not found'}), 404
    try:
        os.remove(video_path)
        base = os.path.splitext(video_path)[0]
        for ext in ['.jpg', '.jpeg', '.png', '.webp']:
            thumb_path = base + ext
            if os.path.exists(thumb_path):
                os.remove(thumb_path)
                break
        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


if __name__ == '__main__':
    print(f"Starting unified JJtv Server on port 5000")
    print(f"Media Path: {os.path.abspath(MEDIA_PATH)}")
    app.run(host='0.0.0.0', port=5000, debug=True, threaded=True, use_reloader=False)
