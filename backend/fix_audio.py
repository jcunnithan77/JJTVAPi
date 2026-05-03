import os
import subprocess
import json
import yt_dlp
import sys
import shutil
import io

# Set stdout to UTF-8 to avoid encoding errors with emojis in filenames
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')

# Ensure node is in PATH
node_path = "C:\\Program Files\\nodejs"
if node_path not in os.environ["PATH"]:
    os.environ["PATH"] += os.pathsep + node_path

def print_flush(msg):
    print(msg, flush=True)
    try:
        with open("fix_audio.log", "a", encoding="utf-8") as f:
            f.write(msg + "\n")
    except:
        pass

# Load config

CONFIG_FILE = 'config.json'
MEDIA_PATH = './videos'
if os.path.exists(CONFIG_FILE):
    try:
        with open(CONFIG_FILE, 'r') as f:
            config_data = json.load(f)
            if 'media_path' in config_data:
                MEDIA_PATH = config_data['media_path']
    except Exception as e:
        print_flush(f"Error loading config.json: {e}")

FFPROBE_PATH = os.environ.get('FFPROBE_BIN') or (os.path.join(os.getcwd(), 'ffprobe.exe') if os.name == 'nt' else 'ffprobe')
FFMPEG_PATH = os.environ.get('FFMPEG_BIN') or (os.path.join(os.getcwd(), 'ffmpeg.exe') if os.name == 'nt' else 'ffmpeg')

VIDEO_EXTENSIONS = {'.mp4', '.mkv', '.avi', '.mov', '.webm'}
IMAGE_EXTENSIONS = {'.jpg', '.jpeg', '.png', '.webp'}

def has_audio(filepath):
    cache_file = filepath + ".has_audio"
    if os.path.exists(cache_file):
        try:
            with open(cache_file, 'r') as f:
                return f.read().strip() == 'True'
        except:
            pass

    cmd = [
        FFPROBE_PATH,
        '-v', 'error',
        '-select_streams', 'a',
        '-show_entries', 'stream=index',
        '-of', 'csv=p=0',
        filepath
    ]
    try:
        result = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        exists = len(result.stdout.strip()) > 0
        try:
            with open(cache_file, 'w') as f:
                f.write(str(exists))
        except:
            pass
        return exists
    except Exception as e:
        print_flush(f"Error checking {filepath}: {e}")
        return True 

def search_youtube(query, video_id=None):
    if video_id:
        print_flush(f"Using extracted ID: {video_id}")
        return f"https://www.youtube.com/watch?v={video_id}"

    print_flush(f"Searching YouTube for: {query}")
    ydl_opts = {
        'quiet': True,
        'extract_flat': True,
        'skip_download': True,
        'js_runtimes': {'node': {}},
        'remote_components': ['ejs:github'],
        'extractor_args': {'youtube': {'player_client': ['ios', 'android', 'web']}},
    }
    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(f"ytsearch1:{query}", download=False)
            if 'entries' in info and info['entries']:
                return info['entries'][0]['url']
    except Exception as e:
        print_flush(f"Search error: {e}")
    return None

def download_audio_and_thumb(url, output_base, thumb_needed):
    print_flush(f"Processing: {url}")
    ydl_opts = {
        'format': 'ba/b',
        'outtmpl': output_base,
        'quiet': True,
        'ffmpeg_location': FFMPEG_PATH if os.path.exists(FFMPEG_PATH) else None,
        'writethumbnail': thumb_needed,
        'js_runtimes': {'node': {}},
        'remote_components': ['ejs:github'],
        'extractor_args': {'youtube': {'player_client': ['ios', 'android', 'web']}},
        'postprocessors': [
            {
                'key': 'FFmpegExtractAudio',
                'preferredcodec': 'm4a',
                'preferredquality': '192',
            }
        ],
    }
    if thumb_needed:
        ydl_opts['postprocessors'].append({
            'key': 'FFmpegThumbnailsConvertor',
            'format': 'jpg',
        })

    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            ydl.download([url])
        return True
    except Exception as e:
        print_flush(f"Download error: {e}")
    return False

def merge_audio(video_path, audio_path, output_path):
    print_flush(f"Merging audio into: {video_path}")
    cmd = [
        FFMPEG_PATH,
        '-y',
        '-i', video_path,
        '-i', audio_path,
        '-c:v', 'copy',
        '-c:a', 'aac',
        '-map', '0:v:0',
        '-map', '1:a:0',
        '-shortest',
        output_path
    ]
    try:
        subprocess.run(cmd, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        return True
    except Exception as e:
        print_flush(f"Merge error: {e}")
    return False

def fix_silent_videos(dry_run=False, limit=None):
    print_flush(f"Scanning directory: {MEDIA_PATH}")
    silent_videos = []
    for root, dirs, files in os.walk(MEDIA_PATH):
        for file in files:
            if os.path.splitext(file)[1].lower() in VIDEO_EXTENSIONS:
                path = os.path.join(root, file)
                if not has_audio(path):
                    silent_videos.append(path)
    
    if not silent_videos:
        print_flush("No silent videos found.")
        return

    print_flush(f"Found {len(silent_videos)} silent videos.")
    if dry_run:
        for v in silent_videos:
            print_flush(f" [DRY RUN] Would fix: {v}")
        return

    count = 0
    for video_path in silent_videos:
        if limit and count >= limit:
            print_flush(f"Reached limit of {limit} videos.")
            break

        basename = os.path.basename(video_path)
        title = os.path.splitext(basename)[0]
        
        # 1. Try to extract ID from [ID] format
        import re
        id_match = re.search(r'\[([a-zA-Z0-9_-]{11})\]', title)
        video_id = id_match.group(1) if id_match else None
        
        # 2. Clean title for search
        # Strip ID and dash suffix
        search_query = title
        search_query = re.sub(r'\[[a-zA-Z0-9_-]{11}\]', '', search_query) # Strip [ID]
        search_query = re.sub(r'\.f\d+$', '', search_query) # Strip .f401 etc
        search_query = search_query.strip()
        
        # Check if thumbnail exists
        thumb_exists = False
        dir_path = os.path.dirname(video_path)
        for ext in IMAGE_EXTENSIONS:
            if os.path.exists(os.path.join(dir_path, title + ext)):
                thumb_exists = True
                break
        
        url = search_youtube(search_query, video_id=video_id)
        if not url:
            print_flush(f"Could not find YouTube source for: {title}")
            continue

        import time
        time.sleep(10) # Delay to avoid rate limiting

        temp_base = video_path + ".temp"
        temp_audio = temp_base + ".m4a"
        temp_video = video_path + ".fixed.mp4"
        temp_thumb = temp_base + ".jpg"

        if download_audio_and_thumb(url, temp_base, not thumb_exists):
            # yt-dlp creates .temp.m4a for audio
            if os.path.exists(temp_audio):
                if merge_audio(video_path, temp_audio, temp_video):
                    # Replace original
                    backup = video_path + ".bak"
                    os.rename(video_path, backup)
                    os.rename(temp_video, video_path)
                    os.remove(backup)
                    
                    # Clear cache so it won't be scanned as "silent" again
                    cache_file = video_path + ".has_audio"
                    if os.path.exists(cache_file): os.remove(cache_file)
                    
                    print_flush(f"Successfully fixed: {video_path}")

                    count += 1
                
                # Handle thumbnail
                if not thumb_exists and os.path.exists(temp_thumb):
                    final_thumb = os.path.join(dir_path, title + ".jpg")
                    os.rename(temp_thumb, final_thumb)
                    print_flush(f"Downloaded thumbnail: {final_thumb}")

                # Cleanup
                if os.path.exists(temp_audio): os.remove(temp_audio)
                if os.path.exists(temp_video): os.remove(temp_video)
                if os.path.exists(temp_thumb): os.remove(temp_thumb)
            else:
                 # Fallback: if specific ID failed, try searching by title
                 if video_id:
                     print_flush(f"Retrying with title search for: {search_query}")
                     url = search_youtube(search_query)
                     if url and download_audio_and_thumb(url, temp_base, not thumb_exists):
                         if os.path.exists(temp_audio):
                            if merge_audio(video_path, temp_audio, temp_video):
                                backup = video_path + ".bak"
                                os.rename(video_path, backup)
                                os.rename(temp_video, video_path)
                                os.remove(backup)
                                print_flush(f"Successfully fixed (via search): {video_path}")
                                count += 1
                            if os.path.exists(temp_audio): os.remove(temp_audio)
                            if os.path.exists(temp_video): os.remove(temp_video)
                            if os.path.exists(temp_thumb): os.remove(temp_thumb)
                 else:
                    print_flush(f"Audio download failed for: {title}")
        else:
             print_flush(f"Expected audio file not found after download: {temp_audio}")

def cleanup_temp_files():
    print_flush("Cleaning up leftover temporary files...")
    for root, dirs, files in os.walk(MEDIA_PATH):
        for file in files:
            if file.endswith((".temp", ".temp.m4a", ".temp.jpg", ".temp.temp", ".part")):
                try:
                    os.remove(os.path.join(root, file))
                except:
                    pass

if __name__ == "__main__":
    cleanup_temp_files()
    dry_run = "--dry-run" in sys.argv
    limit = None
    for arg in sys.argv:
        if arg.startswith("--limit="):
            limit = int(arg.split("=")[1])
    
    fix_silent_videos(dry_run=dry_run, limit=limit)



