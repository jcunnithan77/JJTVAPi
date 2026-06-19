const schedules = {
  "Blippi/Blippi - Educational Videos for Kids/Be Like Blippi Week 🚗✨ ｜ Blippi Ultimate Roadtrip!": {"start_time":"","end_time":"","lock_message":"","lock_audio":"","priority":0,"min_duration":0,"watch_limit":3,"mandatory_view":0,"is_blocked":0,"req_ack":0,"min_repeat":1,"max_repeat":3},
  "Blippi/Blippi - Educational Videos for Kids/Blippi - Educational Videos for Kids/🔵 Brand New Blippi Educational Videos for Kids! 🎉": {"start_time":"","end_time":"","lock_message":"","lock_audio":"","priority":0,"min_duration":0,"watch_limit":3,"mandatory_view":0,"is_blocked":0,"req_ack":0,"min_repeat":1,"max_repeat":3},
  "Learning to Read/Alphablocks/Misc": {"start_time":"","end_time":"","lock_message":"","lock_audio":"","priority":0,"min_duration":60,"watch_limit":3,"mandatory_view":0,"is_blocked":0,"req_ack":0,"min_repeat":1,"max_repeat":3},
  "Ramayanam/Sony SAB/Shrimad Ramayan Serial All Full Episodes": {"start_time":"","end_time":"","lock_message":"","lock_audio":"","priority":3,"min_duration":0,"watch_limit":3,"mandatory_view":0,"is_blocked":0,"req_ack":0,"min_repeat":1,"max_repeat":3},
  "Film": {"start_time":"","end_time":"","lock_message":"","lock_audio":"","priority":1,"min_duration":0,"watch_limit":1,"mandatory_view":0,"is_blocked":1,"req_ack":0,"min_repeat":1,"max_repeat":3},
  "Dilip Film/Dreamscape Films LLC": {"start_time":"","end_time":"","lock_message":"","lock_audio":"","priority":9,"min_duration":0,"watch_limit":3,"mandatory_view":0,"is_blocked":0,"req_ack":0,"min_repeat":1,"max_repeat":3},
  "Dilip Film": {"start_time":"","end_time":"","lock_message":"","lock_audio":"","priority":0,"min_duration":0,"watch_limit":3,"mandatory_view":0,"is_blocked":1,"req_ack":0,"min_repeat":1,"max_repeat":3},
  "Learning to Read": {"start_time":"","end_time":"","lock_message":"","lock_audio":"","priority":10,"min_duration":30,"watch_limit":3,"mandatory_view":1,"is_blocked":0,"req_ack":0,"min_repeat":1,"max_repeat":3},
  "T-Series Kids Hut": {"start_time":"","end_time":"","lock_message":"","lock_audio":"","priority":9,"min_duration":30,"watch_limit":3,"mandatory_view":1,"is_blocked":0,"req_ack":0,"min_repeat":1,"max_repeat":3},
  "Ramayanam": {"start_time":"","end_time":"","lock_message":"","lock_audio":"","priority":8,"min_duration":30,"watch_limit":3,"mandatory_view":0,"is_blocked":0,"req_ack":0,"min_repeat":1,"max_repeat":3},
  "KarnaticSongClass": {"start_time":"","end_time":"","lock_message":"","lock_audio":"","priority":11,"min_duration":2,"watch_limit":1,"mandatory_view":1,"is_blocked":0,"req_ack":0,"min_repeat":1,"max_repeat":3}
};

const blockedNames = Object.keys(schedules).filter(k => schedules[k].is_blocked === 1);

const activeTimed = [];
const activeTimeless = [];
const scheduledNames = new Set();
const strictTimedNames = new Set();
const minDurationMap = {};

const nowD = new Date();
const nowM = nowD.getHours() * 60 + nowD.getMinutes();

for (const key of Object.keys(schedules)) {
  const s = schedules[key];
  if (s.is_blocked === 1) continue; // Skip entirely for normal scheduling
  
  scheduledNames.add(key);
  minDurationMap[key] = s.min_duration || 0;
  
  let isTimed = false;
  let inWindow = false;

  if (s.start_time && s.start_time !== '' && s.end_time && s.end_time !== '') {
    isTimed = true;
    const startParts = s.start_time.split(':');
    const endParts = s.end_time.split(':');
    const startM = parseInt(startParts[0]) * 60 + parseInt(startParts[1]);
    const endM   = parseInt(endParts[0]) * 60 + parseInt(endParts[1]);
    inWindow = startM < endM
      ? (nowM >= startM && nowM <= endM)
      : (nowM >= startM || nowM <= endM);
    
    // Only hide the playlist in fallback mode if we are OUTSIDE its allowed window
    if (!inWindow) {
      strictTimedNames.add(key);
    }
  } else {
    // No time defined, always active
    inWindow = true; 
  }
  
  if (inWindow) {
    if (isTimed) {
      activeTimed.push(key);
    } else {
      activeTimeless.push(key);
    }
  }
}

// simulate progress rows (empty)
const completionRows = [];

const allActive = [...activeTimed, ...activeTimeless];

const completedSet = new Set();
for (const scheduledPlaylist of allActive) {
  const minDur = minDurationMap[scheduledPlaylist];
  let totalWatched = 0;
  let anyCompleted = false;

  for (const row of completionRows) {
    if (row.playlist === scheduledPlaylist || row.playlist.startsWith(scheduledPlaylist + '/')) {
      totalWatched += row.watched_duration;
      if (row.completed === 1) {
        anyCompleted = true;
      }
    }
  }

  if (anyCompleted) {
    completedSet.add(scheduledPlaylist);
  } else if (minDur > 0 && totalWatched >= minDur * 60) {
    completedSet.add(scheduledPlaylist);
  }
}

const pendingTimed = activeTimed.filter(p => !completedSet.has(p));
const pendingTimeless = activeTimeless.filter(p => !completedSet.has(p));

console.log("pendingTimed:", pendingTimed);
console.log("pendingTimeless:", pendingTimeless);
console.log("strictTimedNames:", strictTimedNames);
console.log("blockedNames:", blockedNames);
