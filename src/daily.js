// The photo of the day, a background picked in Settings (`background: 'daily'`): Wikimedia Commons' Picture of the
// Day, fetched through nexuscortex.dev (../web/api/photo.js) once a day, after the page is drawn. The picture is kept
// in chrome.storage.local (`daily`: { day, image (data: URL), title, artist, license, licenseUrl, page, tried }), so a
// new tab shows the last one at once and the next one replaces it when it has come. Its author and license are shown
// on the page, as the licenses ask.

const SITE = 'https://nexuscortex.dev';
const RETRY = 30 * 60e3;
const today = (now) => new Date(now).toISOString().slice(0, 10); // the site's day is UTC

export async function keptPhoto() {
  return (await chrome.storage.local.get('daily')).daily || null;
}

// Fetches today's photo unless it is kept already (or a try failed in the last half hour); true when there is a new one.
export async function refreshPhoto(now = Date.now()) {
  const kept = await keptPhoto();
  if (kept?.day === today(now) || now - (kept?.tried || 0) < RETRY) return false;
  try {
    const res = await fetch(`${SITE}/api/tabdial/photo`, { signal: AbortSignal.timeout(15_000) });
    const meta = res.ok ? await res.json() : null;
    if (!/^\/api\/tabdial\/photo\/\d{4}-\d{2}-\d{2}$/.test(meta?.image || '')) throw new Error();
    if (kept?.image && kept.from === meta.image) { // the same picture as yesterday's (none fitted in between)
      await chrome.storage.local.set({ daily: { ...kept, day: meta.day } });
      return false;
    }
    const pic = await fetch(SITE + meta.image, { signal: AbortSignal.timeout(60_000) });
    if (!pic.ok || !/^image\//.test(pic.headers.get('Content-Type') || '')) throw new Error();
    const image = await dataUrl(await pic.blob());
    const text = (s, n) => (typeof s === 'string' ? s.slice(0, n) : '');
    await chrome.storage.local.set({ daily: {
      day: meta.day, from: meta.image, image,
      title: text(meta.title, 200), artist: text(meta.artist, 100), license: text(meta.license, 40),
      licenseUrl: /^https?:\/\//.test(meta.licenseUrl || '') ? meta.licenseUrl : '',
      page: /^https:\/\/commons\.wikimedia\.org\//.test(meta.page || '') ? meta.page : '',
    } });
    return true;
  } catch {
    await chrome.storage.local.set({ daily: { ...kept, tried: now } });
    return false;
  }
}

async function dataUrl(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:${blob.type || 'image/jpeg'};base64,${btoa(text)}`;
}
