// The weather under the date, off until the user turns it on in Settings and picks a place there. The place is
// looked up, and its forecast fetched, through nexuscortex.dev (../web/api/weather.js: OpenStreetMap's Nominatim and
// MET Norway behind it), which gets the typed name or the place's coordinates and nothing else. The forecast is kept
// in chrome.storage.local (`weather`) and asked again after an hour at the soonest, after the page is drawn.
// Settings (they follow the user with the look, sync.js LOOK): `weatherOn`, `weatherAt` { name, where, lat, lon },
// `tempUnit` 'c' or 'f' (none = by the browser's region).

const API = 'https://nexuscortex.dev/api/tabdial';
// Firefox asks before an extension sends where the user is (manifest: data_collection_permissions.optional): the
// Settings checkbox asks, and nothing is sent without it (e.g. a place that came with the look from Chrome).
export const WEATHER_DATA = { data_collection: ['locationInfo'] };
export const weatherAllowed = async () => !('data_collection' in await chrome.permissions.getAll()) || chrome.permissions.contains(WEATHER_DATA);
const FRESH = 3600e3;
const RETRY = 15 * 60e3;

export async function findPlaces(query, lang) {
  const res = await fetch(`${API}/place?${new URLSearchParams({ q: query, lang })}`, { signal: AbortSignal.timeout(15_000) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body.places || [];
}

const sameSpot = (a, b) => a && b && a.lat === b.lat && a.lon === b.lon;

// The kept forecast for this place, if any: { at: { lat, lon }, got, tried, points }.
export async function keptForecast(at) {
  const { weather } = await chrome.storage.local.get('weather');
  return sameSpot(weather?.at, at) ? weather : null;
}

// Fetches the forecast when the kept one is older than an hour (or another place's); true if there is a new one.
export async function refreshForecast(at, now = Date.now()) {
  if (!(await weatherAllowed())) return false;
  const kept = await keptForecast(at);
  if (kept && (now - kept.got < FRESH || now - (kept.tried || 0) < RETRY)) return false;
  const spot = { lat: at.lat, lon: at.lon };
  try {
    const res = await fetch(`${API}/weather?lat=${at.lat}&lon=${at.lon}`, { signal: AbortSignal.timeout(15_000) });
    const body = res.ok ? await res.json() : null;
    if (!Array.isArray(body?.points) || !body.points.length) throw new Error();
    await chrome.storage.local.set({ weather: { at: spot, got: now, points: body.points } });
    return true;
  } catch {
    await chrome.storage.local.set({ weather: { ...(kept || { at: spot, got: 0, points: [] }), tried: now } });
    return false;
  }
}

// What the line shows: the hour that is now (or the next one), and the highest and lowest of the next 24 hours.
// Null when the kept forecast is all in the past.
export function nowAndNext(points, now = Date.now()) {
  const ahead = (points || []).filter(([t]) => t * 1000 > now - 3600e3);
  if (!ahead.length) return null;
  const day = ahead.filter(([t]) => t * 1000 < now + 24 * 3600e3).map(([, temp]) => temp);
  return { temp: ahead[0][1], sym: ahead[0][2], max: Math.max(...day), min: Math.min(...day) };
}

// °F for the places that use it (the US and its territories, Liberia and a few more), else °C.
const FAHRENHEIT = new Set(['US', 'PR', 'GU', 'VI', 'AS', 'MP', 'UM', 'BS', 'BZ', 'KY', 'PW', 'FM', 'MH', 'LR']);
export function unitOf(setting, locale = chrome.i18n.getUILanguage()) {
  if (setting === 'c' || setting === 'f') return setting;
  let region = '';
  try { region = new Intl.Locale(locale).maximize().region || ''; } catch {}
  return FAHRENHEIT.has(region) ? 'f' : 'c';
}
export const degrees = (c, unit) => `${Math.round(unit === 'f' ? c * 9 / 5 + 32 : c)}°`;

// MET's symbol to its icon in weather/ (the icons have no polar-twilight drawings here: the day one stands in).
export function iconOf(sym) {
  const name = String(sym || '').replace(/_polartwilight$/, '_day');
  return /^[a-z]+(_day|_night)?$/.test(name) ? `weather/${name}.svg` : '';
}

// Settings that follow the user (sync.js LOOK).
export const validPlace = (v) => !!v && typeof v === 'object' && typeof v.name === 'string' && v.name.length > 0 && v.name.length <= 100
  && typeof v.where === 'string' && v.where.length <= 100
  && typeof v.lat === 'number' && Math.abs(v.lat) <= 90 && typeof v.lon === 'number' && Math.abs(v.lon) <= 180
  && Object.keys(v).length === 4;
