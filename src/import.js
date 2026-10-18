// Import/export helpers; the only chrome.* call is for message text, so they can be tested in Node.
import { uid, normalizeUrl, shortTitle } from './store.js';
import { addMissing, dialsOf, ownGroups } from './merge.js';
import { t } from './i18n.js';

// Every parser returns [{ name, dials: [{ url, title, image }] }] or null if the text isn't its format. Among a group's
// dials, a folder is { name, dials }, with dials and folders in it. A dial can come with its site's `icon`: a picture, or a link the page fetches
// once before the dials are merged in (newtab.js fetchIcons). Formats of other speed dials are documented in
// docs/import-formats.md.
const parsers = [parseTabdial, parseFvd, parseSpeedDial2, parseGroupSpeedDial, parseSpeedDialNet, parseToby, parseYasd, parseInfinity, parseBookmarks];

// Thrown for problems the user should see as-is; anything else means "not this format".
class ImportError extends Error {}

export function parseImport(text) {
  let data = String(text).trim();
  try { data = JSON.parse(data); } catch {} // a browser's bookmarks file isn't JSON: it stays text, for parseBookmarks
  for (const parse of parsers) {
    let groups = null;
    try { groups = parse(data); } catch (e) { if (e instanceof ImportError) throw e; }
    // Real exports carry stray spaces in titles (Speed Dial 2 saves "Github ").
    const tidy = (d) => (d.dials ? { ...d, dials: d.dials.map(tidy) } : { ...d, title: String(d.title || '').trim() });
    if (groups && groups.length) return groups.map(tidy);
  }
  throw new ImportError(t('importUnknown'));
}

function parseTabdial(data) {
  if (data?.app !== 'tabdial' || !Array.isArray(data.groups)) return null;
  const item = (d) => (Array.isArray(d.dials) ? { name: String(d.name || t('folder')), dials: d.dials.map(item) }
    : { url: d.url, title: d.title || '', image: d.image || '', ...(d.icon && { icon: d.icon }) });
  return data.groups.map((g) => ({ name: String(g.name || t('importedGroup')), dials: (g.dials || []).map(item) }));
}

// Only images that work on another computer: inline data or web URLs.
const portableImage = (v) => (typeof v === 'string' && /^(data:image\/|https?:)/.test(v) ? v : '');
const byPosition = (a, b) => (a.position ?? 0) - (b.position ?? 0);
const asArray = (v) => (Array.isArray(v) ? v : Object.values(v || {})); // some exports store arrays as objects

// Speed Dial [FVD]: text copied from its export box, {db:{dials,groups}, prefs}.
// Its preinstalled dials open affiliate redirects (url) but show the plain site (display_url); keep the plain one.
function parseFvd(data) {
  if (!data?.db?.dials || !data.db.groups || !data.prefs) return null;
  return asArray(data.db.groups).sort(byPosition).map((g) => ({
    name: String(g.name || t('importedGroup')),
    dials: asArray(data.db.dials).filter((d) => d.group_id === g.id && (d.display_url || d.url)).sort(byPosition).map((d) => ({
      url: d.display_url || d.url,
      title: d.title || d.auto_title || '',
      image: portableImage(d.thumb) || (d.thumb_source_type === 'url' ? portableImage(d.thumb_url) : ''),
    })),
  }));
}

// Speed Dial 2: {dials, groups, preferences}; group 0 is the built-in Home group.
function parseSpeedDial2(data) {
  if (!data?.dials || !data.groups || !(data.preferences || data.settings)) return null;
  const dials = asArray(data.dials);
  if (!dials.every((d) => 'idgroup' in d)) return null;
  const home = data.preferences?.defaultGroupName || t('defaultGroup');
  const groups = asArray(data.groups).sort(byPosition);
  if (!groups.some((g) => Number(g.id) === 0)) groups.unshift({ id: 0 });
  return groups.map((g) => ({
    name: Number(g.id) === 0 ? home : String(g.title || t('importedGroup')),
    dials: dials
      .filter((d) => Number(d.idgroup) === Number(g.id) && d.url)
      .sort((a, b) => (a.position ?? 999) - (b.position ?? 999) || (a.ts_created ?? 0) - (b.ts_created ?? 0))
      .map((d) => ({ url: d.url, title: d.title || '', image: portableImage(d.thumbnail) })),
  }));
}

// Group Speed Dial (.group_speed_dial): whole storage dump; dials are grid slots, empty ones are {}.
function parseGroupSpeedDial(data) {
  if (!Array.isArray(data?.groups) || !(data.metadata || data.___thumbnails)) return null;
  if (data.metadata?.e2e) throw new ImportError(t('importEncrypted'));
  const thumbs = new Map((data.___thumbnails || []).map((t) => [`${t.group}|${t.url}`, portableImage(t.img)]));
  return data.groups.filter((g) => !g.archived).map((g) => ({
    name: String(g.name || t('importedGroup')),
    dials: (g.dials || []).filter((d) => d.type === 0 && d.url).map((d) => ({
      url: d.url,
      title: d.name || '',
      image: (d.thumbnail?.type === 2 ? portableImage(d.thumbnail.value) : '') || thumbs.get(`${g.id}|${d.url}`) || '',
    })),
  }));
}

// "Speed Dial" by speed-dial.net (export.spd): {categories, links, opts}.
function parseSpeedDialNet(data) {
  if (!Array.isArray(data?.links) || !data.opts) return null;
  const categories = data.categories?.length ? data.categories : [{ id: 1, name: 'Main' }];
  const categoryOf = (l) => (l.category == null || l.category === 'main' ? 1 : Number(l.category));
  return categories.map((c) => ({
    name: String(c.name || t('importedGroup')),
    dials: data.links.filter((l) => categoryOf(l) === Number(c.id) && l.url).map((l) => ({
      url: l.url,
      title: l.title || '',
      // favicon is a tiny icon, not a tile image, so only logo/capture images are kept
      image: portableImage(l.logo) || portableImage(l.bgImage),
    })),
  }));
}

// Toby (.json): a workspace export {version: 4, groups: [{lists}]} (its groups are Toby's spaces) or a collection export
// {lists}. Each collection becomes a group. Notes are cards too, with an address inside Toby (/note.html#…): left out.
// A card's title is the page's own unless the user renamed it, so it's shortened like a most visited site's.
function parseToby(data) {
  const lists = Array.isArray(data?.lists) ? data.lists
    : data?.version === 4 && Array.isArray(data.groups) && data.groups.every((g) => Array.isArray(g.lists)) ? data.groups.flatMap((g) => g.lists)
    : null;
  return lists?.map((l) => ({
    name: String(l.title || t('importedGroup')),
    dials: (l.cards || []).filter((c) => /^https?:/i.test(c.url || '')).map((c) => ({ url: c.url, title: c.customTitle || shortTitle(c.title), image: '' })),
  })) ?? null;
}

// Yet Another Speed Dial (yasd-export-….json): {yasd: {bookmarks, folders, settings, dials}}; its dials are bookmarks,
// listed folder by folder in order. Bookmarks at the top of its folder make the Home group and each folder there a
// group; the folders inside one of those are its folders, and the folders inside those theirs.
// `index` is a bookmark's or folder's place in its parent. It shows the newest first unless set to "New dials last".
// Thumbnails are kept per address.
function parseYasd(data) {
  const y = data?.yasd;
  if (!Array.isArray(y?.bookmarks) || !Array.isArray(y.folders)) return null;
  const thumbs = new Map((y.dials || []).flatMap((d) => Object.entries(d || {})).map(([url, v]) => [url, portableImage(v?.thumbnails?.[v.thumbIndex || 0])]));
  const byId = new Map(y.folders.map((f) => [f.id, f]));
  const home = { name: t('defaultGroup'), dials: [] };
  const groups = new Map(y.folders.filter((f) => !byId.has(f.parentFolderid)).map((f) => [f, { name: String(f.title || t('importedGroup')), dials: [] }]));
  const folders = new Map(); // by the YASD folder they come from
  for (const b of y.bookmarks.filter((b) => /^https?:/i.test(b.url || ''))) {
    const path = []; // the folders the bookmark is in, outermost first; a file whose folders go in a circle ends there
    for (let f = byId.get(b.folderid); f && !path.includes(f); f = byId.get(f.parentFolderid)) path.unshift(f);
    let list = groups.get(path[0]) || home;
    for (const f of path.slice(1)) {
      if (!folders.has(f)) list.dials.push(folders.set(f, { name: String(f.title || t('folder')), index: f.index, dials: [] }).get(f));
      list = folders.get(f);
    }
    list.dials.push({ url: b.url, title: b.title || '', image: thumbs.get(b.url) || '', index: b.index });
  }
  const shown = (list) => (y.settings?.defaultSort === 'last' ? list : list.reverse());
  const item = ({ index, ...d }) => (d.dials ? { ...d, dials: shown(d.dials.sort((a, b) => a.index - b.index).map(item)) } : d);
  return [home, ...groups.values()].map(item).filter((g) => g.dials.length);
}

// Infinity New Tab (infinityBackup-….infinity): {version: 'v2', data: {site: {sites: [[item, …], …]}}}, a list per page.
// A site is {name, target}, a folder {name, children}; its widgets are sites whose target is infinity://…: left out.
// Each page becomes a group (Home, Home 2, …), its folders folders. A site's icon is a link to Infinity's servers
// (bgImage): it comes along as that link, for the page to fetch once.
function parseInfinity(data) {
  const pages = data?.data?.site?.sites;
  if (!Array.isArray(pages)) return null;
  const dials = (items) => items.filter((s) => /^https?:/i.test(s.target || '')).map((s) => ({
    url: plainAddress(s.target), title: s.name || '', image: '', ...(s.bgType === 'image' && /^https:/i.test(s.bgImage || '') && { icon: s.bgImage }),
  }));
  const items = (page) => page.flatMap((s) => (Array.isArray(s.children) ? [{ name: String(s.name || t('folder')), dials: dials(s.children) }] : dials([s])))
    .filter((d) => !d.dials || d.dials.length);
  return pages.map((page, i) => ({ name: i ? `${t('defaultGroup')} ${i + 1}` : t('defaultGroup'), dials: items(page) })).filter((g) => g.dials.length);
}

// Infinity's notes (data.note.list), each as a note: its title (plain text) as a heading over its content, which its
// editor keeps as HTML (a paragraph to a <p>, bold, links). The page cleans it (notes.js clean) before keeping it.
export function infinityNotes(text) {
  let list;
  try { list = JSON.parse(text)?.data?.note?.list; } catch {}
  if (!Array.isArray(list)) return [];
  const escape = (s) => String(s).replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  return list.map((n) => `${n.title?.trim() ? `<h2>${escape(n.title.trim())}</h2>` : ''}${typeof n.content === 'string' ? n.content : ''}`);
}

// Infinity's to-dos (data.todo.todoList), each { text, done }, oldest first.
export function infinityTodos(text) {
  let list;
  try { list = JSON.parse(text)?.data?.todo?.todoList; } catch {}
  if (!Array.isArray(list)) return [];
  return list.filter((x) => typeof x?.text === 'string' && x.text.trim()).sort((a, b) => (a.time || 0) - (b.time || 0))
    .map((x) => ({ text: x.text.trim(), done: x.done === true }));
}

// The sites Infinity starts with open affiliate links, and its file keeps no plain address beside them (FVD's does).
// Only what a link says itself is undone: a tracker that names the address it goes on to, utm_ tags, and the tags on a
// site's front page. A link that doesn't say where it leads (s.click.taobao.com/t?e=…) stays as it is, and so does
// every address none of this applies to, to the letter.
// ponytail: the trackers and tags of the sites 11.0.41 starts with; Infinity's library has more. Add them as they show up.
const CARRIERS = { 'c.duomai.com': 't', 'union.dangdang.com': 'backurl' };
const TAGS = new Set(['tn', 'ie', 'allianceid', 'sid', 'vfm', 'fv', 'pid', 'pic']);
function plainAddress(target) {
  // Infinity's own page for JD forwards to c.duomai.com with t=https://www.jd.com (read 2026-10-13)
  if (/^https?:\/\/homepage\.inftab\.com\/jd\b/i.test(target)) return 'https://www.jd.com/';
  let url;
  try { url = new URL(target.trim().replace(/&(amp;)+/g, '&')); } catch { return target; } // its file has "&amp;amp;amp;" for "&"
  const carried = CARRIERS[url.hostname];
  const onward = carried && url.searchParams.get(carried);
  if (/^https?:\/\//i.test(onward || '')) return onward;
  const tagged = url.search;
  for (const key of [...url.searchParams.keys()]) if (key.startsWith('utm_')) url.searchParams.delete(key);
  if (url.pathname === '/' && [...url.searchParams.keys()].every((key) => TAGS.has(key))) url.search = '';
  return url.search === tagged ? target : url.href;
}

// A browser's exported bookmarks (bookmarks.html, the format every browser writes): nested <DL> lists, a bookmark an
// <A HREF>, a folder an <H3> with the <DL> after it. A folder at the top (the bookmarks bar) becomes a group and the
// folders in it its folders, with the folders inside them; bookmarks outside every folder make a group of their own. Addresses that aren't a website's (javascript:, place:) are left out.
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unescaped = (html) => html.replace(/<[^>]*>/g, '').replace(/&(#x[\da-f]{1,6}|#\d{1,7}|\w+);/gi, (all, name) => {
  if (name[0] !== '#') return ENTITIES[name.toLowerCase()] ?? all;
  const code = /^#x/i.test(name) ? parseInt(name.slice(2), 16) : Number(name.slice(1));
  return code <= 0x10FFFF ? String.fromCodePoint(code) : all;
});
function parseBookmarks(text) {
  if (typeof text !== 'string' || !/^<!DOCTYPE NETSCAPE-Bookmark-file-1>/i.test(text)) return null;
  const loose = { name: t('importedGroup'), dials: [] };
  const path = [loose]; // the folders the place being read is in, outermost first
  for (const [, folder, href, title] of text.matchAll(/<H3[^>]*>(.*?)<\/H3>|<A\s[^>]*?HREF="([^"]*)"[^>]*>(.*?)<\/A>|<\/DL>/gis)) {
    if (folder !== undefined) {
      path.push({ name: unescaped(folder).trim() || t('folder'), dials: [] });
      path.at(-2).dials.push(path.at(-1));
    } else if (href === undefined) {
      if (path.length > 1) path.pop(); // </DL> ends the folder; the last one ends the file's own list
    } else if (/^https?:/i.test(href)) path.at(-1).dials.push({ url: unescaped(href), title: unescaped(title), image: '' });
  }
  const dials = (d) => (d.dials ? d.dials.flatMap(dials) : [d]);
  return [{ ...loose, dials: loose.dials.filter((d) => !d.dials) }, ...loose.dials.filter((d) => d.dials)].filter((g) => dials(g).length);
}

// The user's own groups: team groups are the team's (also for the Drive backup, which is this file).
// `jumpHistory`: whether Jump looked in the browsing history on the computer that made the file (permissionNote).
export function exportState(state, jumpHistory = false) {
  const item = ({ name, dials, url, title, image, icon }) => (dials ? { name, dials: dials.map(item) } : { url, title, image, icon });
  return JSON.stringify({
    app: 'tabdial',
    exportedAt: new Date().toISOString(),
    groups: ownGroups(state.groups).map(item),
    settings: state.settings,
    notes: state.notes,
    todos: state.todos,
    jumpHistory,
  }, null, 2);
}

// Whether Jump may look in the browsing history on this computer.
export const historyOn = () => chrome.permissions.contains({ permissions: ['history'] });

// A permission can't come with a file: the browser asks the user for it on each computer. So when the file was made
// with Jump looking in the browsing history and this computer hasn't allowed that, taking the file in says so.
export async function permissionNote(text) {
  let was = false;
  try { was = JSON.parse(text).jumpHistory === true; } catch {}
  return was && !(await historyOn()) ? t('jumpHistoryAgain', t('jumpHistory')) : '';
}

// Merge imported groups into state: same-named groups are combined, and so are same-named folders in them, and dials
// already there (same address) are skipped, except that an imported thumbnail or icon fills one the dial is missing
// (e.g. after its list came back from sync without images). A folder with no dial in it, however deep, is left out.
// Team groups are never merged into. Returns how many dials were added and how many got their
// thumbnail back.
export function mergeImport(state, groups) {
  let added = 0;
  let thumbnails = 0;
  // An icon is kept only as a picture: shown from a link, it would ask that server on every new tab.
  const dial = (d) => ({ id: uid(), url: normalizeUrl(d.url), title: d.title || '', image: d.image || '',
    ...(typeof d.icon === 'string' && d.icon.startsWith('data:image/') && { icon: d.icon }) });
  const item = (d) => (d.dials ? { id: uid(), name: d.name, dials: d.dials.map(item) } : dial(d));
  for (const g of groups) {
    let target = ownGroups(state.groups).find((x) => x.name.toLowerCase() === g.name.toLowerCase());
    if (!target) state.groups.push(target = { id: uid(), name: g.name, dials: [] });
    const items = g.dials.map(item);
    for (const d of dialsOf({ dials: items })) {
      const have = dialsOf(target).find((x) => x.url === d.url);
      if (have && !have.image && d.image) { have.image = d.image; thumbnails++; }
      if (have && !have.icon && !have.ico && d.icon) have.icon = d.icon;
    }
    added += addMissing(target, items);
  }
  return { added, thumbnails };
}
