// Moving backgrounds: a looping video behind the page. Two kinds, as `settings.background`:
// - 'live/<id>': one of the clips in LIVE, from Wikimedia Commons (free licenses, credited on the page), served by
//   nexuscortex.dev at /tabdial/live/<id>.webm (../web/pages/live/). Fetched once, on the click or when the setting
//   arrives with the look, and kept in this browser; nothing about the user goes with the request.
// - 'video': a video the user uploaded. It stays on this computer: too big for sync, backups or the export file.
// The videos are kept in IndexedDB (`tabdial-media`, store `videos`, by background value), the only store here that
// takes a Blob as it is: chrome.storage would turn megabytes into text on every new tab. Only the background in use
// and the uploaded video are kept. The page shows the clip's still picture first, never plays while hidden, and
// shows only the picture when the system asks for reduced motion.

export const LIVE_BASE = 'https://nexuscortex.dev/tabdial/live/';
export const LIVE = {
  // tone: whether the clock goes dark (light) or light (dark) on it, as a photo swatch's data-tone (newtab.html).
  clouds: { tone: 'light', artist: 'Joshua Tree National Park (NPS)', license: 'Public domain', licenseUrl: '', page: 'https://commons.wikimedia.org/wiki/File:Timelapse_Joshua_Tree_Clouds_and_Sunset_Near_West_Entrance.webm' },
  sky: { tone: 'light', artist: 'FreeSwissVideo', license: 'CC BY 3.0', licenseUrl: 'https://creativecommons.org/licenses/by/3.0', page: 'https://commons.wikimedia.org/wiki/File:Wolken_Zeitraffer_-_Clouds_Timelapse_(Royalty_Free)_(Kostenlos)_3840x2160p_30FPS.webm' },
  ocean: { tone: 'dark', artist: 'Ocean Observatories Initiative', license: 'Public domain', licenseUrl: '', page: 'https://commons.wikimedia.org/wiki/File:Irminger_waves_without_sound_(OOI).webm' },
  beach: { tone: 'dark', artist: 'Alexander Grebenkov', license: 'CC BY 3.0', licenseUrl: 'https://creativecommons.org/licenses/by/3.0', page: 'https://commons.wikimedia.org/wiki/File:Ocean_waves_at_L%C3%A6kjavik_beach,_Iceland.webm' },
  falls: { tone: 'dark', artist: 'Psypherium', license: 'CC0', licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/', page: 'https://commons.wikimedia.org/wiki/File:Delaneys_Falls.webm' },
  aurora: { tone: 'dark', artist: 'Giles Laurent', license: 'CC BY-SA 4.0', licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0', page: 'https://commons.wikimedia.org/wiki/File:002_Northern_lights_in_the_night_sky_over_M%C3%BDvatn_in_Iceland_Video_by_Giles_Laurent.webm' },
};
export const MAX_VIDEO = 60e6; // an uploaded video: about a minute of 1080p
export const liveId = (bg) => (typeof bg === 'string' && bg.startsWith('live/') && Object.hasOwn(LIVE, bg.slice(5)) ? bg.slice(5) : '');
export const isMoving = (bg) => bg === 'video' || !!liveId(bg);
export const posterOf = (bg) => (liveId(bg) ? `live/${liveId(bg)}-s.webp` : '');

let db;
function open() {
  db ??= new Promise((resolve, reject) => {
    const req = indexedDB.open('tabdial-media', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('videos');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return db;
}
async function run(mode, work) {
  const tx = (await open()).transaction('videos', mode);
  const req = work(tx.objectStore('videos'));
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}
export const keptVideo = (bg) => run('readonly', (s) => s.get(bg)).catch(() => undefined);
const keep = (bg, blob) => run('readwrite', (s) => s.put(blob, bg));
// Only the clip in use and the uploaded video stay.
export async function tidyVideos(bg) {
  const keys = await run('readonly', (s) => s.getAllKeys()).catch(() => []);
  for (const k of keys) if (k !== bg && k !== 'video') await run('readwrite', (s) => s.delete(k));
}

// The clip for a 'live/<id>' background, fetched and kept if this browser doesn't have it yet.
export async function liveVideo(bg) {
  const id = liveId(bg);
  if (!id) return null;
  const kept = await keptVideo(bg);
  if (kept) return kept;
  const res = await fetch(`${LIVE_BASE}${id}.webm`, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const blob = await res.blob();
  if (!/^video\//.test(blob.type)) throw new Error('not a video');
  await keep(bg, blob);
  return blob;
}

// An uploaded video: checked (the types the file picker offers), kept, and a still picture of it made for the first
// moment of each new tab.
export async function keepUpload(file) {
  if (!/^video\/(mp4|webm)$/.test(file.type)) throw new Error('type');
  if (file.size > MAX_VIDEO) throw new Error('size');
  const poster = await stillOf(file);
  await keep('video', file);
  await chrome.storage.local.set({ videoPoster: poster });
  return poster;
}

// A JPEG of the video's first second, at most 960 pixels wide; fails for a file the browser can't play or that has no
// picture (sound only).
function stillOf(blob) {
  return new Promise((resolve, reject) => {
    const v = document.createElement('video');
    const url = URL.createObjectURL(blob);
    const done = (fn) => (x) => { URL.revokeObjectURL(url); fn(x); };
    v.muted = true;
    v.preload = 'auto';
    v.onerror = done(reject);
    v.onloadeddata = () => { if (!v.videoWidth) return done(reject)(new Error('no picture')); v.currentTime = Math.min(1, (v.duration || 2) / 2); };
    v.onseeked = done(() => {
      const scale = Math.min(1, 960 / v.videoWidth);
      const c = Object.assign(document.createElement('canvas'), { width: Math.round(v.videoWidth * scale), height: Math.round(v.videoHeight * scale) });
      c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
      resolve(c.toDataURL('image/jpeg', 0.8));
    });
    setTimeout(done(() => reject(new Error('timeout'))), 15_000);
    v.src = url;
  });
}
