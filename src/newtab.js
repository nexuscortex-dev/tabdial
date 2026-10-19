import { load, save, sendLook, syncNow, syncSite, uid, normalizeUrl, addDial, targetGroup, listBackups, restoreBackup, addMostVisited, shortTitle, tidyTitle, BEFORE_RESTORE, COPIES, FULL_COPIES } from './store.js';
import { parseImport, exportState, mergeImport, historyOn, permissionNote, infinityNotes, infinityTodos } from './import.js';
import { countDials, dialsOf, itemsIn, sameUrl, hostOf, ownGroups } from './merge.js';
import { syncCode, siteAllowed, parseCode, codeLink, startSync, useCode, stopSync, sendPictures, lookOf, usage, MAX_DATA, SYNC_DATA } from './sync.js';
import { newNote, edit, newestFirst, clean, mergeNotes, shown as readyNotes } from './notes.js';
import { newTodo, change, pending, finished, posBefore, synced as syncedTodos, readSynced as readTodos, mergeTodos, sectionOf, byDue, dayOf, SECTIONS, MAX_TEXT } from './todos.js';
import { readOnly, refreshTeams, fetchTeamPictures, sendTeamPictures, createTeam, peekTeam, joinTeam, leaveTeam, deleteTeam, listMembers, removeMember, replaceLink, setAdmin, listCopies, restoreCopy } from './team.js';
import { isPaid, checkPaid, recheckPaid, hasAskedToPay, openPaymentPage, unlockWithKey } from './pay.js';
import { suggestMoves, loose } from './sort.js';
import { remove, moveTo, putInFolder, takeOutOfFolder, undo, prune, hasAddress } from './select.js';
import { jumpList, jump, matching, searchBoxList } from './jump.js';
import { getDrive, connectDrive, backUpToDrive, readDriveBackup, disconnectDrive, signInNeeded, identity } from './drive.js';
import { t, plural, uiLanguage } from './i18n.js';

const $ = (sel) => document.querySelector(sel);

// The page's own text, in the browser's language: elements name their message in data-i18n (text), data-i18n-title,
// data-i18n-aria (aria-label) or data-i18n-placeholder.
document.documentElement.lang = uiLanguage();
const setters = { i18n: (el, s) => { el.textContent = s; }, i18nTitle: (el, s) => { el.title = s; },
  i18nAria: (el, s) => el.setAttribute('aria-label', s), i18nPlaceholder: (el, s) => { el.placeholder = s; } };
for (const [name, set] of Object.entries(setters)) {
  const attr = `data-${name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
  for (const el of document.querySelectorAll(`[${attr}]`)) set(el, t(el.getAttribute(attr)));
}
// Links to the guides on the website, in the same language: data-web is the page's path under webBase.
for (const a of document.querySelectorAll('[data-web]')) a.href = t('webBase') + a.dataset.web;

let state = await load();

const activeGroup = () => state.groups.find((g) => g.id === state.activeGroup) || state.groups[0];
const findDial = (id) => state.groups.flatMap(dialsOf).find((d) => d.id === id);
// A group's dials are its dials and its folders, folders in folders too (merge.js); these find things by the id of a
// dial or a folder.
const findFolder = (id) => state.groups.flatMap(itemsIn).find((d) => d.dials && d.id === id);
const folderOf = (id) => state.groups.flatMap(itemsIn).find((d) => d.dials?.some((c) => c.id === id)); // the one it is in
const groupOf = (id) => state.groups.find((g) => itemsIn(g).some((d) => d.id === id));
const listOf = (id) => folderOf(id)?.dials || groupOf(id)?.dials; // the list it sits in: its folder's, or its group's
// Team groups (team.js): only a team's admins change them, while the team isn't frozen.
const locked = (group) => readOnly(state, group);
const teamName = (group) => state.teams[group.team]?.name || '';
const adminTeams = () => Object.entries(state.teams).filter(([, team]) => team.admin && !team.frozen);

// Draw the change right away, then store it; a failed save is shown rather than lost silently. A team's problem
// (another admin saved first, a refund) may have put the site's version back, so the page is drawn again; so it is
// when the save brought dials another browser had synced meanwhile (sync.js).
const saveAndRender = () => {
  state.groups.forEach((g) => prune(g.dials)); // a folder exists only while it holds a dial (select.js)
  render();
  shareLook();
  return save(state).then((merged) => { if (merged) render(); },
    (err) => { render(); showError(err.name === 'TeamError' ? err.message : t('saveFailed', err.message)); });
};

// The settings for how the page looks go to the user's other computers and browsers (sync.js). A slider or the color
// picker saves many times a second; the browser allows an extension some 120 writes to its sync a minute, the dial
// list's among them, and with a sync code each would be a request to the site. So the look goes once things have been
// quiet for a moment. With a code, the site's answer may bring another browser's changes: the page is drawn again.
// ponytail: a change made in the last two seconds before the tab closes goes with the next new tab.
let lookTimer;
function shareLook() {
  clearTimeout(lookTimer);
  lookTimer = setTimeout(() => sendLook(state).then((changed) => changed && render(), () => {}), 2000);
}

let errorTimer;
function showError(message, note = false) {
  const box = $('#error');
  box.textContent = message;
  box.classList.toggle('note', note); // news rather than a problem
  box.hidden = false;
  clearTimeout(errorTimer);
  errorTimer = setTimeout(() => { box.hidden = true; }, 8000);
}

// '' = default, '#rrggbb' = a color, 'linear-gradient(…)' = a built-in gradient, 'photos/….webp' = a built-in photo,
// 'data:…' = an uploaded image.
const backgroundKind = (bg) => (!bg ? 'default' : bg.startsWith('#') ? 'color' : bg.startsWith('data:') ? 'image'
  : bg.startsWith('photos/') ? 'photo' : 'gradient');

// Whether the clock over a picked background needs light or dark text: a color or gradient by the average brightness
// of its colors, a built-in photo as its swatch says, an uploaded photo taken as dark (the light text gets a shadow).
// '' = the default background, which follows the theme.
function toneOf(bg) {
  if (!bg) return '';
  if (bg.startsWith('photos/')) return document.querySelector(`.swatch[data-bg="${CSS.escape(bg)}"]`)?.dataset.tone || 'dark';
  if (bg.startsWith('data:')) return 'dark';
  const colors = (bg.match(/#[0-9a-f]{6}/gi) || []).map((hex) => parseInt(hex.slice(1), 16));
  const luma = colors.reduce((sum, n) => sum + .299 * (n >> 16) + .587 * (n >> 8 & 255) + .114 * (n & 255), 0) / colors.length;
  return luma < 140 ? 'dark' : 'light';
}

// Chrome and Edge lend the extension their favicon cache; Firefox lends none, so there a site's icon is its own
// /favicon.ico, asked of the site itself. A dial that came with its icon (`icon`: with a sync code or in a team group,
// a browser that has the icon puts it in, keepIcons) shows that one everywhere, and no site is asked.
const browserIcons = chrome.runtime.getManifest().permissions.includes('favicon');
let iconOf = new Map(); // the icons dials came with, by address: render() keeps it

function faviconUrl(pageUrl, size = 64) {
  if (iconOf.has(pageUrl)) return iconOf.get(pageUrl);
  if (!browserIcons) {
    try {
      const { protocol, origin } = new URL(pageUrl);
      return /^https?:$/.test(protocol) ? `${origin}/favicon.ico` : '';
    } catch {
      return '';
    }
  }
  const u = new URL(chrome.runtime.getURL('/_favicon/'));
  u.searchParams.set('pageUrl', pageUrl);
  u.searchParams.set('size', String(size));
  return u.toString();
}

function hueOf(text) {
  let h = 0;
  for (const c of text) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}

function icon(id) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'i');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#${id}`);
  svg.append(use);
  return svg;
}

function thumbEl(url, image, title = '') {
  const box = document.createElement('div');
  box.className = 'thumb';
  if (image) {
    const img = new Image();
    img.className = 'cover';
    img.alt = '';
    img.src = image;
    box.append(img);
  } else if (url) {
    // The site's icon if the browser has one, else its first letter. Known icons are drawn right away; every icon is
    // checked again in the background, in case the browser got (or lost) it since.
    const cover = (rgb) => (rgb ? iconCover(url, rgb) : letterCover(url, title));
    const shown = icons[url] || null;
    box.append(cover(shown));
    findIcon(url).then((rgb) => { if (String(rgb) !== String(shown)) box.replaceChildren(cover(rgb)); });
  }
  return box;
}

function letterCover(url, title) {
  const host = hostOf(url);
  const fb = document.createElement('div');
  fb.className = 'fallback';
  fb.setAttribute('aria-hidden', 'true'); // the letter is decoration; the title is read from the label
  fb.style.setProperty('--hue', hueOf(host));
  const letter = document.createElement('span');
  letter.className = 'letter';
  letter.textContent = (title || host).charAt(0).toUpperCase();
  fb.append(letter);
  return fb;
}

function iconCover(url, rgb) {
  const cover = document.createElement('div');
  cover.className = 'site';
  if (rgb.length) cover.style.setProperty('--rgb', rgb.join(' '));
  const img = new Image();
  img.alt = '';
  img.src = faviconUrl(url, 32);
  cover.append(img);
  return cover;
}

// ---------- site icons ----------
// Icons come from the browser's own favicon cache (no request leaves the computer), mostly at 32 px, or in Firefox from
// the sites (faviconUrl). A cache of what was found, per address: [r, g, b] = the icon's main color, [] = a
// black-and-white icon, or one whose colors can't be read. Losing it costs nothing.
let icons = {};
try { icons = JSON.parse(localStorage.getItem('icons')) || {}; } catch {}
let blank; // the browser's stand-in globe for sites it has no icon for

async function pixels(src) {
  const img = new Image();
  img.src = src;
  await img.decode();
  const ctx = new OffscreenCanvas(32, 32).getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, 32, 32);
  return ctx.getImageData(0, 0, 32, 32).data;
}

// The most common strong color among the icon's opaque pixels (colors bucketed coarsely), or null if it has none.
function mainColor(data) {
  const buckets = new Map();
  for (let i = 0; i < data.length; i += 4) {
    const [r, g, b, a] = data.subarray(i, i + 4);
    if (a < 160 || Math.max(r, g, b) - Math.min(r, g, b) < 60) continue;
    const key = (r >> 5) << 6 | (g >> 5) << 3 | b >> 5;
    const sum = buckets.get(key) || [0, 0, 0, 0];
    buckets.set(key, [sum[0] + r, sum[1] + g, sum[2] + b, sum[3] + 1]);
  }
  const top = [...buckets.values()].sort((x, y) => y[3] - x[3])[0];
  return top?.[3] >= 6 ? top.slice(0, 3).map((v) => Math.round(v / top[3])) : null;
}

// Resolves to the color as stored in `icons`, or null when the site has no icon (the browser has none, or in Firefox,
// the site's /favicon.ico doesn't load).
async function findIcon(url) {
  let rgb = null;
  try {
    if (!browserIcons) {
      // another site's picture: Firefox may not let its colors be read, and then it gets the plain wash
      rgb = await pixels(faviconUrl(url)).then((data) => mainColor(data) || [], (e) => { if (e.name === 'SecurityError') return []; throw e; });
    } else {
      blank ??= pixels(faviconUrl('https://tabdial.invalid/', 32));
      const [data, none] = await Promise.all([pixels(faviconUrl(url, 32)), blank]);
      if (data.some((v, i) => v !== none[i])) rgb = mainColor(data) || [];
    }
  } catch {}
  if (String(rgb) !== String(icons[url] || null)) {
    if (rgb) icons[url] = rgb; else delete icons[url];
    try { localStorage.setItem('icons', JSON.stringify(icons)); } catch {}
  }
  return rgb;
}

// ---------- render ----------
// The settings for how the page looks, with what those the user never touched stand at.
const look = () => ({ size: 100, radius: 16, gap: 18, text: 13, font: '', theme: '', ...state.settings });

function render() {
  iconOf = new Map(state.groups.flatMap(dialsOf).filter((d) => d.icon).map((d) => [d.url, d.icon]));
  const { background, columns, size, radius, gap, text, font, theme } = look();
  const kind = backgroundKind(background);
  document.documentElement.dataset.theme = theme; // '' = as the browser is
  document.body.classList.toggle('no-titles', state.settings.titles === false);
  if (notesDialog.open) showNotes(); // e.g. changed on another computer
  drawTodos();
  document.body.style.backgroundColor = kind === 'color' ? background : '';
  document.body.style.backgroundImage = { default: '', color: 'none', gradient: background, image: `url("${background}")`, photo: `url("${background}")` }[kind];
  document.body.dataset.tone = toneOf(background);
  const { backgroundColor: color, backgroundImage: image } = document.body.style; // for paint.js
  try { localStorage.setItem('paint', JSON.stringify({ theme, font, ...(kind !== 'image' && { color, image, tone: document.body.dataset.tone }) })); } catch {}
  document.documentElement.style.setProperty('--cols', columns);
  document.documentElement.style.setProperty('--tile', `${216 * size / 100 - 18 + gap}px`); // a wider gap moves the dials apart, it doesn't shrink them
  document.documentElement.style.setProperty('--gap', `${gap}px`);
  document.documentElement.style.setProperty('--text', `${text}px`);
  document.documentElement.style.setProperty('--font', font && `"${font}"`); // '' = the usual one
  document.documentElement.style.setProperty('--radius', `${radius}px`);
  for (const sw of document.querySelectorAll('.swatch[data-bg]')) sw.setAttribute('aria-pressed', String(sw.dataset.bg === background));
  $('.swatch.custom').classList.toggle('on', kind === 'color');
  $('.swatch.custom').style.backgroundColor = kind === 'color' ? background : '';
  $('.swatch.upload').classList.toggle('on', kind === 'image');
  $('.swatch.upload').style.backgroundImage = kind === 'image' ? `url("${background}")` : '';

  const nav = $('#groups');
  nav.replaceChildren(...state.groups.map((g) => {
    const b = document.createElement('button');
    if (g.team) { // the team mark
      b.append(icon('i-team'));
      b.setAttribute('aria-description', t('teamMark', teamName(g)));
    }
    b.append(g.name);
    b.dataset.group = g.id;
    b.title = g.team ? t('teamMark', teamName(g)) : t('renameHint');
    b.setAttribute('aria-current', String(g.id === activeGroup().id));
    b.addEventListener('click', () => { state.activeGroup = g.id; saveAndRender(); });
    b.addEventListener('dblclick', () => { if (!locked(g)) openGroupDialog(g); });
    b.addEventListener('contextmenu', (e) => openGroupMenu(e, g));
    b.addEventListener('dragover', (e) => { if (dragId && !locked(g)) { e.preventDefault(); b.classList.add('drop-target'); } });
    b.addEventListener('dragleave', () => b.classList.remove('drop-target'));
    b.addEventListener('drop', (e) => {
      e.preventDefault();
      b.classList.remove('drop-target');
      const added = adopt(g.id);
      // not into a group that has its address already (a folder: any of its dials')
      const item = listOf(dragId)?.find((d) => d.id === dragId);
      if (item && groupOf(dragId) !== g && hasAddress(g, item)) return showError(t('alreadyIn', g.name), true);
      if (moveDial(dragId, g.id) || added) saveAndRender();
    });
    return b;
  }));

  const group = activeGroup();
  const fixed = locked(group);
  $('#sort-group').hidden = Boolean(group.team) || ownGroups(state.groups).length < 2 || !loose(group).length; // never on team groups
  const team = state.teams[group.team];
  $('#team-note').hidden = !team || Boolean(query.trim());
  if (team) $('#team-note').textContent = team.admin && team.frozen ? t('teamFrozen') : t(team.admin ? 'teamGroupAdmin' : 'teamGroupMember', team.name);
  // While the Search box has words in it, the grid shows the matching dials of every group instead: no dragging there.
  $('#search-box').hidden = state.settings.searchBox === false;
  const found = query.trim() ? matching(searchBoxList(state.groups, group.id), query).map((c) => c.dial) : null;
  const dials = found || group.dials;
  checkPicking();
  const still = fixed || Boolean(picking); // nothing dragged while ticking
  const items = dials.map((d) => (d.dials ? folderTile(d, !still) : dialTile(d, !found && !still, found ? locked(groupOf(d.id)) : fixed)));
  $('#select').hidden = fixed || Boolean(found) || !group.dials.length;
  $('#select').setAttribute('aria-pressed', String(Boolean(picking && !picking.folder)));

  gridCount = dials.length ? dials.length + (found || fixed ? 0 : 1) : 0;
  fitGrid();
  if (found) $('#grid').replaceChildren(...items, ...(found.length ? [] : [noMatch()]));
  else if (fixed) $('#grid').replaceChildren(...items, ...(group.dials.length ? [] : [noMatch(t('teamGroupEmpty'))]));
  else $('#grid').replaceChildren(...items, group.dials.length || group.team ? addTile() : welcome());
  markPicked($('#grid'), picking && !picking.folder);
  if (folderDialog.open) renderFolder();
  showSelectBar();
}

// As many columns as Settings asks, but fewer when the window is too narrow for dials MIN_DIAL wide (a title in a
// narrower dial is cut to a few letters), or as wide as Settings makes them when that is less.
const MIN_DIAL = 140;
let gridCount = 0; // the tiles in the grid, the add tile included
function fitGrid() {
  const { columns, gap, size } = look();
  const grid = $('#grid');
  const least = Math.min(MIN_DIAL, 216 * size / 100 - 18);
  const cols = Math.max(1, Math.min(columns, Math.floor((grid.clientWidth + gap) / (least + gap))));
  grid.style.setProperty('--c', cols);
  grid.style.setProperty('--n', gridCount ? Math.min(gridCount, cols) : cols);
}
addEventListener('resize', () => { fitGrid(); clearClock(); });

// `copy`: a dial of a group the user can't change can be copied into their own groups instead.
function dialTile(d, movable, copy) {
  const li = document.createElement('li');
  li.draggable = movable;
  li.dataset.id = d.id;
  const a = document.createElement('a');
  a.className = 'tile';
  a.href = d.url;
  a.draggable = false;
  const meta = document.createElement('div');
  meta.className = 'meta';
  const fav = new Image();
  fav.alt = '';
  fav.onerror = () => fav.remove(); // a site without an icon in Firefox: the title stands alone
  fav.src = faviconUrl(d.url, 32);
  const label = document.createElement('span');
  label.className = 'label';
  label.textContent = tidyTitle(d.title) || hostOf(d.url);
  // The site's icon beside the title only under a picture: over the site's own icon it would say the same twice.
  meta.append(...(d.image ? [fav] : []), label);
  if (state.settings.titles === false) a.title = label.textContent; // with the titles hidden, a tile still has its name
  a.append(thumbEl(d.url, d.image, d.title), meta);
  const edit = document.createElement('button');
  edit.className = 'edit';
  edit.append(icon(copy ? 'i-copy' : 'i-edit'));
  edit.title = t(copy ? 'copyToMyGroup' : 'edit');
  edit.setAttribute('aria-label', t(copy ? 'copyNamed' : 'editNamed', label.textContent));
  edit.addEventListener('click', () => openDialDialog(d, copy));
  li.append(a, edit);
  if (movable) wireDrag(li);
  return li;
}

// A folder shows its first four dials in small, those of the folders in it included; clicking it opens it.
function folderTile(folder, movable) {
  const li = document.createElement('li');
  li.draggable = movable;
  li.dataset.id = folder.id;
  const button = document.createElement('button');
  button.className = 'tile folder';
  button.draggable = false;
  const four = document.createElement('div');
  four.className = 'four';
  four.append(...dialsOf(folder).slice(0, 4).map((d) => thumbEl(d.url, d.image, d.title)));
  const meta = document.createElement('div');
  meta.className = 'meta';
  const label = document.createElement('span');
  label.className = 'label';
  label.textContent = folder.name;
  const count = document.createElement('span');
  count.className = 'count';
  count.textContent = plural(dialsOf(folder).length, 'nDials');
  meta.append(label, count);
  if (state.settings.titles === false) button.title = folder.name;
  button.append(four, meta);
  button.addEventListener('click', () => openFolder(folder.id));
  li.append(button);
  if (movable) wireDrag(li);
  return li;
}

// ---------- folder ----------
// An open folder: its dials and folders over the page, its name to change at the top. A folder in it opens in its
// place, with a way back up to the one around it. Dragging a dial or folder out of it closes it, so it can be dropped
// in the group behind.
const folderDialog = $('#folder-dialog');
let openFolderId = null; // by id, for the same reason as editingId

function openFolder(id) {
  openFolderId = id;
  if (!folderDialog.open) folderDialog.showModal();
  renderFolder();
}
function renderFolder() {
  const folder = findFolder(openFolderId);
  if (!folder) return folderDialog.close(); // emptied or deleted, here or elsewhere
  const fixed = locked(groupOf(folder.id));
  const up = folderOf(folder.id);
  $('#folder-up').hidden = !up;
  $('#folder-up-name').textContent = up?.name || '';
  $('#folder-name').value = folder.name;
  $('#folder-name').readOnly = fixed;
  checkPicking();
  const still = fixed || Boolean(picking);
  $('#folder-grid').replaceChildren(...folder.dials.map((d) => (d.dials ? folderTile(d, !still) : dialTile(d, !still, fixed))));
  $('#folder-select').hidden = fixed;
  $('#folder-select').setAttribute('aria-pressed', String(Boolean(picking?.folder)));
  markPicked($('#folder-grid'), picking?.folder);
  showSelectBar(); // e.g. ended by going up to the folder around this one
}
$('#folder-up').addEventListener('click', () => { const up = folderOf(openFolderId); if (up) openFolder(up.id); });
$('#folder-name').addEventListener('change', (e) => {
  const folder = findFolder(openFolderId);
  if (!folder) return;
  folder.name = e.target.value.trim() || t('folder');
  saveAndRender();
});
// Over the dimmed page around the folder, the dialog itself is what's under the pointer.
folderDialog.addEventListener('dragover', (e) => {
  const r = folderDialog.getBoundingClientRect();
  const outside = e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
  if (dragId && outside) folderDialog.close();
});

folderDialog.addEventListener('close', () => {
  if (picking?.folder) { picking = null; render(); }
  for (const bar of [$('#select-bar'), $('#undo-bar')]) if (folderDialog.contains(bar)) $('#error').before(bar);
});

// ---------- Selection ----------
// Ticking dials and folders of one list, a group's or an open folder's, to delete or move them at once (select.js).
// `picking` says whose list ({ group } or { folder }, by id) and holds the ids ticked; it ends with an action, Done or
// Esc, and when that list leaves the screen (another group, the folder closed or another opened, words in the Search
// box). While it lasts a click on a tile ticks it, and nothing is dragged.
let picking = null;
const NEW_ITEM = '+'; // the "New group" and "New folder" choices; '+' is nobody's id
const pickList = () => (picking?.folder ? findFolder(picking.folder)?.dials : state.groups.find((g) => g.id === picking?.group)?.dials);
const ticked = () => [...picking.ids];

function startPicking(folder) {
  picking = { ...(folder ? { folder: openFolderId } : { group: activeGroup().id }), ids: new Set(), anchor: null };
  render();
}
function endPicking() {
  picking = null;
  render();
}
// Still on screen, and only what is still in the list ticked (another tab or computer may have changed it).
function checkPicking() {
  if (!picking) return;
  const list = pickList();
  const here = picking.folder ? folderDialog.open && openFolderId === picking.folder && list && !locked(groupOf(picking.folder))
    : !folderDialog.open && picking.group === activeGroup().id && !query.trim() && list && !locked(activeGroup());
  if (!here) { picking = null; return; }
  const ids = new Set(list.map((d) => d.id));
  for (const id of picking.ids) if (!ids.has(id)) picking.ids.delete(id);
}
function markPicked(grid, on) {
  grid.classList.toggle('selecting', Boolean(on));
  for (const li of grid.querySelectorAll(':scope > li[data-id]')) {
    const tile = li.querySelector('.tile');
    li.classList.toggle('picked', Boolean(on) && picking.ids.has(li.dataset.id));
    if (on) {
      tile.setAttribute('role', 'checkbox');
      tile.setAttribute('aria-checked', String(picking.ids.has(li.dataset.id)));
    } else {
      tile.removeAttribute('role');
      tile.removeAttribute('aria-checked');
    }
  }
}
// One tick on or off; with Shift, every one from the last ticked to this one on.
function pick(id, range) {
  const ids = pickList().map((d) => d.id);
  if (range && ids.includes(picking.anchor)) {
    const [a, b] = [ids.indexOf(picking.anchor), ids.indexOf(id)].sort((x, y) => x - y);
    for (const x of ids.slice(a, b + 1)) picking.ids.add(x);
  } else {
    if (!picking.ids.delete(id)) picking.ids.add(id);
    picking.anchor = id;
  }
  markPicked(picking.folder ? $('#folder-grid') : $('#grid'), true);
  showSelectBar();
}
for (const grid of [$('#grid'), $('#folder-grid')]) {
  const mine = () => picking && (grid.id === 'folder-grid') === Boolean(picking.folder);
  grid.addEventListener('click', (e) => {
    const li = e.target.closest('li[data-id]');
    if (!mine() || li?.parentElement !== grid) return;
    e.preventDefault();
    e.stopPropagation();
    pick(li.dataset.id, e.shiftKey);
  }, true);
  // Space ticks a dial as it does a folder (a button); Enter is a click
  grid.addEventListener('keydown', (e) => {
    if (mine() && e.key === ' ' && e.target.matches('a.tile')) { e.preventDefault(); pick(e.target.closest('li').dataset.id, e.shiftKey); }
  });
}
$('#select').addEventListener('click', () => (picking ? endPicking() : startPicking(false)));
$('#folder-select').addEventListener('click', () => (picking ? endPicking() : startPicking(true)));
$('#select-done').addEventListener('click', endPicking);
// Esc and Delete, unless a dialog over the list has the keys (naming a new group) or the cursor is in a field
document.addEventListener('keydown', (e) => {
  if (!picking || document.querySelector('dialog[open]:not(#folder-dialog)')) return;
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); endPicking(); }
  else if ((e.key === 'Delete' || e.key === 'Backspace') && !e.target.closest('input, textarea, select, [contenteditable]')) {
    e.preventDefault();
    $('#select-delete').click();
  }
}, true);

// The bar: how many are ticked, and what to do with them. In an open folder it is the folder's, at its foot.
function showSelectBar() {
  const bar = $('#select-bar');
  bar.hidden = !picking;
  if (!picking) return;
  if (picking.folder ? !folderDialog.contains(bar) : folderDialog.contains(bar)) (picking.folder ? folderDialog.append(bar) : $('#error').before(bar));
  const list = pickList() || [];
  const n = picking.ids.size;
  $('#select-count').textContent = plural(n, 'nSelected');
  $('#select-all').textContent = t(list.length && n === list.length ? 'selectNone' : 'selectAll');
  const label = (key) => Object.assign(new Option(t(key), ''), { disabled: true, hidden: true, selected: true });
  const here = picking.folder ? groupOf(picking.folder) : activeGroup();
  $('#select-move').replaceChildren(label('moveTo'),
    ...state.groups.filter((g) => g !== here && !locked(g)).map((g) => new Option(g.team ? `${g.name} · ${teamName(g)}` : g.name, g.id)),
    new Option(t('newGroupDots'), NEW_ITEM));
  // the folders in this list, those in them named after them ("Work / Docs"), but none ticked or inside one ticked
  const folders = (items, path) => items.filter((d) => d.dials && !picking.ids.has(d.id))
    .flatMap((f) => [new Option(path + f.name, f.id), ...folders(f.dials, `${path + f.name} / `)]);
  $('#select-folder').replaceChildren(label('putInFolder'), ...folders(list, ''), new Option(t('newFolder'), NEW_ITEM));
  $('#select-out').hidden = !picking.folder;
  for (const el of bar.querySelectorAll('.act')) el.disabled = !n;
}
$('#select-all').addEventListener('click', () => {
  const ids = pickList().map((d) => d.id);
  picking.ids = new Set(ids.every((id) => picking.ids.has(id)) ? [] : ids);
  markPicked(picking.folder ? $('#folder-grid') : $('#grid'), true);
  showSelectBar();
});
$('#select-delete').addEventListener('click', () => {
  if (!picking?.ids.size) return;
  const record = remove(state, ticked());
  picking = null;
  saveAndRender();
  offerUndo(t('deletedItems', plural(record.places.length, 'nItems')), record);
});
$('#select-move').addEventListener('change', (e) => {
  const to = e.target.value;
  e.target.value = '';
  if (!picking?.ids.size || !to) return;
  if (to === NEW_ITEM) openGroupDialog(null, ticked());
  else moveTicked(ticked(), to);
});
function moveTicked(ids, groupId, newGroup = false) {
  const { record, moved, kept } = moveTo(state, ids, groupId, newGroup);
  const name = state.groups.find((g) => g.id === groupId)?.name;
  picking = null;
  saveAndRender();
  offerUndo([moved.length && t('movedItems', plural(moved.length, 'nItems'), name),
    kept.length && t('keptItems', plural(kept.length, 'nItems'), name)].filter(Boolean).join(' '), moved.length ? record : null);
}
$('#select-folder').addEventListener('change', (e) => {
  const to = e.target.value;
  e.target.value = '';
  if (!picking?.ids.size || !to) return;
  const fresh = to === NEW_ITEM && { id: uid(), name: t('folder') };
  const { record, folder } = putInFolder(state, ticked(), fresh ? null : to, fresh);
  if (!folder) return;
  picking = null;
  saveAndRender();
  if (fresh) { // open, its name ready to be typed over
    openFolder(folder.id);
    $('#folder-name').focus();
    $('#folder-name').select();
  }
  offerUndo(t('putIntoFolder', plural(record.places.length, 'nItems'), folder.name), record);
});
$('#select-out').addEventListener('click', () => {
  const folder = findFolder(picking?.folder);
  if (!picking?.ids.size || !folder) return;
  const record = takeOutOfFolder(state, ticked());
  picking = null;
  saveAndRender();
  offerUndo(t('tookOutOfFolder', plural(record.places.length, 'nItems'), folder.name), record);
});

// What was just done, with a way back for a few seconds (none when `record` is null). Over an open folder it is shown
// in it: the page behind can't be clicked then.
let undoTimer;
let undoRecord = null;
function offerUndo(message, record) {
  if (!message) return;
  const bar = $('#undo-bar');
  undoRecord = record;
  bar.querySelector('span').textContent = message;
  bar.querySelector('button').hidden = !record;
  if (folderDialog.open) folderDialog.append(bar);
  else $('#error').before(bar);
  bar.hidden = false;
  clearTimeout(undoTimer);
  undoTimer = setTimeout(() => { bar.hidden = true; undoRecord = null; }, 8000);
}
$('#undo-bar button').addEventListener('click', () => {
  const record = undoRecord;
  $('#undo-bar').hidden = true;
  undoRecord = null;
  clearTimeout(undoTimer);
  if (record && undo(state, record)) saveAndRender();
});

function noMatch(message = t('searchNoMatch')) {
  const li = document.createElement('li');
  li.className = 'empty';
  const text = document.createElement('p');
  text.textContent = message;
  li.append(text);
  return li;
}

function addTile() {
  const add = document.createElement('li');
  add.className = 'add';
  const addBtn = document.createElement('button');
  addBtn.className = 'tile add-tile';
  const plus = document.createElement('span');
  plus.className = 'plus';
  plus.append(icon('i-plus'));
  addBtn.append(plus, t('addSite'));
  addBtn.addEventListener('click', () => openDialDialog(null));
  add.append(addBtn);
  return add;
}

// An empty group: a welcome on first run, otherwise a word about this group.
function welcome() {
  const li = document.createElement('li');
  li.className = 'empty';
  const first = !countDials(state);
  const heading = document.createElement('h2');
  heading.textContent = t(first ? 'welcomeTitle' : 'emptyGroupTitle');
  const text = document.createElement('p');
  text.textContent = t(first ? 'welcomeText' : 'emptyGroupText');
  const top = document.createElement('button');
  top.className = 'btn';
  top.textContent = t('addYourMostVisited');
  top.addEventListener('click', addTopSites);
  const add = document.createElement('button');
  add.className = 'btn secondary';
  add.textContent = t('addSite');
  add.addEventListener('click', () => openDialDialog(null));
  const row = document.createElement('div');
  row.className = 'row';
  row.append(top, add);
  const importLink = document.createElement('button');
  importLink.className = 'link-btn';
  importLink.textContent = t('importFromOther');
  importLink.addEventListener('click', () => {
    $('#open-settings').click();
    showTab('data');
  });
  li.append(heading, text, row, importLink);
  return li;
}

// ---------- Search box ----------
// What's typed in it; the page can't put the cursor there on opening (the browser gives it to the address bar).
let query = '';
$('#search').addEventListener('input', (e) => { query = e.target.value; render(); });
$('#search').addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && query) { e.target.value = query = ''; render(); }
});
$('#search-box').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await jump(searchBoxList(state.groups, activeGroup().id), query);
  } catch (err) {
    showError(err.message);
  }
});

// ---------- clock ----------
const timeFormat = new Intl.DateTimeFormat(uiLanguage(), { hour: 'numeric', minute: '2-digit' });
const dateFormat = new Intl.DateTimeFormat(uiLanguage(), { weekday: 'long', month: 'long', day: 'numeric' });
function tick() {
  const now = new Date();
  // AM/PM left out: at this size the hour alone reads fine.
  $('#clock').textContent = timeFormat.formatToParts(now).filter((p) => p.type !== 'dayPeriod').map((p) => p.value).join('').trim();
  $('#date').textContent = dateFormat.format(now);
  clearClock(); // the to-do card steps aside from the time as it is now
  drawTodos(); // a to-do due moves on to today, or gone by, when its day or time comes
  setTimeout(tick, 60e3 - (now % 60e3));
}

// ---------- drag and drop ----------
// A dial or a folder is dragged by its tile, in a group or in an open folder. Dropped on the left edge of a tile it
// goes before it; on the rest of the tile, it goes into the folder there, or a dial makes a folder with the dial
// there. A folder dropped on a dial only ever goes before it, and never goes into itself or a folder inside it.
let dragId = null;
// A page dragged from the drawer (bookmarks and history) is a new dial that is in no list until it is dropped: adopt()
// then puts it at the end of the group it lands in, or, if that group has the address already, drags that dial instead,
// and the drop goes on as for any dial. True if a dial was added.
let dragNew = null;
function adopt(groupId = activeGroup().id) {
  if (!dragNew) return false;
  const group = targetGroup(state, groupId);
  const same = dialsOf(group).find((d) => sameUrl(d.url, dragNew.url));
  if (same) dragId = same.id;
  else group.dials.push(dragNew);
  dragNew = null;
  return !same;
}
function endDrag() {
  dragId = dragNew = null;
  document.querySelectorAll('.dragging, .drop-before, .drop-into').forEach((n) => n.classList.remove('dragging', 'drop-before', 'drop-into'));
}

const dropsInto = (li, e) => {
  const r = li.getBoundingClientRect();
  return Boolean(dragNew || findDial(dragId) || findFolder(li.dataset.id)) && e.clientX - r.left > r.width * .3;
};
// Whether `id` is the folder being dragged or inside it: what it can't be dropped on.
const inDragged = (id) => { const f = findFolder(dragId); return Boolean(f) && (id === f.id || itemsIn(f).some((d) => d.id === id)); };
// Takes a dial or a folder out of the list it is in.
function take(id) {
  const list = listOf(id);
  return list.splice(list.findIndex((d) => d.id === id), 1)[0];
}
function placeBefore(id, beforeId) {
  const item = take(id);
  const list = listOf(beforeId);
  list.splice(list.findIndex((d) => d.id === beforeId), 0, item);
}
function putInto(id, targetId) {
  const dial = take(id);
  const folder = findFolder(targetId);
  if (folder) return folder.dials.push(dial);
  const list = listOf(targetId);
  const i = list.findIndex((d) => d.id === targetId);
  list[i] = { id: uid(), name: t('folder'), dials: [list[i], dial] };
}

function wireDrag(li) {
  li.addEventListener('dragstart', (e) => {
    dragId = li.dataset.id;
    li.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', dragId);
  });
  li.addEventListener('dragend', endDrag);
  li.addEventListener('dragover', (e) => {
    if (!dragId || inDragged(li.dataset.id)) return;
    e.preventDefault();
    document.querySelectorAll('.drop-before, .drop-into').forEach((n) => n.classList.remove('drop-before', 'drop-into'));
    li.classList.add(dropsInto(li, e) ? 'drop-into' : 'drop-before');
  });
  li.addEventListener('drop', (e) => {
    e.preventDefault();
    adopt();
    if (inDragged(li.dataset.id) || !listOf(dragId) || !listOf(li.dataset.id)) return; // or gone meanwhile
    if (dropsInto(li, e)) putInto(dragId, li.dataset.id);
    else placeBefore(dragId, li.dataset.id);
    saveAndRender();
  });
}
// Dropping on the "+" tile moves the dial or folder to the end; a dial from a folder leaves it.
$('#grid').addEventListener('dragover', (e) => { if (dragId && e.target.closest('.add')) e.preventDefault(); });
$('#grid').addEventListener('drop', (e) => {
  if (!dragId || !e.target.closest('.add')) return;
  e.preventDefault();
  adopt();
  if (listOf(dragId)) { activeGroup().dials.push(take(dragId)); saveAndRender(); }
});

// Returns true if the dial or folder moved; the caller saves. It goes to the end of the group, a dial from a folder
// leaving it, also when the group is its own. Never into or out of a group the user can't change.
function moveDial(id, groupId) {
  const from = groupOf(id);
  const to = state.groups.find((g) => g.id === groupId);
  if (!from || !to || locked(from) || locked(to) || to.dials.some((d) => d.id === id)) return false;
  to.dials.push(take(id));
  return true;
}

// Cancel is a plain button, not a submit one: Enter in a field submits with the form's first submit button, Save.
for (const b of document.querySelectorAll('[data-close]')) b.addEventListener('click', () => b.closest('dialog').close());

// ---------- dial dialog ----------
const dialDialog = $('#dial-dialog');
const dialForm = $('#dial-form');
let editingId = null; // by id, not object: the state is reloaded when another tab or computer changes it
let pendingImage = '';

function refreshPreview() {
  $('#dial-preview').replaceWith(Object.assign(thumbEl(normalizeUrl(dialForm.url.value), pendingImage, dialForm.title.value.trim()), { id: 'dial-preview' }));
  $('#dial-preview').classList.add('preview');
  $('#clear-image').hidden = !pendingImage;
}

// `copy`: a dial of a team group the user can't change, copied as a new dial into one of their own groups.
function openDialDialog(dial, copy = false) {
  editingId = copy ? null : dial?.id ?? null;
  pendingImage = copy ? '' : dial?.image || '';
  $('#dial-heading').textContent = t(copy ? 'copyToMyGroup' : dial ? 'editDial' : 'addDial');
  $('#delete-dial').hidden = !editingId;
  $('#dial-from-drawer').hidden = Boolean(dial || copy);
  dialForm.reset();
  dialForm.url.value = dial?.url || '';
  dialForm.title.value = dial?.title || '';
  // Only groups the user can change; a team group says whose it is (an own group may have the same name).
  dialForm.group.replaceChildren(...state.groups.filter((g) => !locked(g)).map((g) => new Option(g.team ? `${g.name} · ${teamName(g)}` : g.name, g.id)));
  dialForm.group.value = editingId ? groupOf(dial.id).id : targetGroup(state, copy ? null : activeGroup().id).id;
  listFolders(editingId && folderOf(dial.id)?.id);
  checkUrl();
  refreshPreview();
  dialDialog.returnValue = '';
  dialDialog.showModal();
}

// The folder field: none, one of the chosen group's folders (one in another named after it: "Work / Docs"), or a new
// one. '+' can't be a folder's id.
const NEW_FOLDER = '+';
function listFolders(selected) {
  const group = state.groups.find((g) => g.id === dialForm.group.value);
  const options = (list, path) => list.filter((d) => d.dials).flatMap((f) => [new Option(path + f.name, f.id), ...options(f.dials, `${path + f.name} / `)]);
  dialForm.folder.replaceChildren(new Option(t('noFolder'), ''), ...options(group?.dials || [], ''), new Option(t('newFolder'), NEW_FOLDER));
  dialForm.folder.value = selected || '';
}

// An address that isn't one, or that the chosen group already has, stops Save; the browser shows why at the field.
function checkUrl() {
  const url = normalizeUrl(dialForm.url.value);
  const group = state.groups.find((g) => g.id === dialForm.group.value);
  dialForm.url.setCustomValidity(dialForm.url.value.trim() && !url ? t('invalidUrl')
    : url && group && dialsOf(group).some((d) => d.id !== editingId && sameUrl(d.url, url)) ? t('alreadyIn', group.name)
    : '');
}
dialForm.url.addEventListener('input', checkUrl);
dialForm.group.addEventListener('change', () => { listFolders(); checkUrl(); });
dialForm.url.addEventListener('change', refreshPreview);
dialForm.title.addEventListener('change', refreshPreview);
dialForm.imageFile.addEventListener('change', async () => {
  const file = dialForm.imageFile.files[0];
  if (!file) return;
  try {
    pendingImage = await readAsDataUrl(file, 640);
    refreshPreview();
  } catch {
    showError(t('imageUnreadable'));
  }
});
dialForm.imageUrl.addEventListener('change', () => { pendingImage = dialForm.imageUrl.value.trim(); refreshPreview(); });
$('#dial-from-drawer').addEventListener('click', () => { dialDialog.close(); $('#open-drawer').click(); });
$('#clear-image').addEventListener('click', () => { pendingImage = ''; dialForm.imageUrl.value = ''; refreshPreview(); });

dialDialog.addEventListener('close', () => {
  if (dialDialog.returnValue !== 'save') return;
  const url = normalizeUrl(dialForm.url.value);
  if (!url) return;
  const fields = { url, title: dialForm.title.value.trim(), image: pendingImage };
  const groupId = dialForm.group.value;
  let dial = editingId && findDial(editingId);
  if (dial) {
    // What a synced list still names for the dial (sync.js) goes with what it was for: a thumbnail the user has just
    // changed or cleared, the icon of the site it no longer opens.
    if (fields.image !== (dial.image || '')) delete dial.pic;
    if (url !== dial.url) ['icon', 'ico'].forEach((key) => delete dial[key]);
    Object.assign(dial, fields);
  }
  else dial = addDial(state, groupId, fields); // a new dial, or one removed elsewhere while this dialog was open
  // Where it goes: into the chosen folder, into a new one (where the dial was, if it was in that group), or loose
  // into the group. A dial that is there already stays where it is.
  const folder = findFolder(dialForm.folder.value);
  if (dialForm.folder.value === NEW_FOLDER) {
    const group = targetGroup(state, groupId);
    const list = groupOf(dial.id) === group ? listOf(dial.id) : group.dials;
    const i = list.findIndex((d) => d.id === dial.id);
    take(dial.id);
    list.splice(i < 0 ? list.length : i, 0, { id: uid(), name: t('folder'), dials: [dial] });
  } else if (!folder) moveDial(dial.id, groupId);
  else if (folderOf(dial.id) !== folder) folder.dials.push(take(dial.id));
  saveAndRender();
});

$('#delete-dial').addEventListener('click', () => {
  const dial = findDial(editingId);
  const record = dial && remove(state, [dial.id]);
  dialDialog.close('deleted');
  saveAndRender();
  if (dial) offerUndo(t('deletedNamed', tidyTitle(dial.title) || hostOf(dial.url)), record);
});

// ---------- group dialog ----------
const groupDialog = $('#group-dialog');
const groupForm = $('#group-form');
let editingGroupId = null; // by id, for the same reason as editingId
let movingIds = null; // a new group for the ticked dials and folders (Selection), which go into it when it is made

function openGroupDialog(group, moving = null) {
  editingGroupId = group?.id ?? null;
  movingIds = moving;
  $('#group-heading').textContent = t(group ? 'renameGroup' : 'newGroup');
  $('#delete-group').hidden = !group || !deletable(group);
  groupForm.name.value = group?.name || '';
  // A new group can be a team group of a team the user is an admin of: by default the one being viewed.
  $('#group-team').hidden = Boolean(group) || !adminTeams().length;
  groupForm.team.replaceChildren(new Option(t('onlyMe'), ''), ...adminTeams().map(([id, team]) => new Option(team.name, id)));
  groupForm.team.value = !group && !locked(activeGroup()) && activeGroup().team || '';
  groupDialog.returnValue = '';
  groupDialog.showModal();
}
$('#add-group').addEventListener('click', () => openGroupDialog(null));
groupDialog.addEventListener('close', () => {
  const moving = movingIds;
  movingIds = null;
  if (groupDialog.returnValue !== 'save') return;
  const name = groupForm.name.value.trim();
  if (!name) return;
  if (editingGroupId) {
    const group = state.groups.find((g) => g.id === editingGroupId);
    if (group) group.name = name; // else it was deleted elsewhere meanwhile
  } else {
    const group = { id: uid(), name, dials: [], ...(groupForm.team.value && { team: groupForm.team.value }) };
    state.groups.push(group);
    if (moving) return moveTicked(moving, group.id, true); // the group being viewed stays on screen
    state.activeGroup = group.id;
  }
  saveAndRender();
});
// Always asks first, and keeps the user's last own group. A team group goes for everyone in the team. False when the
// user says no.
const deletable = (group) => !locked(group) && (Boolean(group.team) || ownGroups(state.groups).length > 1);
function deleteGroup(id) {
  const group = state.groups.find((g) => g.id === id);
  if (!group || !deletable(group)) return true;
  const n = dialsOf(group).length;
  const question = group.team ? t('confirmDeleteTeamGroup', group.name, teamName(group))
    : n ? t('confirmDeleteGroup', group.name, plural(n, 'nDials')) : t('confirmDeleteEmptyGroup', group.name);
  if (!confirm(question)) return false;
  state.groups = state.groups.filter((g) => g !== group);
  saveAndRender();
  return true;
}
$('#delete-group').addEventListener('click', () => { if (deleteGroup(editingGroupId)) groupDialog.close('deleted'); });

// Right-click on a group tab (or the keyboard's menu key): rename, delete or move it, or start a team group from it in
// a team the user is an admin of. A team group the user can't change can still be moved among their groups.
const groupMenu = $('#group-menu');
let menuGroupId = null;
function openGroupMenu(e, group) {
  e.preventDefault();
  menuGroupId = group.id;
  const i = state.groups.indexOf(group);
  $('#menu-rename').hidden = locked(group);
  $('#menu-delete').hidden = !deletable(group);
  $('#menu-left').hidden = i === 0;
  $('#menu-right').hidden = i === state.groups.length - 1;
  $('#menu-teams').replaceChildren(...(group.team ? [] : adminTeams()).map(([id, team]) => {
    const b = Object.assign(document.createElement('button'), { type: 'button', textContent: t('copyToTeam', team.name) });
    b.addEventListener('click', () => { groupMenu.hidePopover(); copyToTeam(group, id); });
    return b;
  }));
  const r = e.currentTarget.getBoundingClientRect();
  groupMenu.style.left = `${e.clientX || r.left}px`;
  groupMenu.style.top = `${e.clientY || r.bottom}px`;
  groupMenu.showPopover();
  groupMenu.querySelector('button:not([hidden])')?.focus();
}
function moveGroup(id, by) {
  const i = state.groups.findIndex((g) => g.id === id);
  if (i < 0 || !state.groups[i + by]) return;
  state.groups.splice(i + by, 0, ...state.groups.splice(i, 1));
  saveAndRender();
}
$('#menu-left').addEventListener('click', () => { groupMenu.hidePopover(); moveGroup(menuGroupId, -1); });
$('#menu-right').addEventListener('click', () => { groupMenu.hidePopover(); moveGroup(menuGroupId, 1); });
// A new team group with a copy of the group's dials, published to the team when saved.
function copyToTeam(group, team) {
  const again = (d) => ({ ...d, id: uid(), ...(d.dials && { dials: d.dials.map(again) }) });
  const copy = { ...again(group), team };
  state.groups.push(copy);
  state.activeGroup = copy.id;
  saveAndRender();
}
$('#menu-rename').addEventListener('click', () => {
  groupMenu.hidePopover();
  const group = state.groups.find((g) => g.id === menuGroupId);
  if (group) openGroupDialog(group);
});
$('#menu-delete').addEventListener('click', () => { groupMenu.hidePopover(); deleteGroup(menuGroupId); });
// Dismissed by hand: as an "auto" popover, the mouseup ending a right-click on a Mac would close it at once
addEventListener('pointerdown', (e) => { if (!groupMenu.contains(e.target)) groupMenu.hidePopover(); });
addEventListener('keydown', (e) => { if (e.key === 'Escape') groupMenu.hidePopover(); });

// ---------- bookmarks and history ----------
// A drawer down the left side with the browser's bookmarks and the pages visited this week, to open, or to add as dials
// to the group on screen with their + or by dragging them onto the dials (the drawer closes as a page leaves it), and
// a search box over both. Each list is read only once its optional permission is allowed, which is asked here the first
// time and kept until "Stop reading". The history is the one Jump reads (Settings), so allowing it here turns that on
// too, and stopping it here stops Jump's as well.
const drawer = $('#drawer');
const LISTS = {
  bookmarks: { permissions: ['bookmarks'], allow: 'bookmarksAllow', off: 'bookmarksOff' },
  history: { permissions: ['history'], allow: 'historyAllow', off: 'historyOff' },
};
const drawerTab = () => drawer.querySelector('[name=drawer-tab]:checked').value;

$('#open-drawer').addEventListener('click', () => { drawer.showModal(); showDrawer(); });
$('#drawer-tabs').addEventListener('change', showDrawer);
$('#drawer-search').addEventListener('input', showDrawer);
drawer.addEventListener('dragover', (e) => { if (dragNew && e.clientX > drawer.getBoundingClientRect().right) drawer.close(); });

async function showDrawer() {
  const tab = drawerTab();
  const query = $('#drawer-search').value.trim();
  const list = LISTS[tab];
  const allowed = await chrome.permissions.contains({ permissions: list.permissions });
  $('#drawer-allow').hidden = allowed;
  $('#drawer-search').hidden = !allowed;
  $('#drawer-allow-text').textContent = t(list.allow);
  $('#drawer-off').hidden = !allowed;
  $('#drawer-off').textContent = t(list.off);
  const items = !allowed ? [] : tab === 'bookmarks' ? await bookmarkList(query) : await historyItems(query);
  if (tab !== drawerTab() || query !== $('#drawer-search').value.trim()) return; // changed meanwhile
  $('#drawer-list').replaceChildren(...items, ...(allowed && !items.length ? [Object.assign(document.createElement('li'), { className: 'none', textContent: t('drawerEmpty') })] : []));
}

$('#drawer-allow-button').addEventListener('click', async () => {
  if (await chrome.permissions.request({ permissions: LISTS[drawerTab()].permissions })) showDrawer(); // first: it needs this click
});
$('#drawer-off').addEventListener('click', async () => {
  const tab = drawerTab();
  await chrome.permissions.remove({ permissions: LISTS[tab].permissions });
  if (tab === 'history') await chrome.storage.local.set({ historyDeclined: true }); // as Jump's checkbox does
  showDrawer();
});

// The tree, or with words searched the bookmarks that have them (the browser's own search: titles and addresses).
// Separators and Firefox's smart folders (place:) are left out, as is anything a dial couldn't open.
const shown = (node) => (node.url ? normalizeUrl(node.url) && !node.url.startsWith('place:') : node.type !== 'separator');
async function bookmarkList(query) {
  if (query) return (await chrome.bookmarks.search(query)).filter((node) => node.url && shown(node)).map((node) => pageItem(node.url, node.title));
  return bookmarkItems((await chrome.bookmarks.getTree())[0].children, true);
}

// A folder's contents are drawn when it is first opened; the bookmarks bar (Chrome, Edge) or toolbar (Firefox) is open
// from the start.
function bookmarkItems(nodes, top = false) {
  return nodes.filter(shown).map((node) => {
    if (node.url) return pageItem(node.url, node.title);
    const li = document.createElement('li');
    const folder = document.createElement('details');
    const summary = document.createElement('summary');
    summary.append(icon('i-folder'), node.title);
    const inside = document.createElement('ul');
    const fill = () => { if (folder.open && !inside.childElementCount) inside.append(...bookmarkItems(node.children || [])); };
    folder.addEventListener('toggle', fill);
    folder.open = top && (node.folderType === 'bookmarks-bar' || node.id === '1' || node.id === 'toolbar_____');
    fill();
    folder.append(summary, inside);
    li.append(folder);
    return li;
  });
}

// The last week's pages, or with words searched the pages of any time that have them, newest first, under the day they
// were visited on; new tabs (this page) left out.
async function historyItems(query) {
  const pages = await chrome.history.search({ text: query, startTime: query ? 0 : Date.now() - 7 * 864e5, maxResults: 300 });
  const items = [];
  let day = '';
  for (const page of pages.filter((p) => normalizeUrl(p.url) && !p.url.startsWith(location.origin)).sort((a, b) => b.lastVisitTime - a.lastVisitTime)) {
    const date = dateFormat.format(page.lastVisitTime);
    if (date !== day) items.push(Object.assign(document.createElement('li'), { className: 'day', textContent: day = date }));
    items.push(pageItem(page.url, page.title));
  }
  return items;
}

// A page in the drawer: its link, and a button that adds it to the group on screen (or to the user's first own group,
// on a team group they can't change), or says it is there already.
function pageItem(url, title) {
  const li = document.createElement('li');
  li.className = 'page';
  const a = document.createElement('a');
  a.href = url;
  a.title = url;
  if (browserIcons) { // Firefox would ask each site for its icon: there the titles stand alone
    const fav = Object.assign(new Image(), { alt: '', loading: 'lazy', src: faviconUrl(url, 32) });
    a.append(fav);
  }
  const label = document.createElement('span');
  label.textContent = title || hostOf(url);
  a.append(label);
  const group = targetGroup(state, activeGroup().id);
  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'icon-btn';
  const mark = (done) => {
    add.replaceChildren(icon(done ? 'i-check' : 'i-plus'));
    add.disabled = done;
    add.title = t(done ? 'alreadyIn' : 'addTo', group.name);
    add.setAttribute('aria-label', `${add.title}: ${label.textContent}`);
  };
  mark(dialsOf(group).some((d) => sameUrl(d.url, url)));
  add.addEventListener('click', () => {
    addDial(state, group.id, { url, title: shortTitle(title) });
    mark(true);
    saveAndRender();
  });
  li.addEventListener('dragstart', () => { dragId = (dragNew = { id: uid(), url: normalizeUrl(url), title: shortTitle(title), image: '' }).id; });
  li.addEventListener('dragend', endDrag);
  li.append(a, add);
  return li;
}

// ---------- notes ----------
// The user's notes (notes.js), in a drawer down the right side: the list, newest first, then the note picked, written
// in place under a toolbar. A note is stored half a second after the last change and when the drawer closes; one left
// empty goes when another is picked or the drawer closes. What is pasted is cleaned first (clean), and pictures are made
// small enough to sync (MAX_DATA). A link opens with Ctrl or ⌘ held, a checklist item ticks by its box.
// ponytail: a change made in the last half second before the tab closes may not be kept.
const notesDialog = $('#notes');
const editor = $('#note-editor');
editor.dataset.placeholder = t('notePlaceholder');
document.execCommand('defaultParagraphSeparator', false, 'p');
let noteId = null; // the note in the editor
let shownRev = null; // and which version of it
let noteTimer = null;
const currentNote = () => readyNotes(state.notes).find((n) => n.id === noteId); // a note waiting for its body isn't shown (notes.js)
const textOf = (html) => new DOMParser().parseFromString(clean(html).replace(/<\/(p|h\d|li|blockquote|pre|td|th)>|<br>/g, '\n'), 'text/html').body.textContent;
const noteBlank = (html) => !textOf(html).trim() && !/<(img|table|hr)\b/.test(html);
const markEmpty = () => editor.toggleAttribute('data-empty', noteBlank(editor.innerHTML));

// What the user should know about their notes not syncing: the room is full, or sync failed.
async function warnNotes() {
  const { syncError, syncFull } = await chrome.storage.local.get(['syncError', 'syncFull']);
  const text = state.settings.sync === false ? '' : syncError || ((await syncCode()) && syncFull && t('picturesFull')) || '';
  $('#notes-warning').textContent = text;
  $('#notes-warning').hidden = !text;
}

function showNotes() {
  warnNotes();
  if (!currentNote()) pickNote(newestFirst(readyNotes(state.notes))[0]?.id, false);
  $('#note-list').replaceChildren(...newestFirst(readyNotes(state.notes)).map((note) => {
    const [title, second = ''] = textOf(note.html).split('\n').map((line) => line.trim()).filter(Boolean);
    const li = document.createElement('li');
    if (note.id === noteId) li.setAttribute('aria-current', 'true');
    li.append(Object.assign(document.createElement('span'), { className: 'title', textContent: title || t('newNote') }),
      Object.assign(document.createElement('span'), { className: 'more', textContent: [when(note.at), second].filter(Boolean).join(' · ') }));
    li.addEventListener('click', () => { pickNote(note.id); editor.focus(); });
    return li;
  }));
  const note = currentNote();
  if (note && note.rev !== shownRev && document.activeElement !== editor) { // changed elsewhere meanwhile
    editor.innerHTML = clean(note.html) || '<p><br></p>'; // a first line in a paragraph, as the rest
    shownRev = note.rev;
    markEmpty();
  }
}

// Put a note in the editor (none: a new one), storing the one that was there; an empty one other than it goes.
function pickNote(id, draw = true) {
  keepNote();
  if (!id) state.notes.push(newNote());
  const note = readyNotes(state.notes).find((n) => n.id === id) || state.notes.at(-1);
  dropEmpty(note.id);
  noteId = note.id;
  shownRev = note.rev;
  editor.innerHTML = clean(note.html) || '<p><br></p>'; // a first line in a paragraph, as the rest
  markEmpty();
  if (draw) showNotes();
}

function dropEmpty(keep) {
  const kept = state.notes.filter((n) => n.id === keep || typeof n.html !== 'string' || !noteBlank(n.html));
  if (kept.length === state.notes.length) return;
  state.notes = kept;
  saveAndRender();
}

// Store what the editor has, if it changed.
function keepNote() {
  if (!noteTimer) return;
  clearTimeout(noteTimer);
  noteTimer = null;
  const note = currentNote();
  const html = clean(editor.innerHTML);
  if (!note || html === note.html) return;
  edit(note, html);
  shownRev = note.rev;
  saveAndRender().then(() => { $('#note-status').textContent = t('noteSaved'); });
}
const changed = () => {
  markEmpty();
  $('#note-status').textContent = '';
  clearTimeout(noteTimer);
  noteTimer = setTimeout(keepNote, 500);
};

$('#open-notes').addEventListener('click', () => {
  notesDialog.showModal();
  pickNote(currentNote()?.id || newestFirst(readyNotes(state.notes))[0]?.id);
  editor.focus();
});
$('#note-new').addEventListener('click', () => { pickNote(null); editor.focus(); });
$('#note-delete').addEventListener('click', () => {
  const note = currentNote();
  if (!note || (!noteBlank(note.html) && !confirm(t('confirmDeleteNote')))) return;
  clearTimeout(noteTimer);
  noteTimer = null;
  state.notes = state.notes.filter((n) => n !== note);
  saveAndRender();
  pickNote(newestFirst(readyNotes(state.notes))[0]?.id);
});
notesDialog.addEventListener('close', () => { keepNote(); dropEmpty(); });
addEventListener('pagehide', keepNote);

// The selection in the editor, kept for the toolbar's color and picture pickers, which take the focus.
let noteRange = null;
document.addEventListener('selectionchange', () => {
  const sel = getSelection();
  if (!sel.rangeCount || !editor.contains(sel.anchorNode)) return;
  noteRange = sel.getRangeAt(0).cloneRange();
  $('#table-tools').hidden = !at()?.closest('td, th');
  for (const b of $('#note-tools').querySelectorAll('[data-cmd]')) b.setAttribute('aria-pressed', String(document.queryCommandState(b.dataset.cmd)));
});
const at = () => { const node = getSelection().anchorNode; return node?.nodeType === Node.TEXT_NODE ? node.parentElement : node; };
function format(command, value) {
  editor.focus();
  if (noteRange && !editor.contains(getSelection().anchorNode)) {
    getSelection().removeAllRanges();
    getSelection().addRange(noteRange);
  }
  document.execCommand('styleWithCSS', false, command === 'foreColor' || command === 'hiliteColor'); // a color is a style; bold is <b>
  document.execCommand(command, false, value);
  changed();
}

$('#note-tools').addEventListener('mousedown', (e) => { if (e.target.closest('button')) e.preventDefault(); }); // the editor keeps its selection
$('#note-tools').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (b?.dataset.cmd) format(b.dataset.cmd);
  else if (b?.dataset.block) format('formatBlock', document.queryCommandValue('formatBlock').toLowerCase() === b.dataset.block ? 'p' : b.dataset.block);
  else if (b?.dataset.table) tableEdit(b.dataset.table);
});
$('#note-color').addEventListener('change', (e) => format('foreColor', e.target.value));
$('#note-highlight').addEventListener('change', (e) => format('hiliteColor', e.target.value));
$('#note-checklist').addEventListener('click', checklist);
function checklist() {
  const list = at()?.closest('ul, ol');
  if (list?.matches('ul[data-checklist]')) return format('insertUnorderedList'); // off
  if (list?.tagName !== 'UL') format('insertUnorderedList');
  at()?.closest('ul')?.setAttribute('data-checklist', '');
  changed();
}
$('#note-link').addEventListener('click', () => {
  const range = noteRange;
  let url = prompt(t('linkAddress'), 'https://')?.trim();
  if (!url || url === 'https://') return;
  if (!/^(https?:|mailto:)/i.test(url)) url = `https://${url}`;
  noteRange = range;
  if (range && !range.collapsed) format('createLink', url);
  else format('insertHTML', clean(`<a href="${url.replace(/"/g, '%22')}">${url.replace(/</g, '&lt;')}</a>&nbsp;`));
});
$('#note-table').addEventListener('click', () => {
  const row = `<tr>${'<td><br></td>'.repeat(3)}</tr>`;
  format('insertHTML', `<table><tbody>${row.repeat(3)}</tbody></table><p><br></p>`);
});
function tableEdit(what) {
  const cell = at()?.closest('td, th');
  if (!cell) return;
  const table = cell.closest('table');
  const i = cell.cellIndex;
  const emptyCell = (tag = 'td') => Object.assign(document.createElement(tag), { innerHTML: '<br>' });
  if (what === 'row') {
    const tr = document.createElement('tr');
    tr.append(...Array.from(cell.parentElement.cells, () => emptyCell()));
    cell.parentElement.after(tr);
  } else if (what === 'column') for (const tr of table.rows) (tr.cells[i] ? tr.cells[i].after(emptyCell(tr.cells[i].tagName)) : tr.append(emptyCell()));
  else if (what === '-row') (table.rows.length > 1 ? cell.parentElement.remove() : table.remove());
  else if (cell.parentElement.cells.length > 1) for (const tr of table.rows) tr.cells[i]?.remove();
  else table.remove();
  changed();
}

$('#note-image').addEventListener('change', (e) => { insertPictures([...e.target.files]); e.target.value = ''; });
editor.addEventListener('paste', (e) => {
  const files = [...e.clipboardData.files];
  const html = e.clipboardData.getData('text/html');
  if (!files.length && !html) return; // plain text: as the browser pastes it
  e.preventDefault();
  if (files.length) insertPictures(files);
  else format('insertHTML', clean(html));
});
editor.addEventListener('drop', (e) => {
  const files = [...e.dataTransfer.files];
  if (!files.length) return;
  e.preventDefault();
  insertPictures(files);
});
// Small enough for sync to carry (sync.js MAX_DATA): a photo is made smaller until it is.
async function insertPictures(files) {
  for (const file of files.filter((f) => /^image\/(png|jpeg|gif|webp)$/.test(f.type))) {
    let data = await readAsDataUrl(file, 1200, 140_000);
    for (const side of [900, 600, 400]) if (data.length > MAX_DATA) data = await readAsDataUrl(file, side);
    format('insertHTML', `<img src="${data}">`);
  }
}

editor.addEventListener('input', (e) => {
  if (e.inputType === 'insertText' && e.data === ' ') shortcut();
  if (e.inputType === 'insertParagraph') at()?.closest('li')?.removeAttribute('data-done'); // a new item isn't done yet
  changed();
});
// Markdown at the start of a line: "- " or "* " a list, "1. " a numbered one, "[] " a checklist, "# " and "## "
// headings, "> " a quote.
const SHORTCUTS = { '-': 'insertUnorderedList', '*': 'insertUnorderedList', '1.': 'insertOrderedList', '[]': checklist, '#': 'h1', '##': 'h2', '>': 'blockquote' };
function shortcut() {
  const node = getSelection().anchorNode;
  const offset = getSelection().anchorOffset;
  if (node?.nodeType !== Node.TEXT_NODE || node.previousSibling) return;
  const mark = node.textContent.slice(0, offset).replace(/[\s ]$/, '');
  const does = Object.hasOwn(SHORTCUTS, mark) && SHORTCUTS[mark];
  if (!does || (typeof does === 'string' && does.startsWith('insert') && at().closest('li'))) return;
  getSelection().setBaseAndExtent(node, 0, node, offset);
  document.execCommand('delete'); // the mark, as typed
  if (typeof does === 'function') does();
  else if (does.startsWith('insert')) format(does);
  else format('formatBlock', does);
}
// Bold, italic, underline from the keyboard: Chrome does these itself, Firefox doesn't (on a Mac its ⌘B opens the bookmarks sidebar)
const KEYS = { b: 'bold', i: 'italic', u: 'underline' };
editor.addEventListener('keydown', (e) => {
  const command = (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && KEYS[e.key.toLowerCase()];
  if (!command) return;
  e.preventDefault();
  format(command);
});
editor.addEventListener('click', (e) => {
  const item = e.target.closest('ul[data-checklist] > li');
  if (item && e.target === item && e.clientX - item.getBoundingClientRect().left < 24) {
    item.toggleAttribute('data-done');
    if (item.hasAttribute('data-done')) item.setAttribute('data-done', 'true');
    changed();
  }
  const link = e.target.closest('a[href]');
  if (link && (e.metaKey || e.ctrlKey)) open(link.href, '_blank', 'noopener');
});

// ---------- to-dos ----------
// The to-dos (todos.js), in a card on the page that the header's button shows and hides. The user drags it by its bar
// anywhere: its place, x and y from 0 to 1 (`todoAt`), is across the room the window leaves around the card, so the
// card stays whole in any window and keeps to an edge it was put against. Whether it shows and where follow the user
// with the look (sync.js). A to-do is written in the field at the top (Enter adds it, first in the list), ticked by
// its box, changed in place (Enter or leaving it keeps the change; emptied, it goes) and dragged by its grip to another
// place in the list. One with a due date (its calendar button, or the one in the field for the next one) goes in a part
// of the list by when: gone by, today, tomorrow, later, soonest first; those with none follow in the user's order, and
// only they are dragged. Those done fold away under the list, the one done last first.
// ponytail: a to-do being changed when the tab closes keeps its old text.
const todoCard = $('#todo');
const todoById = (id) => state.todos.find((x) => x.id === id);
const placeTodo = (x, y) => { todoCard.style.setProperty('--x', x); todoCard.style.setProperty('--y', y); };
const editingTodo = () => document.activeElement?.matches('.todo-list .text');
let draggedTodo = null;
// What the list on screen shows; it is drawn again only when that changes, so a click on it isn't lost to a redraw.
const todosNow = () => `${dayOf(new Date())} ${state.todos.map((x) => x.rev + sectionOf(x.due)).join()}`;
let todosDrawn = '';

function drawTodos() {
  const on = state.settings.todoOn === true;
  todoCard.hidden = !on;
  $('#open-todo').setAttribute('aria-pressed', String(on));
  if (!on) return;
  if (!todoCard.classList.contains('moving')) placeTodo(...(state.settings.todoAt || [1, 0.15])); // at first: right, under the header
  clearClock();
  if (editingTodo() || todosNow() === todosDrawn) return; // while one is changed: drawn again once the change is kept
  todosDrawn = todosNow();
  const done = finished(state.todos);
  const list = pending(state.todos);
  const parts = SECTIONS.map((part) => [part, list.filter((x) => sectionOf(x.due) === part).sort(byDue)]).filter(([, xs]) => xs.length);
  $('#todo-dated').replaceChildren(...parts.map(([part, xs]) => {
    const box = Object.assign(document.createElement('section'), { className: 'todo-part' });
    box.dataset.part = part;
    const ul = Object.assign(document.createElement('ul'), { className: 'todo-list' });
    ul.append(...xs.map((x) => todoItem(x, part)));
    box.append(Object.assign(document.createElement('h3'), { className: 'todo-head', textContent: partName(part) }), ul);
    return box;
  }));
  const undated = list.filter((x) => !x.due);
  $('#todo-undated').hidden = !parts.length || !undated.length;
  $('#todo-list').replaceChildren(...undated.map((x) => todoItem(x)));
  $('#todo-done').hidden = !done.length;
  $('#todo-done summary').textContent = t('doneTodos', done.length);
  $('#todo-done-list').replaceChildren(...done.map(todoItem));
}

// In a narrow window the card can come over the clock and date: then it steps aside, if the window has the room.
function clearClock() {
  todoCard.style.removeProperty('--dx');
  if (todoCard.hidden || todoCard.classList.contains('moving')) return;
  const words = ['#clock', '#date'].map((id) => { const r = document.createRange(); r.selectNodeContents($(id)); return r.getBoundingClientRect(); });
  const text = { left: Math.min(...words.map((r) => r.left)), right: Math.max(...words.map((r) => r.right)), top: words[0].top, bottom: words[1].bottom };
  const card = todoCard.getBoundingClientRect();
  if (card.bottom <= text.top || card.top >= text.bottom || card.right <= text.left || card.left >= text.right) return;
  const right = card.left + card.width / 2 > innerWidth / 2;
  const dx = right ? text.right + 12 - card.left : text.left - 12 - card.right;
  if (right ? card.right + dx <= innerWidth - 8 : card.left + dx >= 8) todoCard.style.setProperty('--dx', `${dx}px`);
}

// A due date as the list shows it: today, tomorrow or yesterday by name, else the day; then the time, if there is one.
// In the part for today or tomorrow, the day goes without saying.
const relativeDay = new Intl.RelativeTimeFormat(uiLanguage(), { numeric: 'auto' });
const dayName = (days) => relativeDay.format(days, 'day').replace(/^./, (c) => c.toUpperCase());
const partName = (part) => ({ over: t('todoOverdue'), today: dayName(0), tomorrow: dayName(1), later: t('todoLater') })[part];
function dueLabel(due, part) {
  const now = new Date();
  const at = new Date(due.includes('T') ? due : `${due}T00:00`);
  const days = (Date.UTC(at.getFullYear(), at.getMonth(), at.getDate()) - Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())) / 864e5;
  const day = ['today', 'tomorrow'].includes(part) ? '' : Math.abs(days) <= 1 ? dayName(days)
    : at.toLocaleDateString(uiLanguage(), { month: 'short', day: 'numeric', ...(at.getFullYear() !== now.getFullYear() && { year: 'numeric' }) });
  const time = due.includes('T') ? at.toLocaleTimeString(uiLanguage(), { hour: 'numeric', minute: '2-digit' }) : '';
  return [day, time].filter(Boolean).join(' ');
}
function showDue(button, due, part) {
  const label = due ? dueLabel(due, part) : '';
  button.querySelector('span').textContent = label;
  button.setAttribute('aria-label', due ? `${t('dueDate')}: ${dueLabel(due)}` : t('dueDate'));
  button.title = button.getAttribute('aria-label');
}

function todoItem({ id, text: words, done, due: when }, part) {
  const li = document.createElement('li');
  li.dataset.id = id;
  const box = Object.assign(document.createElement('input'), { type: 'checkbox', checked: done });
  box.setAttribute('aria-label', words);
  box.addEventListener('change', () => {
    const todo = todoById(id);
    if (todo) change(todo, { done: box.checked }); // ticked off again, it goes back where it was
    saveAndRender();
  });
  const text = Object.assign(document.createElement('span'), { className: 'text', textContent: words, spellcheck: false });
  text.contentEditable = 'plaintext-only';
  text.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); text.blur(); }
    if (e.key === 'Escape') { text.textContent = todoById(id)?.text ?? words; text.blur(); }
  });
  text.addEventListener('blur', () => {
    const todo = todoById(id);
    const now = text.textContent.replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
    if (!todo || now === todo.text) return;
    if (now) {
      change(todo, { text: now });
      box.setAttribute('aria-label', now);
      if (todosDrawn) todosDrawn = todosNow(); // the list shows it already
    } else state.todos = state.todos.filter((x) => x !== todo);
    saveAndRender();
  });
  const remove = Object.assign(document.createElement('button'), { type: 'button', className: 'icon-btn', title: t('deleteTodo') });
  remove.setAttribute('aria-label', t('deleteTodo'));
  remove.append(icon('i-close'));
  remove.addEventListener('click', () => {
    state.todos = state.todos.filter((x) => x.id !== id);
    saveAndRender();
  });
  if (done) li.append(box, text, remove);
  else if (when) {
    const due = Object.assign(document.createElement('button'), { type: 'button', className: 'icon-btn due' });
    due.append(icon('i-calendar'), document.createElement('span'));
    due.addEventListener('click', () => openDue(due, id));
    showDue(due, when, part);
    li.append(box, text, due, remove);
  } else {
    const grip = icon('i-grip');
    grip.classList.add('grip');
    grip.addEventListener('pointerdown', () => { li.draggable = true; }); // by its grip only: the text is for writing in
    li.addEventListener('dragstart', (e) => {
      draggedTodo = id;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', words);
      li.classList.add('dragging');
    });
    li.addEventListener('dragend', () => {
      li.draggable = false;
      draggedTodo = null;
      li.classList.remove('dragging');
      for (const x of $('#todo-list').querySelectorAll('[data-drop]')) delete x.dataset.drop;
    });
    const due = Object.assign(document.createElement('button'), { type: 'button', className: 'icon-btn due' });
    due.append(icon('i-calendar'), document.createElement('span'));
    due.addEventListener('click', () => openDue(due, id));
    showDue(due, '');
    li.append(grip, box, text, due, remove);
  }
  return li;
}

// Where a dragged to-do would go: before the item under the pointer, or after it past its middle.
function dropSpot(e) {
  const over = e.target.closest?.('#todo-list > li');
  if (!over) return { over: null, next: null };
  const after = e.clientY > over.getBoundingClientRect().top + over.offsetHeight / 2;
  return { over, after, next: after ? over.nextElementSibling : over };
}
$('#todo-list').addEventListener('dragover', (e) => {
  if (!draggedTodo) return;
  e.preventDefault();
  const { over, after } = dropSpot(e);
  for (const x of $('#todo-list').querySelectorAll('[data-drop]')) if (x !== over) delete x.dataset.drop;
  if (over) over.dataset.drop = after ? 'after' : 'before';
});
$('#todo-list').addEventListener('drop', (e) => {
  const moving = draggedTodo && todoById(draggedTodo);
  if (!moving) return;
  e.preventDefault();
  const { over, next } = dropSpot(e);
  const before = next && todoById(next.dataset.id);
  if (!over || before === moving) return;
  change(moving, { pos: posBefore(state.todos.filter((x) => x !== moving), before) });
  saveAndRender();
});

// A to-do's due date, in a menu by its calendar button: today, tomorrow, next Monday, a day picked, a time. The one in
// the field sets it for the to-do written next. With a time, the background worker reminds the user then
// (background.js) in a notification: that permission is asked for by "Add time", and kept.
const dueMenu = $('#due-menu');
let dueFor = null; // the to-do's id, or null for the one written next
let nextDue = '';
const dueNow = () => (dueFor ? todoById(dueFor)?.due || '' : nextDue);
function setDue(due) {
  if (!dueFor) {
    nextDue = due;
    showDue($('#todo-new-due'), due);
    return;
  }
  const todo = todoById(dueFor);
  if (!todo || due === (todo.due || '')) return;
  change(todo, { due });
  saveAndRender();
}
function openDue(button, id = null) {
  dueFor = id;
  const [day, time = ''] = dueNow().split('T');
  const now = new Date();
  const toMonday = (8 - now.getDay()) % 7 || 7;
  for (const b of dueMenu.querySelectorAll('[data-days]')) {
    const days = b.dataset.days === 'week' ? toMonday : Number(b.dataset.days);
    b.dataset.day = dayOf(now, days);
    if (b.dataset.days !== 'week') b.querySelector('span').textContent = dayName(days);
    b.querySelector('small').textContent = new Date(`${b.dataset.day}T00:00`).toLocaleDateString(uiLanguage(), days < 2 ? { weekday: 'short' } : { month: 'short', day: 'numeric' });
  }
  $('#due-day').value = day;
  $('#due-time').value = time;
  $('#due-time-row').hidden = $('#due-hint').hidden = !time;
  $('#due-add-time').hidden = Boolean(time);
  $('#due-remove').hidden = !day;
  dueMenu.showPopover();
  // under the button, its right edge with the button's, kept inside the window
  const r = button.getBoundingClientRect();
  const [w, h] = [dueMenu.offsetWidth, dueMenu.offsetHeight];
  dueMenu.style.left = `${Math.max(8, Math.min(r.right - w, innerWidth - w - 8))}px`;
  dueMenu.style.top = `${r.bottom + 4 + h > innerHeight - 8 ? Math.max(8, r.top - 4 - h) : r.bottom + 4}px`;
  dueMenu.querySelector('button').focus();
}
const withTime = (day) => [day, dueNow().split('T')[1]].filter(Boolean).join('T');
for (const b of dueMenu.querySelectorAll('[data-days]')) {
  b.addEventListener('click', () => { setDue(withTime(b.dataset.day)); dueMenu.hidePopover(); });
}
// Typing a day fires change at each part of it: the menu stays until the user leaves it.
$('#due-day').addEventListener('change', (e) => { if (e.target.value) setDue(withTime(e.target.value)); });
$('#due-add-time').addEventListener('click', () => {
  chrome.permissions.request({ permissions: ['notifications'] }).catch(() => {}); // first: within the click
  $('#due-add-time').hidden = true;
  $('#due-time-row').hidden = $('#due-hint').hidden = false;
  $('#due-time').focus();
});
$('#due-time').addEventListener('change', (e) => {
  const day = dueNow().split('T')[0] || dayOf(new Date());
  setDue(e.target.value ? `${day}T${e.target.value}` : day);
  $('#due-day').value = day;
  $('#due-remove').hidden = false;
});
$('#due-remove').addEventListener('click', () => { setDue(''); dueMenu.hidePopover(); });
$('#todo-new-due').addEventListener('click', (e) => openDue(e.currentTarget));
showDue($('#todo-new-due'), '');

$('#open-todo').addEventListener('click', () => {
  state.settings.todoOn = state.settings.todoOn !== true;
  saveAndRender();
  if (state.settings.todoOn) $('#todo-new').focus();
});
$('#todo-close').addEventListener('click', () => {
  state.settings.todoOn = false;
  saveAndRender();
});
$('#todo-add').addEventListener('submit', (e) => {
  e.preventDefault();
  const words = $('#todo-new').value.replace(/\s+/g, ' ').trim();
  if (!words) return;
  state.todos.push({ ...newTodo(words, posBefore(state.todos, pending(state.todos)[0])), due: nextDue });
  $('#todo-new').value = '';
  showDue($('#todo-new-due'), nextDue = '');
  saveAndRender();
});
$('#todo-clear').addEventListener('click', () => {
  if (!confirm(t('confirmClearDone'))) return;
  state.todos = state.todos.filter((x) => !x.done);
  saveAndRender();
});

// The card's bar moves it.
$('.todo-bar').addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || e.target.closest('button')) return;
  e.preventDefault();
  const bar = e.currentTarget;
  const { left, top, width, height } = todoCard.getBoundingClientRect();
  const [dx, dy] = [e.clientX - left, e.clientY - top];
  const share = (n, room) => Math.round(Math.min(1, Math.max(0, n / room || 0)) * 1000) / 1000;
  let spot = null;
  const move = (ev) => {
    todoCard.style.removeProperty('--dx'); // stepped aside from the clock (clearClock): where it is held is where it goes
    placeTodo(...(spot = [share(ev.clientX - dx, innerWidth - width), share(ev.clientY - dy, innerHeight - height)]));
  };
  todoCard.classList.add('moving');
  bar.setPointerCapture(e.pointerId);
  bar.addEventListener('pointermove', move);
  bar.addEventListener('lostpointercapture', () => { // let go, or the browser took the pointer
    bar.removeEventListener('pointermove', move);
    todoCard.classList.remove('moving');
    if (!spot) return;
    state.settings.todoAt = spot;
    saveAndRender();
  }, { once: true });
});

// ---------- sort (paid) ----------
// Its button says, before it is clicked, that Sort needs the unlock.
const labelSort = async () => $('#sort-group').setAttribute('aria-label', (await isPaid()) ? t('sortGroup') : `${t('sortGroup')} · ${t('unlockFor')}`);
labelSort();
// Suggests a better group for each dial of the group on screen, and moves the ones the user keeps checked.
const sortDialog = $('#sort-dialog');
let sortingGroup = null;
// Firefox asks before an extension sends browsing activity (manifest: data_collection_permissions.optional); Chrome
// and Edge have no such permission, and there the Continue click is the consent. Kept once granted, so Firefox doesn't
// ask on top of our own explanation every time; the user can take it back in about:addons.
let askFirefox = false;
chrome.permissions.getAll().then((p) => { askFirefox = 'data_collection' in p; });

function sortStep(text, action = '') {
  $('#sort-text').textContent = text;
  $('#sort-go').dataset.action = action;
  $('#sort-go').hidden = !action;
  if (action) $('#sort-go').textContent = t(action);
  $('#sort-cancel').textContent = t(action ? 'cancel' : 'close');
}

$('#sort-group').addEventListener('click', async () => {
  const group = activeGroup();
  sortingGroup = group.id;
  $('#sort-heading').textContent = t('sortHeading', group.name);
  $('#sort-moves').replaceChildren();
  // A free user is first told what Sort does and what it costs; the button then leads to the unlock in Settings.
  if (await isPaid()) sortStep(t('sortAbout', plural(loose(group).length, 'nDials'), group.name), 'sortContinue');
  else sortStep(`${t('sortLocked', group.name)} ${t('unlockTerms')}`, 'unlockFor');
  sortDialog.showModal();
});

$('#sort-go').addEventListener('click', async (e) => {
  const button = e.currentTarget;
  if (button.dataset.action === 'unlockFor') {
    sortDialog.close();
    $('#open-settings').click();
    showTab('unlock');
    return;
  }
  if (button.dataset.action === 'sortApply') {
    let moved = false;
    for (const box of $('#sort-moves').querySelectorAll('input:checked')) moved = moveDial(box.dataset.dial, box.dataset.group) || moved;
    sortDialog.close();
    if (moved) saveAndRender();
    return;
  }
  const allowed = askFirefox ? chrome.permissions.request({ data_collection: ['browsingActivity'] }) : true; // first: within the click
  if (!(await allowed)) return;
  button.disabled = true;
  sortStep(t('sortWaiting'));
  try {
    const moves = await suggestMoves(state, sortingGroup);
    $('#sort-moves').replaceChildren(...moves.map(({ dial, to }) => {
      const box = Object.assign(document.createElement('input'), { type: 'checkbox', checked: true });
      Object.assign(box.dataset, { dial: dial.id, group: to.id });
      const name = document.createElement('span');
      name.textContent = dial.title || hostOf(dial.url);
      const target = document.createElement('b');
      target.textContent = `→ ${to.name}`;
      const label = document.createElement('label');
      label.className = 'check';
      label.append(box, name, target);
      const li = document.createElement('li');
      li.append(label);
      return li;
    }));
    sortStep(t(moves.length ? 'sortReview' : 'sortNothing'), moves.length ? 'sortApply' : '');
  } catch {
    sortStep(t('sortFailed'), 'sortContinue');
  } finally {
    button.disabled = false;
  }
});

// ---------- settings ----------
const settingsDialog = $('#settings-dialog');
// The sliders of the Appearance tab: each is the setting of its name, shown beside it the way given here.
const sliders = { columns: String, size: (v) => `${v}%`, gap: String, radius: String, text: String };
$('#open-settings').addEventListener('click', () => {
  for (const [name, shown] of Object.entries(sliders)) {
    $(`#${name}`).value = look()[name];
    $(`#${name}-out`).textContent = shown(look()[name]);
  }
  $('#titles-on').checked = state.settings.titles !== false;
  $('#theme').value = look().theme;
  $('#font').value = look().font;
  $('#bg-color').value = backgroundKind(state.settings.background) === 'color' ? state.settings.background : '#f1f3f6';
  $('#import-status').textContent = '';
  $('#sync-on').checked = state.settings.sync !== false;
  $('#search-on').checked = state.settings.searchBox !== false;
  $('#backup-status').textContent = '';
  $('#unlock-status').textContent = '';
  showSyncStatus();
  showCode();
  showBackups();
  refreshPaid();
  $('#team-status').textContent = '';
  showTeams();
  chrome.permissions.contains({ permissions: ['history'] }).then((on) => { $('#jump-history').checked = on; });
  showTab('look');
  settingsDialog.showModal();
});

function showTab(name) {
  $(`#settings-tabs [value="${name}"]`).checked = true;
  for (const section of settingsDialog.querySelectorAll('.section')) section.hidden = section.dataset.tab !== name;
}
$('#settings-tabs').addEventListener('change', (e) => showTab(e.target.value));

async function showSyncStatus() {
  const { syncError, syncFull } = await chrome.storage.local.get(['syncError', 'syncFull']);
  const on = state.settings.sync !== false;
  $('#sync-status').textContent = on ? [syncError, (await syncCode()) && syncFull && t('picturesFull')].filter(Boolean).join('\n') : '';
  $('#sync-usage').textContent = '';
  if (!on) return;
  const used = await usage(state).catch(() => null);
  const size = (bytes) => new Intl.NumberFormat(uiLanguage(), { style: 'unit', unit: bytes >= 1e6 ? 'megabyte' : 'kilobyte', maximumFractionDigits: 1 })
    .format(bytes >= 1e6 ? bytes / 1e6 : Math.max(0.1, bytes / 1e3));
  const percent = (part, all) => new Intl.NumberFormat(uiLanguage(), { style: 'percent' }).format(Math.min(1, part / all));
  if (used?.browser !== undefined) $('#sync-usage').textContent = t('syncUsageBrowser', size(used.browser), size(used.most));
  else if (used) $('#sync-usage').textContent = t('syncUsageCode', percent(used.text, used.textMost), size(used.pictures), size(used.picturesMost));
}
$('#sync-on').addEventListener('change', async (e) => {
  state.settings.sync = e.target.checked;
  showCode();
  if (e.target.checked) await rejoin();
  await saveAndRender();
  showSyncStatus();
});
// Keep this computer's dials and add what the other computers or browsers have; the save that follows sends the result.
async function rejoin() {
  await chrome.storage.local.remove('syncSeen');
  await syncNow(state);
  await syncSite(state, true).catch(() => {});
}

// Sync between browsers (sync.js): a sync code made here, or entered from another browser, sends the dial list
// through nexuscortex.dev, encrypted with the code. Shown while sync is on: without a code, how to get or enter one;
// with one, the code, the link that holds it, and the two ways to stop. In Firefox a code that came through Firefox's
// own sync counts as not there until the user enters it here, which is where Firefox asks them (SYNC_DATA).
async function showCode() {
  const code = await syncCode();
  const on = Boolean(code) && await siteAllowed();
  $('#code-off').hidden = state.settings.sync === false || on;
  $('#code-on').hidden = state.settings.sync === false || !on;
  $('#code-shown').value = on ? code : '';
  if (code && !on) $('#code-input').value = code;
}
async function codeRun(button, work, firefoxAsks = false) {
  const allowed = firefoxAsks && askFirefox ? chrome.permissions.request(SYNC_DATA) : true; // first: within the click
  button.disabled = true;
  $('#sync-status').textContent = '';
  try {
    if (await allowed) $('#sync-status').textContent = await work() || '';
  } catch (err) {
    $('#sync-status').textContent = err.message;
  } finally {
    button.disabled = false;
    showCode();
  }
}
$('#code-new').addEventListener('click', (e) => codeRun(e.currentTarget, async () => {
  await startSync(state);
  sendPictures(state).then(keepIcons, () => {}); // the thumbnails, then the icons: Settings doesn't wait for them
  return t('syncCodeOn');
}, true));
async function syncWith(code) {
  await useCode(code);
  if (await syncSite(state, true)) render();
  keepIcons();
  return t('syncCodeOn');
}
// With a sync code, the icons this browser has for the user's dials go with them (sync.js), so a browser that has none
// shows them: Firefox lends extensions no icons, and a new Chrome hasn't been to the sites yet. An admin's browser does
// the same for the team's dials (team.js), whose members may never have opened those sites.
// ponytail: an icon is kept once; a site's new icon isn't picked up until the dial's address changes.
// The browser hands an icon over as a PNG, whatever it calls it: Chrome says image/bmp and Edge says nothing, and a
// picture that doesn't say it is one is refused by the browser it is sent to (sync.js fetchInto). So it is kept as
// what it is, and an icon 0.4 kept in Edge without a type is kept again.
const dataUrl = async (blob) => `data:${blob.type};base64,${new Uint8Array(await blob.arrayBuffer()).toBase64()}`;
async function keepIcons() {
  if (!browserIcons) return;
  const code = await syncCode();
  let kept = false;
  for (const d of state.groups.filter((g) => (g.team ? !locked(g) : code)).flatMap(dialsOf)) {
    try {
      if (d.icon?.startsWith('data:image/') || d.ico || !(await findIcon(d.url))) continue;
      d.icon = await dataUrl(new Blob([await (await fetch(faviconUrl(d.url, 32))).blob()], { type: 'image/png' }));
      kept = true;
    } catch {} // that icon another time
  }
  // Nothing the user did: if another admin changed the team first, theirs is shown and nothing is said.
  if (kept) await save(state).then(render, render);
}

// The pictures the team dials name (team.js) come once the dials are drawn, and are stored when they have come. Those
// an admin's earlier save couldn't send go now.
async function teamPictures() {
  sendTeamPictures(state).catch(() => {});
  if (await fetchTeamPictures(state).catch(() => false)) await saveAndRender();
}
$('#code-use').addEventListener('click', (e) => codeRun(e.currentTarget, async () => {
  const done = await syncWith($('#code-input').value);
  $('#code-input').value = '';
  return done;
}, true));
for (const [id, text] of [['#code-copy', (code) => code], ['#code-link', codeLink]]) {
  $(id).addEventListener('click', (e) => codeRun(e.currentTarget, async () => {
    await navigator.clipboard.writeText(text($('#code-shown').value));
    return t('syncCopied');
  }));
}
for (const [id, everywhere] of [['#code-stop', false], ['#code-stop-all', true]]) {
  $(id).addEventListener('click', (e) => codeRun(e.currentTarget, async () => {
    if (everywhere && !confirm(t('confirmSyncStopAll'))) return '';
    await stopSync(everywhere);
    await rejoin(); // back to the browser's own sync
    await saveAndRender();
    return t('syncStopped');
  }));
}
// The join page on nexuscortex.dev handed over a link with a sync code (background.js). Anyone can send such a link,
// and using their code would give them this browser's dials and let them change them: so the link only fills the code
// in, in Settings, next to what it means, and nothing is sent until the user presses "Use this code" there. A browser
// that already syncs with a code is shown that one.
async function offerToSync(link) {
  $('#open-settings').click();
  showTab('sync');
  await showSyncStatus(); // the click's own, already under way, would write over the question below
  await showCode();
  if ($('#code-off').hidden && state.settings.sync !== false) return;
  $('#code-input').value = parseCode(link);
  $('#sync-status').textContent = t('confirmSyncCode');
}

// Jump (jump.js) looks in the browsing history only once it's allowed here. The address bar's "Also look in browsing
// history" opens Settings with what was typed (?jump=…), and allowing it goes straight on to the best match. Saying
// no, or turning it off later, stops the address bar from offering it again.
const jumpQuery = new URLSearchParams(location.search).get('jump');
$('#jump-history').addEventListener('click', async (e) => {
  const box = e.currentTarget;
  const asked = chrome.permissions[box.checked ? 'request' : 'remove']({ permissions: ['history'] }); // first: it needs this click
  box.checked = box.checked && await asked;
  if (!box.checked) await chrome.storage.local.set({ historyDeclined: true });
  else if (jumpQuery) await jump((await jumpList(state)).list, jumpQuery);
});

async function showBackups() {
  const list = $('#backups');
  const backups = await listBackups();
  if (!backups.length) {
    const none = document.createElement('li');
    none.className = 'none';
    none.textContent = t('noCopies');
    list.replaceChildren(none);
    return;
  }
  list.replaceChildren(...backups.map(({ day, dials, groups }) => {
    const li = document.createElement('li');
    const before = day === BEFORE_RESTORE;
    const label = before ? t('beforeRestore')
      : new Date(`${day}T00:00`).toLocaleDateString(uiLanguage(), { weekday: 'short', month: 'short', day: 'numeric' });
    // the copy's own wording for the button, the question and the outcome
    const says = (copy, beforeRestore) => (before ? t(beforeRestore) : t(copy, label));
    const text = document.createElement('span');
    const b = document.createElement('b');
    b.textContent = label;
    text.append(b, t('dialsInGroups', plural(dials, 'nDials'), plural(groups, 'nGroups')));
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn secondary';
    button.textContent = t('restore');
    button.setAttribute('aria-label', says('restoreCopy', 'restoreBefore'));
    button.addEventListener('click', async () => {
      if (!confirm(says('confirmRestoreCopy', 'confirmRestoreBefore'))) return;
      try {
        await restoreBackup(state, day);
      } catch (err) {
        backupStatus(err.message);
        return;
      }
      await saveAndRender();
      showBackups();
      backupStatus(says('restoredCopy', 'restoredBefore'));
    });
    li.append(text, button);
    return li;
  }));
}

// ---------- Google Drive backup, paid unlock ----------
// The Unlock tab is the offer and "I already paid"; it goes once this browser has the unlock.
const when = (time) => new Date(time).toLocaleString(uiLanguage(), { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const backupStatus = (text) => { $('#backup-status').textContent = text; };
const unlockStatus = (text) => { $('#unlock-status').textContent = text; };
let unlocked = false; // as showPlus last saw it, for click handlers that can't wait to ask

async function showPlus() {
  const drive = await getDrive();
  unlocked = await isPaid();
  $('#settings-tabs [value="unlock"]').parentElement.hidden = unlocked;
  $('#unlock-box').hidden = unlocked;
  const hint = t('backupsHint'); // Chinese and Japanese sentences follow on without a space
  $('#backups-hint').textContent = `${hint}${hint.endsWith('。') ? '' : ' '}${t('backupsKept', COPIES, FULL_COPIES)}`;
  const reconnect = drive?.error === signInNeeded();
  $('#drive-connect').hidden = Boolean(drive) && !reconnect;
  $('#drive-connect').textContent = t(reconnect ? 'driveReconnect' : 'driveConnect');
  for (const id of ['#drive-now', '#drive-restore', '#drive-disconnect']) $(id).hidden = !drive;
  $('#drive-status').textContent = !drive ? t('driveIntro')
    : drive.found ? t('driveFound', when(drive.found))
    : drive.error ? t('driveFailed', drive.account, drive.error)
    : drive.lastAt ? t('driveDailyLast', drive.account, when(drive.lastAt))
    : t('driveDaily', drive.account);
}

// Back from the payment page, ask again. Only users who opened it have a purchase id to ask about. Stripe's notice can
// take a minute to arrive, so for a while after opening the page, Settings also asks every 10 seconds.
let paymentOpenedAt = 0;
async function refreshPaid() {
  if (!(await isPaid()) && (await hasAskedToPay()) && (await checkPaid().catch(() => false))) unlockStatus(t('unlocked'));
  showPlus();
}
window.addEventListener('focus', () => { if (settingsDialog.open) refreshPaid(); });
setInterval(() => { if (settingsDialog.open && Date.now() - paymentOpenedAt < 15 * 60e3) refreshPaid(); }, 10_000);

// For buttons that talk to a server: no double clicks, and the outcome goes to the status line of the button's tab.
async function run(button, work, status = backupStatus) {
  button.disabled = true;
  try {
    await work();
  } catch (err) {
    status(err.message);
  } finally {
    button.disabled = false;
    showPlus();
  }
}
// Unlocking sends nexuscortex.dev the purchase id, a license key or a Google ID token: Firefox asks first, like Sort.
const SIGN_IN = { data_collection: ['authenticationInfo'] };
$('#unlock').addEventListener('click', (e) => {
  const allowed = askFirefox ? chrome.permissions.request(SIGN_IN) : true; // first: within the click
  run(e.currentTarget, async () => {
    if (!(await allowed)) return;
    await openPaymentPage();
    paymentOpenedAt = Date.now();
  }, unlockStatus);
});
$('#license-unlock').addEventListener('click', (e) => {
  const allowed = askFirefox ? chrome.permissions.request(SIGN_IN) : true; // first: within the click
  run(e.currentTarget, async () => {
    if (!(await allowed)) return;
    await unlockWithKey($('#license-key').value);
    $('#license-key').value = '';
    unlockStatus(t('unlocked'));
  }, unlockStatus);
});
// "Sign in with Google" under "I already paid": the account that paid unlocks this browser and connects Drive.
$('#account-signin').addEventListener('click', (e) => {
  const granted = chrome.permissions.request({ permissions: identity(), ...(askFirefox && SIGN_IN) }); // first: it needs this click
  run(e.currentTarget, async () => {
    if (!(await granted)) return;
    await connectDrive(true);
    unlockStatus(t('unlocked'));
  }, unlockStatus);
});
// Connecting Drive is between the browser and Google; only a browser with the unlock also tells nexuscortex.dev the
// account (drive.js), which Firefox asks about first.
$('#drive-connect').addEventListener('click', (e) => {
  const granted = chrome.permissions.request({ permissions: identity(), ...(askFirefox && unlocked && SIGN_IN) }); // first: it needs this click
  run(e.currentTarget, async () => {
    if (!(await granted)) return;
    await connectDrive();
    backupStatus(t('driveConnected'));
  });
});
$('#drive-now').addEventListener('click', (e) => run(e.currentTarget, async () => {
  await backUpToDrive(true);
  backupStatus(t('driveBackedUp'));
}));
$('#drive-restore').addEventListener('click', (e) => run(e.currentTarget, async () => {
  if (!confirm(t('confirmDriveRestore'))) return;
  const text = await readDriveBackup();
  const { added, thumbnails } = mergeImport(state, parseImport(text));
  const { settings } = JSON.parse(text);
  if (typeof settings?.background === 'string') state.settings.background = settings.background; // an uploaded picture too
  takeNotesAndTodos(text);
  Object.assign(state.settings, lookOf(settings));
  await saveAndRender();
  await backUpToDrive(true); // the backup now holds this computer's dials too, and daily backups go on from here
  backupStatus([t('driveRestored', plural(added, 'nDials'), plural(thumbnails, 'nThumbnails')), await permissionNote(text)].filter(Boolean).join('\n'));
}));
$('#drive-disconnect').addEventListener('click', (e) => run(e.currentTarget, async () => {
  if (!confirm(t('confirmDriveDisconnect'))) return;
  await disconnectDrive();
  backupStatus(t('driveDisconnected'));
}));

// ---------- teams ----------
// Settings lists the user's teams. Admins get the invite link, the members and the team's daily copies; anyone can
// leave. Creating a team comes with the unlock; joining (by pasting an invite link here, or from the join page) is free.
const teamStatus = (text) => { $('#team-status').textContent = text; };
const smallButton = (key, onClick, kind = 'secondary') => {
  const b = Object.assign(document.createElement('button'), { type: 'button', className: `btn ${kind}`, textContent: t(key) });
  b.addEventListener('click', () => teamRun(b, onClick));
  return b;
};
const hintEl = (text) => Object.assign(document.createElement('p'), { className: 'hint', textContent: text });
const dayLabel = (day) => new Date(`${day}T00:00`).toLocaleDateString(uiLanguage(), { weekday: 'short', month: 'short', day: 'numeric' });

// For buttons that talk to the site: no double clicks, and what went wrong goes to the status line. An answer that the
// user is no longer in a team has taken it off this computer: store that.
async function teamRun(button, work) {
  button.disabled = true;
  try {
    await work();
  } catch (err) {
    teamStatus(err.message);
    if (err.code === 'not-member') { await saveAndRender(); showTeams(); }
  } finally {
    button.disabled = false;
  }
}

async function showTeams() {
  $('#team-new-hint').textContent = t((await isPaid()) ? 'createTeamHint' : 'teamNeedsUnlock');
  $('#team-list').replaceChildren(...Object.entries(state.teams).map(([id, team]) => {
    const li = document.createElement('li');
    li.className = 'plus';
    const head = document.createElement('p');
    head.append(Object.assign(document.createElement('b'), { textContent: team.name }),
      ` · ${t(team.admin ? 'teamAdmin' : 'teamMember')} · ${plural(state.groups.filter((g) => g.team === id).length, 'nTeamGroups')}`);
    const panel = document.createElement('div');
    panel.className = 'teams';
    const row = document.createElement('div');
    row.className = 'row';
    if (team.admin) row.append(smallButton('membersAndLink', () => showMembers(id, panel)), smallButton('dailyCopies', () => showCopies(id, panel)));
    row.append(smallButton('leaveTeam', async () => {
      if (!confirm(t('confirmLeaveTeam', team.name))) return;
      await leaveTeam(state, id);
      await saveAndRender();
      showTeams();
      teamStatus(t('leftTeam', team.name));
    }));
    if (team.admin) row.append(smallButton('deleteTeam', async () => {
      if (!confirm(t('confirmDeleteTeam', team.name))) return;
      await deleteTeam(state, id);
      await saveAndRender();
      showTeams();
      teamStatus(t('deletedTeam', team.name));
    }, 'danger'));
    li.append(head, ...(team.admin && team.frozen ? [hintEl(t('teamFrozen'))] : []), row, panel);
    return li;
  }));
}

// The invite link (copy, replace) and the members with the names they gave: make admin or member, remove.
async function showMembers(id, panel) {
  const { link, members } = await listMembers(state, id);
  const field = Object.assign(document.createElement('input'), { type: 'text', readOnly: true, value: link });
  field.setAttribute('aria-label', t('inviteLink'));
  const linkRow = document.createElement('div');
  linkRow.className = 'row';
  linkRow.append(field, smallButton('copyInviteLink', async () => {
    field.select();
    await navigator.clipboard.writeText(field.value);
    teamStatus(t('inviteLinkCopied'));
  }), smallButton('replaceLink', async () => {
    if (!confirm(t('confirmReplaceLink'))) return;
    field.value = await replaceLink(state, id);
    teamStatus(t('linkReplaced'));
  }));
  const list = document.createElement('ul');
  list.className = 'backups';
  list.append(...members.map((m) => {
    const li = document.createElement('li');
    const text = document.createElement('span');
    text.append(Object.assign(document.createElement('b'), { textContent: m.name }),
      [t('memberJoined', when(m.joined)), m.admin && t('teamAdmin'), m.you && t('you')].filter(Boolean).join(' · '));
    li.append(text, smallButton(m.admin ? 'makeMember' : 'makeAdmin', async () => {
      await setAdmin(state, id, m.id, !m.admin);
      if (m.you) { // no longer an admin here
        state.teams[id].admin = false;
        await saveAndRender();
        return showTeams();
      }
      await showMembers(id, panel);
    }));
    if (!m.you) li.append(smallButton('removeMember', async () => {
      if (!confirm(t('confirmRemoveMember', m.name))) return;
      await removeMember(state, id, m.id); // the new link shows in the list drawn again
      await showMembers(id, panel);
      teamStatus(t('memberRemoved', m.name));
    }, 'danger'));
    return li;
  }));
  panel.replaceChildren(linkRow, list);
}

// The site keeps the team groups as they were before each day's first change, for 30 days.
async function showCopies(id, panel) {
  const days = await listCopies(state, id);
  const list = document.createElement('ul');
  list.className = 'backups';
  list.append(...days.map((day) => {
    const li = document.createElement('li');
    li.append(Object.assign(document.createElement('span'), { textContent: dayLabel(day) }), smallButton('restore', async () => {
      if (!confirm(t('confirmRestoreTeamCopy', dayLabel(day), state.teams[id].name))) return;
      await restoreCopy(state, id, day);
      await saveAndRender();
      teamPictures();
      teamStatus(t('teamCopyRestored', dayLabel(day)));
    }));
    return li;
  }));
  if (!days.length) list.append(Object.assign(document.createElement('li'), { className: 'none', textContent: t('noTeamCopies') }));
  panel.replaceChildren(hintEl(t('teamCopiesHint')), list);
}

// A team sends nexuscortex.dev the member's name, the credential that makes this browser a member and, from an admin,
// the team's groups and their dials' pictures (a thumbnail can be a picture of a page), all but the credential
// encrypted with the key in the invite link: Firefox asks first, like Sort.
const TEAM_DATA = { data_collection: ['personallyIdentifyingInfo', 'authenticationInfo', 'bookmarksInfo', 'websiteContent'] };
$('#team-create').addEventListener('click', (e) => {
  const allowed = askFirefox ? chrome.permissions.request(TEAM_DATA) : true; // first: within the click
  teamRun(e.currentTarget, async () => {
    if (!(await allowed)) return;
    if (!(await isPaid())) {
      showTab('unlock');
      unlockStatus(t('teamNeedsUnlock'));
      return;
    }
    const [name, me] = [$('#team-name').value.trim(), $('#team-me').value.trim()];
    if (!name || !me) return (name ? $('#team-me') : $('#team-name')).focus();
    const group = await createTeam(state, name, me);
    state.activeGroup = group.id;
    await saveAndRender();
    $('#team-name').value = '';
    await showTeams();
    teamStatus(t('teamCreated', name));
    $('#team-list').lastElementChild.querySelector('.btn').click(); // the invite link, to share
  });
});

// Joining: the team is named before the user says yes and gives the name the team will know them by.
const joinDialog = $('#join-dialog');
const joinForm = $('#join-form');
let invite = null;
async function askToJoin(link) {
  invite = await peekTeam(link);
  if (invite.joined) throw new Error(t('alreadyInTeam', invite.name));
  $('#join-heading').textContent = t('joinHeading', invite.name);
  joinDialog.returnValue = '';
  joinDialog.showModal();
}
$('#invite-join').addEventListener('click', (e) => {
  const allowed = askFirefox ? chrome.permissions.request(TEAM_DATA) : true; // first: within the click
  teamRun(e.currentTarget, async () => {
    if (!(await allowed)) return;
    await askToJoin($('#invite-link').value);
    $('#invite-link').value = '';
  });
});
joinDialog.addEventListener('close', async () => {
  const name = joinForm.name.value.trim();
  if (joinDialog.returnValue !== 'join' || !name) return;
  try {
    await joinTeam(state, invite, name);
    await saveAndRender();
    teamPictures();
    showError(t('joinedTeam', invite.name), true);
    if (settingsDialog.open) showTeams();
  } catch (err) {
    showError(err.message);
  }
});

async function addTopSites() {
  try {
    const added = await addMostVisited(state, activeGroup().id); // first: it asks for a permission within this click
    if (added === null) return;
    await saveAndRender();
    $('#import-status').textContent = added ? t('addedSites', plural(added, 'nSites')) : t('mostVisitedAlreadyHere');
  } catch (err) {
    showError(t('mostVisitedFailed', err.message));
  }
}
$('#settings-dialog .add-top-sites').addEventListener('click', addTopSites);
for (const [name, shown] of Object.entries(sliders)) {
  $(`#${name}`).addEventListener('input', (e) => {
    state.settings[name] = Number(e.target.value);
    $(`#${name}-out`).textContent = shown(e.target.value);
    saveAndRender();
  });
}
$('#titles-on').addEventListener('change', (e) => { state.settings.titles = e.target.checked; saveAndRender(); });
$('#theme').addEventListener('change', (e) => { state.settings.theme = e.target.value; saveAndRender(); });
$('#font').addEventListener('input', (e) => { state.settings.font = e.target.value.trim().replace(/["\\]/g, ''); saveAndRender(); });
// The fonts on this computer, to pick from, each under the name the browser shows for it: asked of the browser when the
// field is first entered (chrome.fontSettings, which names families only and so answers at once; queryLocalFonts took
// 9 s to describe 1,615 faces). Firefox has no such list: there a font's name is typed. The list stays in the page.
$('#font').addEventListener('focus', async () => {
  try {
    $('#fonts').replaceChildren(...(await chrome.fontSettings.getFontList()).map((f) => new Option(f.displayName, f.fontId)));
  } catch {}
}, { once: true });
$('#search-on').addEventListener('change', (e) => {
  state.settings.searchBox = e.target.checked;
  $('#search').value = query = '';
  saveAndRender();
});
for (const sw of document.querySelectorAll('.swatch[data-bg]')) {
  const bg = sw.dataset.bg;
  sw.style.backgroundImage = backgroundKind(bg) === 'photo' ? `url("${bg.replace('.webp', '-s.webp')}")` : bg; // a photo's small copy
  sw.addEventListener('click', () => { state.settings.background = sw.dataset.bg; saveAndRender(); });
}
$('#bg-color').addEventListener('input', (e) => { state.settings.background = e.target.value; saveAndRender(); });
$('#bg-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    // No larger than the screen can show, and kept as the file it is when it fits: compressing it again only costs sharpness.
    state.settings.background = await readAsDataUrl(file, Math.max(2560, Math.max(screen.width, screen.height) * devicePixelRatio), 3e6);
    saveAndRender();
  } catch {
    showError(t('imageUnreadable'));
  }
});

$('#export').addEventListener('click', async () => {
  const blob = new Blob([exportState(state, await historyOn())], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `tabdial-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
});

// An import can name a dial's icon by a link: Infinity's backup does, its icons being on Infinity's servers. Each is
// fetched once, here, and kept in the dial, small; shown from the link, it would ask that server on every new tab.
// One that doesn't come within a few seconds is left out, and the dial shows its site's own icon, as any other does.
async function fetchIcons(groups) {
  await Promise.all(groups.flatMap(dialsOf).filter((d) => /^https:/i.test(d.icon || '')).map(async (d) => {
    try {
      const picture = await createImageBitmap(await (await fetch(d.icon, { signal: AbortSignal.timeout(6000) })).blob());
      const canvas = new OffscreenCanvas(64, 64);
      canvas.getContext('2d').drawImage(picture, 0, 0, 64, 64);
      d.icon = await dataUrl(await canvas.convertToBlob());
    } catch {
      delete d.icon;
    }
  }));
}

// The notes and to-dos of a Tabdial export or Drive backup, merged in by id as sync does. Returns how many are new.
function takeNotesAndTodos(text) {
  let notes, todos;
  try { ({ notes, todos } = JSON.parse(text)); } catch { return [0, 0]; }
  const had = new Set([...state.notes, ...state.todos].map((x) => x.id));
  const valid = Array.isArray(notes) ? notes.filter((n) => typeof n?.id === 'string' && typeof n.rev === 'string' && Number.isFinite(n.at) && typeof n.html === 'string') : [];
  state.notes = mergeNotes(state.notes, valid, null);
  state.todos = mergeTodos(state.todos, (Array.isArray(todos) && readTodos(syncedTodos(todos.filter(Boolean)))) || [], null);
  return [state.notes.filter((n) => !had.has(n.id) && !noteBlank(n.html)).length, state.todos.filter((x) => !had.has(x.id)).length];
}

async function importText(text) {
  const status = $('#import-status');
  try {
    const groups = parseImport(text);
    await fetchIcons(groups);
    const { added, thumbnails } = mergeImport(state, groups);
    const notes = infinityNotes(text).map(clean).filter((html) => !noteBlank(html) && !state.notes.some((n) => n.html === html));
    state.notes.push(...notes.map(newNote));
    const todos = infinityTodos(text).filter((x) => !state.todos.some((y) => y.text === x.text));
    for (const { text: words, done } of todos) state.todos.push({ ...newTodo(words, posBefore(state.todos)), done });
    const [ownNotes, ownTodos] = takeNotesAndTodos(text); // a Tabdial export's own
    await saveAndRender();
    status.textContent = added && thumbnails ? t('importedAndRestored', plural(added, 'nDials'), plural(thumbnails, 'nThumbnails'))
      : added ? t('imported', plural(added, 'nDials'))
      : thumbnails ? t('restoredThumbnails', plural(thumbnails, 'nThumbnails'))
      : t('nothingToImport');
    if (notes.length + ownNotes) status.textContent += `\n${t('importedNotes', plural(notes.length + ownNotes, 'nNotes'))}`;
    if (todos.length + ownTodos) status.textContent += `\n${t('importedTodos', plural(todos.length + ownTodos, 'nTodos'))}`;
    const permission = await permissionNote(text);
    if (permission) status.textContent += `\n${permission}`;
  } catch (err) {
    status.textContent = err.message;
  }
}
$('#import-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (file) importText(await file.text());
});
$('#import-paste').addEventListener('click', () => {
  importText($('#import-text').value);
  $('#import-text').value = '';
});

// Resize uploads so a photo doesn't bloat storage. A picture that is already small enough, in pixels and at most
// `keepBytes` as a file, is stored as it is (an animated one then still moves).
function readAsDataUrl(file, maxSide, keepBytes = 0) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
      if (scale === 1 && file.size <= keepBytes) {
        URL.revokeObjectURL(img.src);
        const reader = Object.assign(new FileReader(), { onload: () => resolve(reader.result), onerror: reject });
        return reader.readAsDataURL(file);
      }
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(img.src);
      resolve(canvas.toDataURL('image/jpeg', 0.85));
    };
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}

// Keep open tabs in sync when another tab (or the toolbar button) changes the data.
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area === 'sync') { // another computer changed the list, or the user joined or left a team (here or on another computer)
    if (Object.keys(changes).some((key) => key !== 'teams' && key !== 'purchaseId' && key !== 'syncCode')) state = await load();
    const teamsChanged = changes.teams && await refreshTeams(state);
    if (teamsChanged) await saveAndRender();
    else render();
    if (teamsChanged) teamPictures();
    // Not for this page's own joining or creating, which changes nothing here: drawing the list again would close
    // the invite link Settings has just opened under the new team.
    if (settingsDialog.open && (teamsChanged || !changes.teams)) showTeams();
    if (changes.syncCode) { // a sync code came from, or was dropped on, another computer (this page's own is up to date)
      syncSite(state).then((changed) => changed && render(), () => {}).then(keepIcons);
      if (settingsDialog.open) showCode();
    }
    return;
  }
  if (area === 'local' && changes.paid) labelSort();
  if (area === 'local' && (changes.paid || changes.drive) && settingsDialog.open) showPlus(); // e.g. the daily backup ran
  if (area !== 'local' || !changes.tabdial) return;
  if (changes.tabdial.newValue?.rev === state.rev) return; // our own save
  state = await load();
  render();
});

// ---------- one-time prompts ----------
// Asked once: after a week of use with 5+ dials. Rating or closing it means it never comes back. Returns whether it shows.
async function askForRating() {
  const { installedAt, ratingPromptDone } = await chrome.storage.local.get(['installedAt', 'ratingPromptDone']);
  if (ratingPromptDone || !installedAt || Date.now() - installedAt < 7 * 864e5 || countDials(state) < 5) return false;
  // Rate on the store Tabdial came from (Edge can also install from the Chrome Web Store); the store sets update_url.
  const fromEdgeStore = /edge\.microsoft\.com/.test(chrome.runtime.getManifest().update_url || '');
  // Firefox: the listing's slug is set to "tabdial" on addons.mozilla.org.
  $('#rate-link').href = location.protocol === 'moz-extension:' ? 'https://addons.mozilla.org/firefox/addon/tabdial/reviews/'
    : fromEdgeStore ? `https://microsoftedge.microsoft.com/addons/detail/${chrome.runtime.id}`
    : `https://chromewebstore.google.com/detail/${chrome.runtime.id}/reviews`;
  $('#rate').showPopover();
  return true;
}
$('#rate-link').addEventListener('click', () => $('#rate').hidePopover());
$('#rate').addEventListener('toggle', (e) => { if (e.newState === 'closed') chrome.storage.local.set({ ratingPromptDone: true }); });

// Once there are dials, a tip about Jump, never at the same time as the rating prompt. Closing it, or using Jump, ends it.
async function showJumpTip() {
  const { jumpHintDone } = await chrome.storage.local.get('jumpHintDone');
  if (!jumpHintDone && countDials(state)) $('#jump-tip').showPopover();
}
$('#jump-tip').addEventListener('toggle', (e) => { if (e.newState === 'closed') chrome.storage.local.set({ jumpHintDone: true }); });

render();
tick();
document.fonts.ready.then(clearClock); // the clock's width in the font picked in Settings
askForRating().then((asked) => asked || showJumpTip());
recheckPaid();
const teamsReady = refreshTeams(state).then((changed) => changed && saveAndRender(), () => {}).then(teamPictures);
// offline, or the site is down: as it last was. The icons once the team groups are the site's, not while they change.
syncSite(state).then((changed) => changed && render(), () => {}).then(() => teamsReady).then(keepIcons);
shareLook();
// The join page on nexuscortex.dev hands an invite link, or a link with a sync code, over through the service worker
// (background.js).
if (location.hash.startsWith('#join=')) {
  const link = decodeURIComponent(location.hash.slice('#join='.length));
  history.replaceState(null, '', location.pathname + location.search);
  (parseCode(link) ? offerToSync(link) : askToJoin(link)).catch((err) => showError(err.message));
}
if (jumpQuery !== null) {
  $('#open-settings').click();
  showTab('jump');
  $('#jump-history').focus();
}
