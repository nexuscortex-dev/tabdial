// Keeps the dial list (groups, folders, addresses, titles) the same on the user's other computers, and how the page
// looks ("the look", below). Only the user's own groups: team groups stay where they are, and each computer fetches
// them itself (team.js).
//
// One of two ways at a time. Without a sync code the list is in chrome.storage.sync and follows the user through the
// browser's own sync, to the same browser on their other computers; thumbnails stay on each computer. With one
// ("between browsers", below) it goes through nexuscortex.dev, encrypted, to every browser that has the code, and so
// do the dials' thumbnails and their sites' icons ("pictures", at the end).
//
// Layout in chrome.storage.sync: `meta` = { rev, n } names the chunks `c:<rev>:0` … `c:<rev>:<n-1>`. Every write uses a new rev and then
// drops the chunks it replaced, so a reader never mixes two writes, even when two computers write at once.
// Rules that keep dials from being lost:
//   1. Changes this computer hasn't sent yet are never replaced: a list from elsewhere is merged into them.
//   2. A computer that has never synced sends nothing until it has merged what the others already have.
//   3. While this computer's own write is on its way, lists read from sync are ignored.
// ponytail: otherwise the last writer wins; a dial deleted on one computer while another had unsent changes comes back
// (kept rather than lost). Per-dial merging would fix that if it matters.
//
// The pure helpers are unit-tested in Node; pull() and push() are tested there against a fake chrome.storage.
import { addMissing, dialsOf, fillImages, normalizeUrl, ownGroups, pick, urlKey, withTeamGroups } from './merge.js';
import { ask, opened, seal, unseal } from './team.js';
import { fill, forSite, local, mergeNotes, namedBy, namedIn, picturesIn, readSynced, revsOf, synced } from './notes.js';
import * as todos from './todos.js';
import { t } from './i18n.js';

// Characters per chunk. Chrome may store a character as a 6-byte \uXXXX escape; 1300 × 6 stays under the 8 KB per-item quota.
const CHUNK = 1300;
const STALE_MS = 60_000;

// Time-ordered, so old chunks left behind by an interrupted write can be recognised and removed.
export const newRev = () => `${Date.now().toString(36).padStart(9, '0')}-${Math.random().toString(36).slice(2, 8)}`;
const revTime = (rev) => parseInt(rev.slice(0, 9), 36);
// The list's chunks are c:…, the notes' n:… (below), each named by its own meta item.
const chunkKeys = (rev, n, prefix = 'c') => Array.from({ length: n }, (_, i) => `${prefix}:${rev}:${i}`);

// The dial list as a string, so two lists compare with ===: [[groupId, name, [[dialId, url, title], ...]], ...]. A folder
// sits among its group's dials as [folderId, name, [...]]: its third item is a list, not a title, of dials and folders.
const toList = (d) => (d.dials ? [d.id, d.name, d.dials.map(toList)] : [d.id, d.url, d.title]);
// The site's list (siteList) has more after a dial's title: its thumbnail and its icon, kept here as `pic` and `ico`
// until withPictures puts the pictures themselves in.
const fromList = ([id, a, b, pic, ico]) => (Array.isArray(b) ? { id, name: a, dials: b.map(fromList) }
  : { id, url: normalizeUrl(a), title: b, image: '', ...(pic && { pic }), ...(ico && { ico }) });
// A list's dials and folders. Whoever can write the list (anyone with the sync code) could put any address in it:
// one that isn't a dial's (javascript:, data:) is left out, as it is when typed or imported.
const itemsOf = (ds) => pick(ds.map(fromList), (d) => d.url);
export const listJson = (state) => JSON.stringify(ownGroups(state.groups).map((g) => [g.id, g.name, g.dials.map(toList)]));

export function pack(list, rev, prefix = 'c', meta = 'meta') {
  const items = {};
  let n = 0;
  for (let start = 0; start < list.length; n++) {
    let end = Math.min(start + CHUNK, list.length);
    if (end < list.length && /[\uD800-\uDBFF]/.test(list[end - 1])) end--; // don't split an emoji's surrogate pair
    items[`${prefix}:${rev}:${n}`] = list.slice(start, end);
    start = end;
  }
  items[meta] = { rev, n };
  return items;
}

// The synced list, or null if nothing is synced yet or the latest write hasn't fully arrived.
export function unpack(items, prefix = 'c', meta = 'meta') {
  if (!items[meta]) return null;
  const chunks = chunkKeys(items[meta].rev, items[meta].n, prefix).map((key) => items[key]);
  return chunks.every((c) => typeof c === 'string') ? chunks.join('') : null;
}

// Throws before anything is changed if the list isn't the shape Tabdial writes.
function parseList(list) {
  const groups = JSON.parse(list);
  const text = (v) => typeof v === 'string';
  const dial = (d) => Array.isArray(d) && d.length >= 3 && d.length <= 5 && d.every(text);
  const folder = (d) => Array.isArray(d) && text(d[0]) && text(d[1]) && Array.isArray(d[2]) && d[2].every(item);
  const item = (d) => dial(d) || folder(d);
  const ok = Array.isArray(groups) && groups.length > 0 && groups.every((g) => Array.isArray(g) && text(g[0]) && text(g[1])
    && Array.isArray(g[2]) && g[2].every(item));
  if (!ok) throw new Error(t('syncUnreadable'));
  return groups;
}

// Take the synced list as it is. From the browser's sync it has no pictures: each dial keeps its thumbnail from this
// computer (matched by id, then address). The site's list says which pictures the dials have: `have` is those this
// browser has, by id (picturesOf).
export function applyList(state, list, have) {
  const groups = parseList(list);
  const own = groups.map(([id, name, ds]) => ({ id, name, dials: itemsOf(ds) }));
  if (have) own.flatMap(dialsOf).forEach((d) => withPictures(d, have));
  else fillImages(own, state.groups);
  state.groups = withTeamGroups(state.groups, own);
  if (!state.groups.some((g) => g.id === state.activeGroup)) state.activeGroup = state.groups[0].id;
}

// Keep this computer's dials and add what the synced list has on top. A dial that is already here (same id) stays
// where it is, even if it sits in another group or folder there. A team group named like a synced group stays separate.
// With the site's list (`have`, as in applyList), a dial that is here without a thumbnail or an icon takes the one the
// list has for it: a browser that joins with the same sites and no pictures gets them, and doesn't take them away.
export function mergeList(state, list, have) {
  const groups = parseList(list);
  const here = new Set(ownGroups(state.groups).flatMap((g) => dialsOf(g).map((d) => d.id)));
  for (const [id, name, ds] of groups) {
    let group = ownGroups(state.groups).find((g) => g.id === id || g.name.toLowerCase() === name.toLowerCase());
    if (!group) state.groups.push(group = { id, name, dials: [] });
    const items = itemsOf(ds);
    if (have) {
      const mine = new Map(dialsOf(group).flatMap((d) => [[urlKey(d.url), d], [d.id, d]]));
      for (const theirs of dialsOf({ dials: items })) {
        const d = mine.get(theirs.id) || mine.get(urlKey(theirs.url));
        if (d && !d.image && !d.pic && theirs.pic) d.pic = theirs.pic;
        if (d && !d.icon && !d.ico && theirs.ico) d.ico = theirs.ico;
        withPictures(d || theirs, have);
      }
    }
    addMissing(group, pick(items, (d) => !here.has(d.id)));
  }
}

const syncOn = (state) => state.settings.sync !== false;
const sending = (seen) => seen?.sendingSince && Date.now() - seen.sendingSince < STALE_MS;
// What this computer last saw (`syncSeen`) belongs to one way only: { rev, n, list } is from the browser's sync,
// { space, version, list } from the site. After a change of way, the other's record counts as never synced (rule 2).
const viaBrowser = (seen) => (seen?.space ? undefined : seen);
const viaSite = (seen, space) => (seen?.space === space ? seen : null);

// Bring in the list from Chrome sync. Returns null if there was nothing new, else the `syncSeen` record the caller
// must store in the same write as the changed state (store.js syncNow): a page closed in between must not leave the
// list marked as seen when it was never stored.
export async function pull(state) {
  if (!syncOn(state)) return null;
  const items = await chrome.storage.sync.get(null);
  if (items.syncCode) return null; // the list comes from the site: pullSite()
  const list = unpack(items);
  const syncSeen = viaBrowser((await chrome.storage.local.get('syncSeen')).syncSeen);
  if (!list || syncSeen?.rev === items.meta.rev || sending(syncSeen)) return null;
  const unsent = syncSeen?.list ? listJson(state) !== syncSeen.list : ownGroups(state.groups).some((g) => g.dials.length);
  if (unsent) mergeList(state, list);
  else applyList(state, list);
  // Chunks from writes that were interrupted or overtaken a while ago.
  const oldest = revTime(items.meta.rev) - STALE_MS;
  const leftovers = Object.keys(items).filter((k) => k.startsWith('c:') && revTime(k.slice(2)) < oldest);
  if (leftovers.length) await chrome.storage.sync.remove(leftovers);
  return { rev: items.meta.rev, n: items.meta.n, list };
}

// Send the list to Chrome sync if it changed. A failure (quota, rate limit) is kept for Settings to show,
// and the next save tries again. With a sync code it goes to the site instead, which may answer with another browser's
// changes: then this returns the `syncSeen` record the caller must store with the state they were merged into.
export async function push(state) {
  if (!syncOn(state)) return null;
  const code = await syncCode();
  if (code) return await siteAllowed() ? pushSite(state, code) : null;
  const list = listJson(state);
  const syncSeen = viaBrowser((await chrome.storage.local.get('syncSeen')).syncSeen);
  if (list === syncSeen?.list) return;
  if (!syncSeen?.rev && (await chrome.storage.sync.get('meta')).meta) return; // rule 2: pull() merges first
  const rev = newRev();
  const items = pack(list, rev);
  await chrome.storage.local.set({ syncSeen: { ...syncSeen, sendingSince: Date.now() } }); // rule 3
  try {
    await chrome.storage.sync.set(items);
    if (syncSeen?.rev) await chrome.storage.sync.remove(chunkKeys(syncSeen.rev, syncSeen.n));
    await chrome.storage.local.set({ syncSeen: { rev, n: items.meta.n, list }, syncError: '' });
  } catch (err) {
    await (syncSeen ? chrome.storage.local.set({ syncSeen }) : chrome.storage.local.remove('syncSeen'));
    await chrome.storage.local.set({ syncError: /quota/i.test(err.message) ? t('syncTooLong') : err.message });
  }
}

// ---------- the look ----------
// How the page looks (the settings below) follows the user the way the list does: through the browser's own sync, in
// one item, `look`, or with a sync code through nexuscortex.dev, in what is encrypted with the list. A background the
// user uploaded is too big to go: it stays on its computer, and no synced background takes its place there.
// Each setting travels on its own. { theirs, mine } is what sync held and what this computer had when the two last
// met (`lookSeen` for the browser's sync, `syncSeen.look` for the site): what this computer changed since is written
// over what sync holds, what changed there is taken, and of two computers changing the same setting one wins.
export const NEW_LOOK = { background: 'photos/sunset.webp', columns: 6 }; // a new install opens on a photo (store.js)
const LOOK = {
  background: (v) => typeof v === 'string' && /^($|#[0-9a-f]{6}$|photos\/[\w-]+\.webp$|linear-gradient\([\w\s#,]+\)$)/i.test(v),
  columns: (v) => Number.isInteger(v) && v >= 3 && v <= 12,
  size: (v) => Number.isInteger(v) && v >= 60 && v <= 160,
  radius: (v) => Number.isInteger(v) && v >= 0 && v <= 32,
  gap: (v) => Number.isInteger(v) && v >= 0 && v <= 48,
  text: (v) => Number.isInteger(v) && v >= 11 && v <= 20,
  font: (v) => typeof v === 'string' && /^[^"\\\n]{0,100}$/.test(v), // a font's name, which the page puts between quotes
  titles: (v) => typeof v === 'boolean',
  searchBox: (v) => typeof v === 'boolean',
  theme: (v) => ['', 'light', 'dark'].includes(v),
  todoOn: (v) => typeof v === 'boolean', // the to-do card shown (newtab.js)
  todoAt: (v) => Array.isArray(v) && v.length === 2 && v.every((n) => typeof n === 'number' && n >= 0 && n <= 1), // where: 0 to 1 across the room the window leaves
};
// Those of these settings that `settings` has, each only as Tabdial writes it: whoever can write to the user's sync
// could put anything there, and a background could then name a picture on a server of theirs.
export const lookOf = (settings) => Object.fromEntries(Object.keys(LOOK).filter((name) => LOOK[name](settings?.[name])).map((name) => [name, settings[name]]));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const readLook = async () => [(await chrome.storage.sync.get('look')).look, (await chrome.storage.local.get('lookSeen')).lookSeen];

// Take into the settings what the synced look (`theirs`) changed since this computer last saw it, and return the
// record of this meeting. The first time (no `seen`), a computer whose look is still as installed takes all of it; one
// the user has set up keeps its own, and from then on gives and takes what changes.
function takeLook(state, theirs, seen) {
  if (!seen && !same(lookOf(state.settings), lookOf(NEW_LOOK))) return { theirs, mine: lookOf(state.settings) };
  const uploaded = state.settings.background?.startsWith('data:');
  const changed = Object.fromEntries(Object.entries(theirs).filter(([name, v]) => !same(v, seen?.theirs[name]) && !(name === 'background' && uploaded)));
  Object.assign(state.settings, changed);
  return { theirs, mine: { ...seen?.mine, ...changed } };
}
// What this computer changed in the look since that meeting.
const lookChanges = (state, seen) => Object.fromEntries(Object.entries(lookOf(state.settings)).filter(([name, v]) => !same(v, seen?.mine[name])));

// Take what changed in the look the browser's sync holds. Returns null if nothing did, else the `lookSeen` record the
// caller must store in the same write as the changed state, as with pull(). With a sync code the look comes with the
// list: pullSite().
export async function pullLook(state) {
  if (!syncOn(state) || await syncCode()) return null;
  const [look, seen] = await readLook();
  const theirs = lookOf(look);
  return look && !same(theirs, seen?.theirs) ? takeLook(state, theirs, seen) : null;
}

// Send what this computer changed in the look. Not with every save: a slider saves many times a second, so the page
// calls this once things are quiet (newtab.js shareLook, through store.js sendLook). With a sync code it goes to the
// site with the list, and as with push() the answer may be a `syncSeen` record to store with the merged state.
// Otherwise it is written over what the browser's sync holds; what is there that this computer hasn't taken yet stays,
// and stays unseen, for pullLook.
export async function pushLook(state) {
  if (!syncOn(state)) return null;
  const code = await syncCode();
  if (code) return await siteAllowed() ? pushSite(state, code, true) : null;
  const [look, seen] = await readLook();
  if (look && !seen) return null; // as rule 2: pullLook first
  const changed = lookChanges(state, seen);
  if (!Object.keys(changed).length) return null;
  await chrome.storage.sync.set({ look: lookOf({ ...look, ...changed }) });
  await chrome.storage.local.set({ lookSeen: { theirs: lookOf({ ...seen?.theirs, ...changed }), mine: { ...seen?.mine, ...changed } } });
  return null;
}

// ---------- notes and to-dos ----------
// The user's notes (notes.js) and to-dos (todos.js) follow them as the look does: through the browser's own sync, each
// in chunks like the list's (`notes` names n:<rev>:0 …, `todos` t:<rev>:0 …), or with a sync code in what is
// encrypted with the list. Each side keeps them as it last saw them synced (`notesSeen` and `todosSeen` { rev, n, notes }
// for the browser's sync, `syncSeen.notes` and `syncSeen.todos` for the site): a merge knows from them which side
// changed what (notes.js mergeNotes). Like the look they go when things are quiet (store.js sendLook), not with every
// save. The browser's sync carries no pictures: a picture is named there by a hash of itself, and comes back from this
// computer's own notes if it has it.
// ponytail: two computers writing the browser's sync in the same moment: the last write wins there, and the other's
// change comes back with its next write (it is still in its notes). The site has versions, so not there.
const browserIds = (data) => pictureId('', data);
const havePictures = async (notes, key) => new Map(await Promise.all(picturesIn(notes).map(async (data) => [await pictureId(key, data), data])));
const KINDS = {
  notes: { prefix: 'n', seenKey: 'notesSeen', tooLong: 'notesTooLong', read: readSynced, out: (state) => synced(state.notes, browserIds),
    take: async (state, theirs, seen) => { state.notes = mergeNotes(state.notes, local(theirs, await havePictures(state.notes, '')), revsOf(seen)); } },
  todos: { prefix: 't', seenKey: 'todosSeen', tooLong: 'todosTooLong', read: todos.readSynced, out: (state) => todos.synced(state.todos),
    take: (state, theirs, seen) => { state.todos = todos.mergeTodos(state.todos, theirs, seen); } },
};

// Take in what changed in the notes (or the to-dos, `kind`) the browser's sync holds. Returns null if nothing did, else
// the `notesSeen` (`todosSeen`) record to store in the same write as the changed state, as pull() does.
export async function pullNotes(state, kind = 'notes') {
  if (!syncOn(state) || await syncCode()) return null;
  const { prefix, seenKey, read, take } = KINDS[kind];
  const items = await chrome.storage.sync.get(null);
  const { [seenKey]: seen } = await chrome.storage.local.get(seenKey);
  if (!items[kind] || seen?.rev === items[kind].rev) return null;
  let theirs;
  try { theirs = read(JSON.parse(unpack(items, prefix, kind))); } catch {}
  if (!theirs) return null; // not all there yet, or not as Tabdial writes it
  await take(state, theirs, seen?.notes);
  return { ...items[kind], notes: theirs };
}

// Write the notes (or the to-dos) over what the browser's sync holds, if they changed. What another computer wrote there
// since this one last took it in is taken in first (the caller has: store.js sendLook), so nothing of it is written over.
export async function pushNotes(state, kind = 'notes') {
  if (!syncOn(state) || await syncCode()) return;
  const { prefix, seenKey, tooLong, out } = KINDS[kind];
  const { [seenKey]: seen } = await chrome.storage.local.get(seenKey);
  const { [kind]: meta } = await chrome.storage.sync.get(kind);
  if (meta && meta.rev !== seen?.rev) return; // not taken in yet
  const notes = await out(state);
  const text = JSON.stringify(notes);
  if (text === JSON.stringify(seen?.notes || [])) return;
  const rev = newRev();
  const items = pack(text, rev, prefix, kind);
  try {
    await chrome.storage.sync.set(items);
    // what this one replaced, and what writes interrupted or overtaken a while ago left behind
    const mine = `${prefix}:`;
    const old = (k) => k.startsWith(mine) && !k.startsWith(`${mine}${rev}:`) && (k.startsWith(`${mine}${seen?.rev}:`) || revTime(k.slice(2)) < Date.now() - STALE_MS);
    await chrome.storage.sync.remove(Object.keys(await chrome.storage.sync.get(null)).filter(old));
    await chrome.storage.local.set({ [seenKey]: { rev, n: items[kind].n, notes } });
  } catch (err) {
    await chrome.storage.local.set({ syncError: /quota/i.test(err.message) ? t(tooLong) : err.message });
  }
}

// ---------- between browsers ----------
// The browser's own sync stops at the browser: Chrome's never reaches Firefox. With a sync code the list goes through
// nexuscortex.dev instead (tabdial/web/api/sync.js), and chrome.storage.sync carries only the code, so the same browser
// on the user's other computers joins by itself. The code is 25 letters and digits made here, 125 random bits. From it
// come, by HKDF, a credential that names the list on the site and an AES-GCM key that never leaves the browser, neither
// of which tells the other or the code: the site keeps a list it can't read, and whoever has the code has the list.
// There is no account, so no way back in without the code: lost with every browser that had it, the list on the site
// stays shut (each browser still has its own dials).
//
// The three rules above hold here too. The site stores a write only if it is based on the version it has; told that
// another browser wrote first, pushSite() merges that list into this one and sends the result, so here the last writer
// doesn't win. What is encrypted is { v, list, look, notes, todos }, v being the version the write makes: the site
// can't pass an old list off as a newer one (team.js opened). `look` is the look as above, `notes` the notes, `todos`
// the to-dos; a list written by 0.4 has none of them, and then nothing is known of them (none is taken for deleted).
const SITE = 'https://nexuscortex.dev/api/tabdial/sync';
// The join page hands the code to Tabdial in Chrome and Edge (background.js), as it does an invite link.
export const codeLink = (code) => `https://nexuscortex.dev/tabdial/join/#${code}`;
const CHECK_EVERY = 60e3;
const LETTERS = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford's base 32: no I, L, O or U

export const syncCode = async () => (await chrome.storage.sync.get('syncCode')).syncCode || null;

// Firefox asks the user before an extension sends their data anywhere (manifest: data_collection_permissions), and
// Settings does at the click that starts or enters a code. The code then reaches their other Firefoxes through
// Firefox's own sync, where nobody was asked: there the list waits until the code is confirmed in Settings. What goes:
// the credential, the list, and the dials' pictures (a thumbnail can be a picture of a page).
export const SYNC_DATA = { data_collection: ['authenticationInfo', 'bookmarksInfo', 'websiteContent'] };
export const siteAllowed = async () => !('data_collection' in await chrome.permissions.getAll()) || chrome.permissions.contains(SYNC_DATA);

// A code as typed, pasted, or in the link Settings gives: any case, any spacing, and O, I and L read as the digits
// they look like. Returns it as Tabdial writes it (XXXXX-XXXXX-XXXXX-XXXXX-XXXXX), or null.
export function parseCode(text) {
  const s = String(text ?? '').trim().replace(/^https?:[^#]*#/, '').toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  return s.length === 25 && [...s].every((c) => LETTERS.includes(c)) ? s.match(/.{5}/g).join('-') : null;
}

const B64 = { alphabet: 'base64url', omitPadding: true };
const bytes = (text) => new TextEncoder().encode(text);

async function keysOf(code) {
  const secret = await crypto.subtle.importKey('raw', bytes(code.replaceAll('-', '')), 'HKDF', false, ['deriveBits']);
  const part = async (info) => new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(), info: bytes(info) }, secret, 256))
    .toBase64(B64);
  return { credential: await part('Tabdial sync credential'), key: await part('Tabdial sync key') };
}

// The list no longer travels in the browser's sync: left there, a later "Stop" would bring back what it held.
const leaveBrowserSync = async () => chrome.storage.sync.remove(Object.keys(await chrome.storage.sync.get(null))
  .filter((k) => ['meta', 'notes', 'todos'].includes(k) || /^[cnt]:/.test(k)));

// "stopped": the list was deleted from another of the user's browsers ("Stop everywhere"). This browser keeps its dials
// and goes back to the browser's own sync.
const stopped = async (err) => {
  if (err.code === 'stopped') await chrome.storage.sync.remove('syncCode');
  throw err;
};

// Settings, "Sync between browsers": a new code, with this browser's list as the first one stored under it. The code is
// kept only once the site has the list, so a code Settings shows always opens one.
export async function startSync(state) {
  const code = Array.from(crypto.getRandomValues(new Uint8Array(25)), (b) => LETTERS[b & 31]).join('').match(/.{5}/g).join('-');
  const { credential, key } = await keysOf(code);
  const list = await siteList(state, key);
  const look = lookOf(state.settings);
  const { index: notes, bodies } = await siteNotes(state, key);
  const todo = todos.synced(state.todos);
  const { version, missing = [] } = await ask('write', { credential, version: 0, payload: await seal(key, { v: 1, list, look, notes, todos: todo }), pictures: named(list, notes, bodies) }, SITE);
  // The time too: this page hears of its own new code (newtab.js) and needn't ask the site for what it just sent.
  await chrome.storage.local.set({ syncSeen: { space: credential, version, list, look: { theirs: look, mine: look }, notes, todos: todo }, syncCheckedAt: Date.now(), syncError: '', syncWanted: missing });
  await chrome.storage.sync.set({ syncCode: code });
  await leaveBrowserSync();
  return code;
}

// Settings, or the link another browser's Settings gave: sync this browser with that code. The caller then asks the site
// (store.js syncSite), which merges the list there with this browser's, or forgets a code the site has no list for.
export async function useCode(text) {
  const code = parseCode(text);
  if (!code) throw new Error(t('syncCodeInvalid'));
  await chrome.storage.local.set({ syncCheckedAt: Date.now() }); // as in startSync
  await chrome.storage.sync.set({ syncCode: code });
}

// Settings: stop here (this browser, and through its own sync the same browser on the user's other computers), or
// everywhere: then the list is deleted from the site, and the other browsers stop when they next ask for it. Every
// browser keeps its dials.
export async function stopSync(everywhere) {
  const code = await syncCode();
  if (code && everywhere) await ask('delete', { credential: (await keysOf(code)).credential }, SITE);
  await chrome.storage.sync.remove('syncCode');
}

// Ask the site for the list: at most once a minute per computer unless `now`, and never while a page is loading
// (store.js syncSite). Returns null if there was nothing new, else the `syncSeen` record to store with the changed
// state, as pull() does. A browser new to the code keeps its own dials and adds the list's (rule 2).
// "none", no list and never one: from a browser new to the code, the code is wrong, and forgotten. From one that has
// synced with it, the site has lost the list: this browser's is sent again by the save that follows (version 0).
export async function pullSite(state, now = false) {
  const code = syncOn(state) && await syncCode();
  if (!code || !(await siteAllowed())) return null;
  const { syncSeen: sent, syncCheckedAt = 0 } = await chrome.storage.local.get(['syncSeen', 'syncCheckedAt']);
  if (!now && Date.now() - syncCheckedAt < CHECK_EVERY) return null;
  await chrome.storage.local.set({ syncCheckedAt: Date.now() });
  const { credential, key } = await keysOf(code);
  const answer = await ask('read', { credential, version: viaSite(sent, credential)?.version || 0 }, SITE).catch(async (err) => {
    if (err.code !== 'none') return stopped(err);
    if (!viaSite(sent, credential)) {
      await chrome.storage.sync.remove('syncCode');
      throw err;
    }
    await chrome.storage.local.set({ syncSeen: { space: credential, version: 0, list: '' } });
    return {};
  });
  if (!answer.payload) return null;
  const { list, look, notes, todos: todo } = await opened(key, answer);
  // Read again: while the site was answering, a save may have sent this browser's list, or been given this very one.
  const seen = viaSite((await chrome.storage.local.get('syncSeen')).syncSeen, credential);
  if (seen?.version >= answer.version) return null;
  const unsent = seen ? await siteList(state, key) !== seen.list : ownGroups(state.groups).some((g) => g.dials.length);
  const have = await picturesOf(ownGroups(state.groups), key, state.notes);
  if (unsent) mergeList(state, list, have);
  else applyList(state, list, have);
  if (!seen) await leaveBrowserSync();
  return { space: credential, version: answer.version, list, look: look ? takeLook(state, lookOf(look), seen?.look) : seen?.look,
    notes: takeNotes(state, notes, seen?.notes, have), todos: takeTodos(state, todo, seen?.todos) };
}

// Send the list to the site if it changed. A failure is kept for Settings to show, and the next save or new tab tries
// again. Told that another browser wrote first, merge its list into this one (rule 1) and send that: the record
// returned then, and only then, is for the caller to store in the same write as the merged state. Stored on its own,
// it would say this browser has a list it could still lose by closing.
// `withLook` (pushLook): what this browser changed in the look goes too, and is reason enough to write. Every write
// carries the look as the site last had it, so a save that sends only the list doesn't drop it.
async function pushSite(state, code, withLook = false) {
  const { credential, key } = await keysOf(code);
  let seen = viaSite((await chrome.storage.local.get('syncSeen')).syncSeen, credential);
  if (!seen) return null; // rule 2: pullSite() merges first
  let merged = false;
  try {
    // ponytail: three tries. Two browsers writing over each other for longer are settled by the next save.
    for (let tries = 3; tries--;) {
      const list = await siteList(state, key);
      const changed = withLook ? lookChanges(state, seen.look) : {};
      const { index, bodies } = await siteNotes(state, key);
      const notes = withLook ? index : seen.notes; // as the site last had them, else
      const todo = withLook ? todos.synced(state.todos) : seen.todos;
      if (list === seen.list && !Object.keys(changed).length && JSON.stringify(notes) === JSON.stringify(seen.notes) && JSON.stringify(todo) === JSON.stringify(seen.todos)) break;
      const look = lookOf({ ...seen.look?.theirs, ...changed });
      const pictures = named(list, notes, bodies); // this browser's bodies too, so the site keeps what a later write names
      const answer = await ask('write', { credential, version: seen.version, payload: await seal(key, { v: seen.version + 1, list, look, ...(notes && { notes }), ...(todo && { todos: todo }) }), pictures }, SITE).catch((err) => {
        if (err.code === 'conflict') return err.answer;
        if (err.code === 'none') return { version: 0 }; // the site has lost the list: store it again
        return stopped(err);
      });
      if (answer.version === 0) seen = { space: credential, version: 0, list: '', look: seen.look, notes: seen.notes, todos: seen.todos };
      else if (answer.payload) {
        const { list: theirs, look: theirLook, notes: theirNotes, todos: theirTodos } = await opened(key, answer);
        const have = await picturesOf(ownGroups(state.groups), key, state.notes);
        mergeList(state, theirs, have);
        merged = true;
        seen = { space: credential, version: answer.version, list: theirs, look: theirLook ? takeLook(state, lookOf(theirLook), seen.look) : seen.look,
          notes: takeNotes(state, theirNotes, seen.notes, have), todos: takeTodos(state, theirTodos, seen.todos) };
      } else {
        seen = { space: credential, version: answer.version, list, look: { theirs: look, mine: { ...seen.look?.mine, ...changed } }, notes, todos: todo };
        if (!merged) await chrome.storage.local.set({ syncSeen: seen });
        if (answer.missing?.length) await want(answer.missing);
      }
    }
    await chrome.storage.local.set({ syncError: '' });
  } catch (err) {
    await chrome.storage.local.set({ syncError: err.message });
  }
  return merged ? seen : null;
}

// How much of the room sync has this browser's list, look and notes take: with a sync code, what the site keeps for a
// code (tabdial/web/api/sync.js MAX_PAYLOAD and MAX_PICTURES; worked out here from what would be sent, so close to,
// not exactly, what the site holds), else what the browser's own sync allows an extension. Settings shows it.
const SITE_TEXT = 200_000;
const SITE_PICTURES = 9_000_000;
const sealedLength = (chars) => Math.ceil((chars + 28) * 4 / 3); // AES-GCM's iv and tag, in base64
export async function usage(state) {
  const code = await syncCode();
  if (!code) return { browser: await chrome.storage.sync.getBytesInUse(null), most: chrome.storage.sync.QUOTA_BYTES || 102_400 };
  const { key } = await keysOf(code);
  const list = await siteList(state, key);
  const { index: notes, bodies } = await siteNotes(state, key);
  const have = await picturesOf(ownGroups(state.groups), key, state.notes);
  const pictures = named(list, notes, bodies).reduce((sum, id) => sum + (have.has(id) ? sealedLength(JSON.stringify(have.get(id)).length) : 0), 0);
  const text = sealedLength(new TextEncoder().encode(JSON.stringify({ v: 1, list, look: lookOf(state.settings), notes, todos: todos.synced(state.todos) })).length);
  return { text, textMost: SITE_TEXT, pictures, picturesMost: SITE_PICTURES };
}

// ---------- pictures ----------
// With a sync code, a dial's thumbnail and its site's icon go with it (the icon is put in by a browser that has it:
// newtab.js keepIcons). Not in the list, which would grow past what the site takes: each picture is kept by the site on
// its own, encrypted with the list's key, under an id that is a hash of the picture and that key. So a picture is sent
// once however many dials show it, and the site can tell neither what it shows nor whose icon it is. The list names
// the ids (siteList). A browser sends the pictures the site says it lacks (sendPictures) and fetches the ones it
// lacks itself (fetchPictures); a list is never held back for its pictures. A team's groups take their pictures to
// its members the same way, with the team's key (team.js), which is what the exports here are for.
export const isPicture = (ref) => /^[\w-]{22}$/.test(ref || ''); // a picture's id
const MAX_PICTURE = 300_000; // characters once encrypted: what the site takes
export const MAX_DATA = 200_000; // characters of a picture that fits that. A larger one stays in this browser, unnamed.
const BATCH = 40; // pictures in one request, as the site allows
const MAX_SENT = 900_000; // characters of pictures in one request

const ids = new Map(); // key → picture → id
async function pictureId(key, data) {
  if (!ids.has(key)) ids.set(key, new Map());
  const known = ids.get(key);
  if (!known.has(data)) known.set(data, new Uint8Array(await crypto.subtle.digest('SHA-256', bytes(`${key}\n${data}`))).subarray(0, 16).toBase64(B64));
  return known.get(data);
}

// What the site is told of a dial's thumbnail and of its icon: each the id of a picture, or nothing. A thumbnail that
// is a link is that link. A picture the dial was given by name and this browser hasn't fetched yet (pic, ico) goes on
// being named.
export async function refs(d, key) {
  const ref = (data, named) => (!data ? named || '' : !data.startsWith('data:') ? data : data.length > MAX_DATA ? '' : pictureId(key, data));
  return [await ref(d.image, d.pic), await ref(d.icon?.startsWith('data:') && d.icon, d.ico)];
}

// The notes as the site keeps them (notes.js forSite): an index in the list, each body and picture kept on its own as
// a dial's picture is, under its id; one too big for that is left out (a picture) or stays in the index (a body).
const siteId = (key) => (data) => (data.length > MAX_DATA ? '' : pictureId(key, data));
const siteNotes = (state, key) => forSite(state.notes, siteId(key), siteId(key));

// Take in the notes a payload holds (none from 0.4: then nothing changes), the pictures `have` has put back; returns
// what to remember of them.
function takeNotes(state, theirs, seen, have) {
  const notes = readSynced(theirs);
  if (!notes) return seen;
  state.notes = mergeNotes(state.notes, local(notes, have), revsOf(seen));
  return notes;
}

// The same for the to-dos.
function takeTodos(state, theirs, seen) {
  const rows = todos.readSynced(theirs);
  if (!rows) return seen;
  state.todos = todos.mergeTodos(state.todos, rows, seen);
  return rows;
}

// The list as the site keeps it: as listJson, and after each dial's title its thumbnail and then its icon (refs), left
// off at the end where there is none.
async function siteList(state, key) {
  const item = async (d) => {
    if (d.dials) return [d.id, d.name, await Promise.all(d.dials.map(item))];
    const row = [d.id, d.url, d.title, ...await refs(d, key)];
    while (row.length > 3 && !row.at(-1)) row.pop();
    return row;
  };
  return JSON.stringify(await Promise.all(ownGroups(state.groups).map(async (g) => [g.id, g.name, await Promise.all(g.dials.map(item))])));
}

// The ids of the pictures a list names, and the bodies and pictures of its notes (index, and the bodies this browser has).
const named = (list, notes, bodies = new Map()) => [...new Set(JSON.parse(list).flatMap(([, , ds]) => ds.flatMap((d) => (Array.isArray(d[2]) ? d[2] : [d])))
  .flatMap((d) => d.slice(3)).concat(namedBy(notes, bodies)).filter(isPicture))];

// The pictures this browser has in these groups, and the bodies and pictures of these notes, by id.
export async function picturesOf(groups, key, notes = []) {
  const have = await havePictures(notes, key);
  for (const [id, text] of notes.length ? (await forSite(notes, siteId(key), siteId(key))).bodies : []) have.set(id, text);
  for (const d of groups.flatMap(dialsOf)) {
    for (const data of [d.image, d.icon]) if (data?.startsWith('data:')) have.set(await pictureId(key, data), data);
  }
  return have;
}

// A dial as the site has it gets the pictures it names from those this browser has. A thumbnail named by anything but
// an id is a link, taken as it is; an icon is only ever a picture. What isn't here yet stays named.
export function withPictures(d, have) {
  for (const [name, field] of [['pic', 'image'], ['ico', 'icon']]) {
    const ref = d[name];
    if (!ref) continue;
    if (have.has(ref)) d[field] = have.get(ref);
    else if (isPicture(ref)) continue;
    else if (name === 'pic') d[field] = ref;
    delete d[name];
  }
}

const want = async (missing) => chrome.storage.local.set({ syncWanted: [...new Set([...(await chrome.storage.local.get('syncWanted')).syncWanted || [], ...missing])] });

// Send the pictures the site said it lacks (`syncWanted`, from a write's answer). Not in the queue of saves (store.js):
// many pictures take a while. What couldn't go stays wanted, for the next save or new tab. `full`: the list's pictures
// have reached what the site keeps for it, and the rest stay in this browser: `syncFull` says so, for Settings and the
// notes drawer, until a put fits again.
let sendingPictures = null;
export function sendPictures(state) {
  return sendingPictures ??= (async () => {
    const { syncWanted = [] } = await chrome.storage.local.get('syncWanted');
    const code = syncWanted.length && syncOn(state) && await syncCode();
    if (!code || !(await siteAllowed())) return;
    const { credential, key } = await keysOf(code);
    await sendBatches(key, await picturesOf(ownGroups(state.groups), key, state.notes), syncWanted,
      async (pictures) => {
        const answer = await ask('put', { credential, pictures }, SITE);
        await chrome.storage.local.set({ syncFull: Boolean(answer.full) });
        return answer;
      }, (left) => chrome.storage.local.set({ syncWanted: left }));
  })().finally(() => { sendingPictures = null; });
}

// Those of `wanted` that `have` has, encrypted and sent a request at a time: `put` sends one and answers as the site
// did, `left` is told what is still wanted after each.
export async function sendBatches(key, have, wanted, put, left) {
  for (wanted = wanted.filter((id) => have.has(id)); ;) {
    const pictures = {};
    const taken = [];
    for (let size = 0; taken.length < wanted.length && Object.keys(pictures).length < BATCH;) {
      const id = wanted[taken.length];
      const sealed = await seal(key, have.get(id));
      if (sealed.length <= MAX_PICTURE && size && size + sealed.length > MAX_SENT) break;
      taken.push(id);
      if (sealed.length > MAX_PICTURE) continue;
      pictures[id] = sealed;
      size += sealed.length;
    }
    const { full } = Object.keys(pictures).length ? await put(pictures) : {};
    wanted = full ? [] : wanted.slice(taken.length);
    await left(wanted);
    if (!wanted.length) return;
  }
}

// Fetch the pictures the list names that this browser doesn't have (withPictures left them named). Returns whether
// any came: the caller stores the state. One the site doesn't have yet (the browser that named it is still sending
// it) is asked for again with the next new tab.
// A note's body and pictures come the same way: the body first, then the pictures it names.
export async function fetchPictures(state) {
  const waiting = () => ownGroups(state.groups).flatMap(dialsOf).filter((d) => d.pic || d.ico);
  const code = (waiting().length || namedIn(state.notes).length) && syncOn(state) && await syncCode();
  if (!code || !(await siteAllowed())) return false;
  const { credential, key } = await keysOf(code);
  let got = false;
  while (await fetchInto(waiting(), key, (asked) => ask('get', { credential, ids: asked }, SITE), state.notes)) got = true;
  return got;
}

// `get` asks the site for some of the pictures these dials (and notes) name; one that isn't what its id says is left out.
export async function fetchInto(waiting, key, get, notes = []) {
  let got = false;
  for (let asking = [...new Set(waiting.flatMap((d) => [d.pic, d.ico]).concat(namedIn(notes)).filter(isPicture))]; asking.length;) {
    const { pictures } = await get(asking.slice(0, BATCH));
    const have = new Map();
    for (const [id, sealed] of Object.entries(pictures)) {
      const data = await unseal(key, sealed).catch(() => null);
      if (typeof data === 'string' && await pictureId(key, data) === id) have.set(id, data);
    }
    if (!have.size) asking = asking.slice(BATCH); // the site has none of these yet
    else {
      const images = new Map([...have].filter(([, data]) => data.startsWith('data:image/'))); // a note's body is text
      waiting.forEach((d) => withPictures(d, images));
      fill(notes, have);
      got = true;
      asking = asking.filter((id) => !have.has(id)); // those left may only not have fitted the answer: asked again
    }
  }
  return got;
}
