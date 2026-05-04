import sqlite3
import os

db_path = r'd:\JC\Personal\projects\TvApp-JJtv\JJTVAPI\backend\jjtv_config.db'
if not os.path.exists(db_path):
    print(f"DB not found at {db_path}")
    exit(1)

conn = sqlite3.connect(db_path)
cursor = conn.cursor()

print('--- Media Cache Entries ---')
try:
    cursor.execute('SELECT vpath, playlist, filename FROM media_cache LIMIT 10')
    rows = cursor.fetchall()
    for row in rows:
        print(f"Playlist: {row[1]} | Filename: {row[2]} | Path: {row[0]}")
except Exception as e:
    print(f"Error reading media_cache: {e}")

print('\n--- Settings ---')
try:
    cursor.execute('SELECT * FROM settings')
    rows = cursor.fetchall()
    for row in rows:
        print(f"{row[0]}: {row[1]}")
except Exception as e:
    print(f"Error reading settings: {e}")

conn.close()
