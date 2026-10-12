import { load, save, syncNow, syncSite, uid, normalizeUrl, addDial, targetGroup, listBackups, restoreBackup, addMostVisited, BEFORE_RESTORE, COPIES, FULL_COPIES } from './store.js';
import { parseImport, exportState, mergeImport, historyOn, permissionNote } from './import.js';
import { countDials, dialsOf, sameUrl, hostOf, ownGroups } from './merge.js';
import { syncCode, siteAllowed, parseCode, codeLink, startSync, useCode, stopSync, sendPictures, SYNC_DATA } from './sync.js';
import { readOnly, refreshTeams, fetchTeamPictures, sendTeamPictures, createTeam, peekTeam, joinTeam, leaveTeam, deleteTeam, listMembers, removeMember, replaceLink, setAdmin, listCopies, restoreCopy } from './team.js';
import { isPaid, checkPaid, recheckPaid, hasAskedToPay, openPaymentPage, unlockWithKey } from './pay.js';
import { suggestMoves, loose } from './sort.js';
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
// A group's dials are its dials and its folders (merge.js); these find things by the id of a dial or a folder.
const findFolder = (id) => state.groups.flatMap((g) => g.dials).find((d) => d.dials && d.id === id);
const folderOf = (dialId) => state.groups.flatMap((g) => g.dials).find((d) => d.dials?.some((c) => c.id === dialId));
const groupOf = (id) => state.groups.find((g) => g.dials.some((d) => d.id === id || d.dials?.some((c) => c.id === id)));
const listOf = (id) => folderOf(id)?.dials || groupOf(id)?.dials; // the list it sits in: its folder's, or its group's
// Team groups (team.js): only a team's admins change them, while the team isn't frozen.
const locked = (group) => readOnly(state, group);
const teamName = (group) => state.teams[group.team]?.name || '';
const adminTeams = () => Object.entries(state.teams).filter(([, team]) => team.admin && !team.frozen);

// Draw the change right away, then store it; a failed save is shown rather than lost silently. A team's problem
// (another admin saved first, a refund) may have put the site's version back, so the page is drawn again; so it is
// when the save brought dials another browser had synced meanwhile (sync.js).
const saveAndRender = () => {
  // a folder exists only while it holds a dial
  for (const g of state.groups) for (let i = g.dials.length; i--;) if (g.dials[i].dials?.length === 0) g.dials.splice(i, 1);
  render();
  return save(state).then((merged) => { if (merged) render(); },
    (err) => { render(); showError(err.name === 'TeamError' ? err.message : t('saveFailed', err.message)); });
};

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
function render() {
  iconOf = new Map(state.groups.flatMap(dialsOf).filter((d) => d.icon).map((d) => [d.url, d.icon]));
  const { background, columns } = state.settings;
  const kind = backgroundKind(background);
  document.body.style.backgroundColor = kind === 'color' ? background : '';
  document.body.style.backgroundImage = { default: '', color: 'none', gradient: background, image: `url("${background}")`, photo: `url("${background}")` }[kind];
  document.body.dataset.tone = toneOf(background);
  const { backgroundColor: color, backgroundImage: image } = document.body.style; // for paint.js
  try { localStorage.setItem('paint', JSON.stringify(kind === 'image' ? null : { color, image, tone: document.body.dataset.tone })); } catch {}
  document.documentElement.style.setProperty('--cols', columns);
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
    b.addEventListener('drop', (e) => { e.preventDefault(); b.classList.remove('drop-target'); if (moveDial(dragId, g.id)) saveAndRender(); });
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
  const items = dials.map((d) => (d.dials ? folderTile(d, !fixed) : dialTile(d, !found && !fixed, found ? locked(groupOf(d.id)) : fixed)));

  $('#grid').style.setProperty('--n', dials.length ? Math.min(dials.length + (found || fixed ? 0 : 1), columns) : columns);
  if (found) $('#grid').replaceChildren(...items, ...(found.length ? [] : [noMatch()]));
  else if (fixed) $('#grid').replaceChildren(...items, ...(group.dials.length ? [] : [noMatch(t('teamGroupEmpty'))]));
  else $('#grid').replaceChildren(...items, group.dials.length || group.team ? addTile() : welcome());
  if (folderDialog.open) renderFolder();
}

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
  label.textContent = d.title || hostOf(d.url);
  meta.append(fav, label);
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

// A folder shows its first four dials in small; clicking it opens it.
function folderTile(folder, movable) {
  const li = document.createElement('li');
  li.draggable = movable;
  li.dataset.id = folder.id;
  const button = document.createElement('button');
  button.className = 'tile folder';
  button.draggable = false;
  const four = document.createElement('div');
  four.className = 'four';
  four.append(...folder.dials.slice(0, 4).map((d) => thumbEl(d.url, d.image, d.title)));
  const meta = document.createElement('div');
  meta.className = 'meta';
  const label = document.createElement('span');
  label.className = 'label';
  label.textContent = folder.name;
  const count = document.createElement('span');
  count.className = 'count';
  count.textContent = plural(folder.dials.length, 'nDials');
  meta.append(label, count);
  button.append(four, meta);
  button.addEventListener('click', () => openFolder(folder.id));
  li.append(button);
  if (movable) wireDrag(li);
  return li;
}

// ---------- folder ----------
// An open folder: its dials over the page, its name to change at the top. Dragging a dial out of it closes it, so the
// dial can be dropped in the group behind.
const folderDialog = $('#folder-dialog');
let openFolderId = null; // by id, for the same reason as editingId

function openFolder(id) {
  openFolderId = id;
  folderDialog.showModal();
  renderFolder();
}
function renderFolder() {
  const folder = findFolder(openFolderId);
  if (!folder) return folderDialog.close(); // emptied or deleted, here or elsewhere
  const fixed = locked(groupOf(folder.id));
  $('#folder-name').value = folder.name;
  $('#folder-name').readOnly = fixed;
  $('#folder-grid').replaceChildren(...folder.dials.map((d) => dialTile(d, !fixed, fixed)));
}
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
  setTimeout(tick, 60e3 - (now % 60e3));
}

// ---------- drag and drop ----------
// A dial or a folder is dragged by its tile, in a group or in an open folder. Dropped on the left edge of a tile it
// goes before it; on the rest of the tile, a dial makes a folder with the dial there, or goes into the folder there.
// A folder holds only dials: a folder being dragged, and anything dropped in an open folder, only ever goes before.
let dragId = null;

const dropsInto = (li, e) => {
  const r = li.getBoundingClientRect();
  return !li.closest('#folder-grid') && Boolean(findDial(dragId)) && e.clientX - r.left > r.width * .3;
};
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
  li.addEventListener('dragend', () => {
    dragId = null;
    document.querySelectorAll('.dragging, .drop-before, .drop-into').forEach((n) => n.classList.remove('dragging', 'drop-before', 'drop-into'));
  });
  li.addEventListener('dragover', (e) => {
    if (!dragId || dragId === li.dataset.id) return;
    e.preventDefault();
    document.querySelectorAll('.drop-before, .drop-into').forEach((n) => n.classList.remove('drop-before', 'drop-into'));
    li.classList.add(dropsInto(li, e) ? 'drop-into' : 'drop-before');
  });
  li.addEventListener('drop', (e) => {
    e.preventDefault();
    if (dragId === li.dataset.id || !listOf(dragId) || !listOf(li.dataset.id)) return; // gone meanwhile
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
}

// `copy`: a dial of a team group the user can't change, copied as a new dial into one of their own groups.
function openDialDialog(dial, copy = false) {
  editingId = copy ? null : dial?.id ?? null;
  pendingImage = copy ? '' : dial?.image || '';
  $('#dial-heading').textContent = t(copy ? 'copyToMyGroup' : dial ? 'editDial' : 'addDial');
  $('#delete-dial').hidden = !editingId;
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

// The folder field: none, one of the chosen group's folders, or a new one. '+' can't be a folder's id.
const NEW_FOLDER = '+';
function listFolders(selected) {
  const group = state.groups.find((g) => g.id === dialForm.group.value);
  const folders = (group?.dials || []).filter((d) => d.dials);
  dialForm.folder.replaceChildren(new Option(t('noFolder'), ''), ...folders.map((f) => new Option(f.name, f.id)), new Option(t('newFolder'), NEW_FOLDER));
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
  // Where it goes: into the chosen folder, into a new one (where the dial was, if it was loose in that group), or
  // loose into the group. A dial that is there already stays where it is.
  const folder = findFolder(dialForm.folder.value);
  if (dialForm.folder.value === NEW_FOLDER) {
    const list = targetGroup(state, groupId).dials;
    const i = list.findIndex((d) => d.id === dial.id);
    take(dial.id);
    list.splice(i < 0 ? list.length : i, 0, { id: uid(), name: t('folder'), dials: [dial] });
  } else if (!folder) moveDial(dial.id, groupId);
  else if (folderOf(dial.id) !== folder) folder.dials.push(take(dial.id));
  saveAndRender();
});

$('#delete-dial').addEventListener('click', () => {
  if (listOf(editingId)) take(editingId);
  dialDialog.close('deleted');
  saveAndRender();
});

// ---------- group dialog ----------
const groupDialog = $('#group-dialog');
const groupForm = $('#group-form');
let editingGroupId = null; // by id, for the same reason as editingId

function openGroupDialog(group) {
  editingGroupId = group?.id ?? null;
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
  if (groupDialog.returnValue !== 'save') return;
  const name = groupForm.name.value.trim();
  if (!name) return;
  if (editingGroupId) {
    const group = state.groups.find((g) => g.id === editingGroupId);
    if (group) group.name = name; // else it was deleted elsewhere meanwhile
  } else {
    const group = { id: uid(), name, dials: [], ...(groupForm.team.value && { team: groupForm.team.value }) };
    state.groups.push(group);
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

// ---------- sort (paid) ----------
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
$('#open-settings').addEventListener('click', () => {
  $('#columns').value = state.settings.columns;
  $('#columns-out').textContent = state.settings.columns;
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
  const { syncError } = await chrome.storage.local.get('syncError');
  $('#sync-status').textContent = state.settings.sync !== false && syncError || '';
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
async function keepIcons() {
  if (!browserIcons) return;
  const code = await syncCode();
  let kept = false;
  for (const d of state.groups.filter((g) => (g.team ? !locked(g) : code)).flatMap(dialsOf)) {
    try {
      if (d.icon || d.ico || !(await findIcon(d.url))) continue;
      const blob = await (await fetch(faviconUrl(d.url, 32))).blob();
      d.icon = `data:${blob.type};base64,${new Uint8Array(await blob.arrayBuffer()).toBase64()}`;
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
  const { background, columns } = JSON.parse(text).settings || {};
  if (typeof background === 'string') state.settings.background = background;
  if (Number.isInteger(columns)) state.settings.columns = columns;
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
$('#columns').addEventListener('input', (e) => {
  state.settings.columns = Number(e.target.value);
  $('#columns-out').textContent = e.target.value;
  saveAndRender();
});
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
    state.settings.background = await readAsDataUrl(file, 2560);
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

async function importText(text) {
  const status = $('#import-status');
  try {
    const { added, thumbnails } = mergeImport(state, parseImport(text));
    await saveAndRender();
    status.textContent = added && thumbnails ? t('importedAndRestored', plural(added, 'nDials'), plural(thumbnails, 'nThumbnails'))
      : added ? t('imported', plural(added, 'nDials'))
      : thumbnails ? t('restoredThumbnails', plural(thumbnails, 'nThumbnails'))
      : t('nothingToImport');
    const note = await permissionNote(text);
    if (note) status.textContent += `\n${note}`;
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

// Resize uploads so a photo doesn't bloat storage.
function readAsDataUrl(file, maxSide) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
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
askForRating().then((asked) => asked || showJumpTip());
recheckPaid();
const teamsReady = refreshTeams(state).then((changed) => changed && saveAndRender(), () => {}).then(teamPictures);
// offline, or the site is down: as it last was. The icons once the team groups are the site's, not while they change.
syncSite(state).then((changed) => changed && render(), () => {}).then(() => teamsReady).then(keepIcons);
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
