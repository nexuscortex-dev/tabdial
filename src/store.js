// All state lives in chrome.storage.local under one key; images are stored inline as data URLs
// (the extension has unlimitedStorage). The dial list is also mirrored to Chrome sync or, with a sync code, to
// nexuscortex.dev (sync.js). Team groups (team.js) sit among the user's own groups, but only the user's own groups are
// synced, copied daily and backed up.
import { pull, push, pullSite, pullLook, pushLook, pullNotes, pushNotes, syncCode, sendPictures, fetchPictures, NEW_LOOK } from './sync.js';
import { newNote } from './notes.js';
import { addMissing, countDials, dialsOf, fillImages, itemsIn, normalizeUrl, ownGroups, pick, withTeamGroups } from './merge.js';

export { normalizeUrl };
import { publishTeams, readOnly, sendTeamPictures } from './team.js';
import { t } from './i18n.js';

const KEY = 'tabdial';

export const uid = () => Math.random().toString(36).slice(2, 10);

export function emptyState() {
  return {
    groups: [{ id: uid(), name: t('defaultGroup'), dials: [] }],
    activeGroup: null,
    teams: {},
    settings: { ...NEW_LOOK },
    notes: [],
    todos: [],
  };
}

// Ids of the dials, folders and groups this page last loaded or saved. The service worker and every open new tab page each
// hold their own copy of the state; these tell a save which stored dials are new to this page and which it deleted.
let known = new Set();
const remember = (state) => { known = new Set([...state.groups.flatMap((g) => [g.id, ...itemsIn(g).map((d) => d.id)]), ...state.notes.map((n) => n.id), ...state.todos.map((x) => x.id)]); };

export async function load() {
  const got = await chrome.storage.local.get(KEY);
  const state = got[KEY] || emptyState();
  state.teams ||= {};
  state.notes ||= [];
  state.todos ||= [];
  if (typeof state.settings.note === 'string') { // the one plain note of 0.5 before it was released
    const html = state.settings.note.split('\n').map((line) => `<p>${escapeHtml(line) || '<br>'}</p>`).join('');
    if (state.settings.note.trim()) state.notes.push({ ...newNote(html), id: 'note-0.5', rev: 'note-0.5' }); // the same in every tab
    delete state.settings.note;
  }
  if (!state.groups.some((g) => g.id === state.activeGroup)) state.activeGroup = state.groups[0].id;
  remember(state);
  await syncNow(state);
  return state;
}

// Take in what the other computers synced: the list, and how the page looks. Each is marked as seen in the same write
// that stores it.
export async function syncNow(state) {
  const seen = await pull(state).catch(() => null);
  const look = await pullLook(state).catch(() => null);
  const notes = await pullNotes(state).catch(() => null);
  const todos = await pullNotes(state, 'todos').catch(() => null);
  if (seen || look || notes || todos) await save(state, { ...(seen && { syncSeen: seen }), ...(look && { lookSeen: look }), ...(notes && { notesSeen: notes }), ...(todos && { todosSeen: todos }) });
}

const escapeHtml = (text) => text.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

// A page's saves run one after another: a second one starting while the first is still publishing a team group would
// send the site the version the first started from, and be told another admin had changed the team.
// ponytail: each waits for the one before, a slow site included; have a waiting save stand for the later ones if they ever pile up.
let saving = Promise.resolve();
function queue(work) {
  const done = saving.then(work);
  saving = done.catch(() => {});
  return done;
}
// Resolves to whether the state now holds dials from another browser too (send), for the page to draw. Pictures the
// site asked for (sync.js, team.js) go once the save is out of the queue, so that a later save doesn't wait for them.
export async function save(state, alsoStore = {}) {
  const merged = await queue(() => store(state, alsoStore));
  await sendPictures(state).catch(() => {});
  await sendTeamPictures(state).catch(() => {});
  return merged;
}

// With a sync code the list comes from nexuscortex.dev (sync.js): asked for once the page is drawn, never while it
// loads, and not in the queue of saves, which must not wait for the site. Changes that couldn't be sent earlier go
// now. Returns whether the state changed.
export async function syncSite(state, now) {
  if (!(await syncCode())) return false;
  const seen = await pullSite(state, now);
  let changed = Boolean(seen);
  if (seen) await save(state, { syncSeen: seen });
  else {
    changed = await queue(() => send(state));
    await sendPictures(state).catch(() => {});
  }
  // The pictures the list names and this browser lacks: the dials are shown and stored without waiting for them.
  if (await fetchPictures(state).catch(() => false)) {
    await save(state);
    changed = true;
  }
  return changed;
}

// How the page looks goes to the user's other computers when the page says things have been quiet (newtab.js
// shareLook), not with every save: in the queue, as a save's own sending is. With a sync code it goes to the site
// with the list, whose answer may bring another browser's dials: they are stored as in send(). Resolves to whether
// the state changed.
// The notes and the to-dos go the same way (sync.js pushNotes), after taking in what another computer wrote in the browser's sync;
// with a sync code their bodies and pictures the site asked for go once out of the queue, as a save's do.
export async function sendLook(state) {
  const changed = await queue(async () => {
    const notes = await pullNotes(state).catch(() => null);
    const todos = await pullNotes(state, 'todos').catch(() => null);
    if (notes || todos) await write(state, { ...(notes && { notesSeen: notes }), ...(todos && { todosSeen: todos }) });
    const seen = await pushLook(state).catch(() => null);
    if (seen) await write(state, { syncSeen: seen });
    await pushNotes(state).catch(() => {});
    await pushNotes(state, 'todos').catch(() => {});
    return Boolean(seen || notes || todos);
  });
  await sendPictures(state).catch(() => {});
  return changed;
}

// Each save stamps a new revision so a page can tell its own writes from changes made elsewhere. An admin's change to a
// team group is published first (the site's version replaces it if another admin saved in between); what went wrong
// there is thrown once the save is stored.
async function store(state, alsoStore) {
  await backUpOncePerDay();
  const [problem] = await publishTeams(state);
  const { savedRev } = await chrome.storage.local.get('savedRev');
  if (savedRev && savedRev !== state.rev) await keepAdditionsFromElsewhere(state);
  await write(state, alsoStore);
  const merged = await send(state);
  if (problem) throw problem;
  return merged;
}

async function write(state, alsoStore) {
  state.rev = uid();
  await chrome.storage.local.set({ [KEY]: state, savedRev: state.rev, ...alsoStore });
  remember(state);
}

// Send the list on (sync.js). If the site answered that another browser had changed it first, that browser's dials are
// in the state now: it is stored again, with the mark that their list was seen. Returns whether that happened.
async function send(state) {
  const seen = await push(state).catch(() => null);
  if (seen) await write(state, { syncSeen: seen });
  return Boolean(seen);
}

// Someone else (the toolbar button, another tab) saved since this page loaded. Keep the dials they added;
// dials this page deleted stay deleted. A dial they added to a folder goes into that folder, wherever this page has it,
// or, if this page took the folder apart, into what held it (the folder around it, or the group). The stored data is only read when this happens. Team
// groups come from the site, not from other writers.
async function keepAdditionsFromElsewhere(state) {
  const { [KEY]: stored } = await chrome.storage.local.get(KEY);
  for (const g of ownGroups(stored?.groups || [])) {
    const here = new Set(state.groups.flatMap((x) => dialsOf(x).map((d) => d.id)));
    const added = pick(g.dials, (d) => !known.has(d.id) && !here.has(d.id));
    if (!added.length) continue;
    let group = state.groups.find((x) => x.id === g.id && !x.team);
    if (!group && known.has(g.id)) group = targetGroup(state); // a group this page deleted
    if (!group) state.groups.push(group = { id: g.id, name: g.name, dials: [] });
    const into = (list, items) => {
      for (const item of items) {
        const folder = item.dials && ownGroups(state.groups).flatMap(itemsIn).find((x) => x.dials && x.id === item.id);
        if (folder) into(folder.dials, item.dials);
        else if (item.dials && known.has(item.id)) into(list, item.dials);
        else list.push(item);
      }
    };
    into(group.dials, added);
  }
  // A note or a to-do written there that this page never had (one it deleted stays deleted).
  state.notes.push(...(stored?.notes || []).filter((n) => !known.has(n.id) && !state.notes.some((x) => x.id === n.id)));
  state.todos.push(...(stored?.todos || []).filter((n) => !known.has(n.id) && !state.todos.some((x) => x.id === n.id)));
}

// ---------- backups ----------
// Before the first change of each day, keep a copy of the dials as they were, so a bad import, a slip or a bug can be
// undone from Settings. 90 copies are kept; restoring also keeps what it replaced, so a restore can be undone. Copies
// past the newest 7 drop their thumbnails and settings (90 full copies could take hundreds of MB); restoring one takes
// thumbnails back from dials that still have them. Team groups are left out of the copies and
// stay as they are on restore: the site keeps the team's own copies.
export const COPIES = 90;
export const FULL_COPIES = 7;
export const BEFORE_RESTORE = 'before-restore';

async function backUpOncePerDay() {
  const day = new Date().toLocaleDateString('sv'); // YYYY-MM-DD, local time
  const { backups = [] } = await chrome.storage.local.get('backups');
  if (backups.some((b) => b.day === day)) return; // also covers a clock or time zone moving back a day
  const { [KEY]: current } = await chrome.storage.local.get(KEY); // read the full data only once a day
  const own = personal(current);
  if (countDials(own)) await keepBackup(day, own, backups);
}

const personal = (state) => state && { ...state, groups: ownGroups(state.groups), teams: undefined };

const noImage = (d) => (d.dials ? { ...d, dials: d.dials.map(noImage) } : { ...d, image: '' });

async function keepBackup(day, data, backups) {
  const all = [{ day, dials: countDials(data), groups: data.groups.length }, ...backups.filter((b) => b.day !== day)];
  const kept = all.slice(0, COPIES);
  const writes = { backups: kept, [`backup:${day}`]: data };
  for (const b of kept.slice(FULL_COPIES).filter((b) => !b.slim)) {
    const key = `backup:${b.day}`;
    const { [key]: copy } = await chrome.storage.local.get(key);
    if (copy) writes[key] = { groups: copy.groups.map((g) => ({ ...g, dials: g.dials.map(noImage) })), activeGroup: copy.activeGroup };
    b.slim = true;
  }
  await chrome.storage.local.set(writes);
  await chrome.storage.local.remove(all.filter((b) => !kept.includes(b)).map((b) => `backup:${b.day}`));
}

export async function listBackups() {
  return (await chrome.storage.local.get('backups')).backups || [];
}

// Put a backup's dials into state (the caller saves), keeping the current dials as "before restore".
export async function restoreBackup(state, day) {
  const key = `backup:${day}`;
  const { [key]: backup, backups = [], [KEY]: current } = await chrome.storage.local.get([key, 'backups', KEY]);
  if (!backup) throw new Error(t('copyGone'));
  if (countDials(personal(current))) await keepBackup(BEFORE_RESTORE, personal(current), backups);
  const own = ownGroups(backup.groups); // copies from before 0.3 never had team groups, but a group of their own
  fillImages(own, state.groups);
  state.groups = withTeamGroups(state.groups, own);
  state.activeGroup = backup.activeGroup;
}

// ---------- dials ----------
// "Article name - Site name | Tagline" is too long for a tile label; keep the part before the first separator.
// Short titles fit the tile, so they stay whole.
export function shortTitle(title) {
  const t = String(title || '').trim();
  if (t.length <= 24) return t;
  return t.split(/\s[-–—|·]\s/)[0].trim() || t;
}

// Where a dial added to groupId goes: that group, or the user's first own group if it's gone or they can't change it
// (a team group of a team they aren't an admin of).
export const targetGroup = (state, groupId) => state.groups.find((g) => g.id === groupId && !readOnly(state, g)) || ownGroups(state.groups)[0];

export function addDial(state, groupId, { url, title = '', image = '' }) {
  const group = targetGroup(state, groupId);
  const dial = { id: uid(), url: normalizeUrl(url), title, image };
  group.dials.push(dial);
  return dial;
}

// Ask for the most-visited list only when the user clicks, read it once, then give the permission back.
// Call it straight from the click handler, before any await: the permission request needs the click.
// Returns how many sites were added, or null if the user said no.
export async function addMostVisited(state, groupId) {
  if (!(await chrome.permissions.request({ permissions: ['topSites'] }))) return null;
  try {
    const sites = await chrome.topSites.get();
    const group = targetGroup(state, groupId);
    return addMissing(group, sites.map((s) => ({ id: uid(), url: normalizeUrl(s.url), title: shortTitle(s.title), image: '' })));
  } finally {
    await chrome.permissions.remove({ permissions: ['topSites'] });
  }
}
