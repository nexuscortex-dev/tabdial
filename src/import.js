// Import/export helpers; the only chrome.* call is for message text, so they can be tested in Node.
import { uid, normalizeUrl, shortTitle } from './store.js';
import { addMissing, dialsOf, ownGroups } from './merge.js';
import { t } from './i18n.js';

// Every parser returns [{ name, dials: [{ url, title, image }] }] or null if the text isn't its format. Among a group's
// dials, a folder is { name, dials }. Formats of other speed dials are documented in docs/import-formats.md.
const parsers = [parseTabdial, parseFvd, parseSpeedDial2, parseGroupSpeedDial, parseSpeedDialNet, parseToby, parseYasd, parseInfinity];

// Thrown for problems the user should see as-is; anything else means "not this format".
class ImportError extends Error {}

export function parseImport(text) {
  let data;
  try { data = JSON.parse(String(text).trim()); } catch { throw new ImportError(t('importUnknown')); }
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
    : { url: d.url, title: d.title || '', image: d.image || '' });
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
// group; a folder inside one of those is a folder of that group, with the bookmarks of the folders inside it too.
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
    const [top, second] = path;
    const group = groups.get(top) || home;
    if (second && !folders.has(second)) {
      folders.set(second, { name: String(second.title || t('folder')), index: second.index, dials: [] });
      group.dials.push(folders.get(second));
    }
    (folders.get(second) || group).dials.push({ url: b.url, title: b.title || '', image: thumbs.get(b.url) || '', index: b.index });
  }
  const shown = (list) => (y.settings?.defaultSort === 'last' ? list : list.reverse());
  const item = ({ index, ...d }) => (d.dials ? { ...d, dials: shown(d.dials.map(item)) } : d);
  return [home, ...groups.values()].map((g) => ({ name: g.name, dials: shown(g.dials.sort((a, b) => a.index - b.index).map(item)) }))
    .filter((g) => g.dials.length);
}

// Infinity New Tab (infinityBackup-….infinity): {version: 'v2', data: {site: {sites: [[item, …], …]}}}, a list per page.
// A site is {name, target}, a folder {name, children}; its widgets are sites whose target is infinity://…: left out.
// Each page becomes a group (Home, Home 2, …), its folders folders. The icons are on Infinity's servers: not taken.
function parseInfinity(data) {
  const pages = data?.data?.site?.sites;
  if (!Array.isArray(pages)) return null;
  const dials = (items) => items.filter((s) => /^https?:/i.test(s.target || '')).map((s) => ({ url: s.target, title: s.name || '', image: '' }));
  const items = (page) => page.flatMap((s) => (Array.isArray(s.children) ? [{ name: String(s.name || t('folder')), dials: dials(s.children) }] : dials([s])))
    .filter((d) => !d.dials || d.dials.length);
  return pages.map((page, i) => ({ name: i ? `${t('defaultGroup')} ${i + 1}` : t('defaultGroup'), dials: items(page) })).filter((g) => g.dials.length);
}

// The user's own groups: team groups are the team's (also for the Drive backup, which is this file).
// `jumpHistory`: whether Jump looked in the browsing history on the computer that made the file (permissionNote).
export function exportState(state, jumpHistory = false) {
  const item = ({ name, dials, url, title, image }) => (dials ? { name, dials: dials.map(item) } : { url, title, image });
  return JSON.stringify({
    app: 'tabdial',
    exportedAt: new Date().toISOString(),
    groups: ownGroups(state.groups).map(item),
    settings: state.settings,
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
// already there (same address) are skipped, except that an imported thumbnail fills one the dial is missing (e.g.
// after its list came back from sync without images). A folder holds only dials: what a file has in folders inside
// it goes into it. Team groups are never merged into. Returns how many dials were added and how many got their
// thumbnail back.
export function mergeImport(state, groups) {
  let added = 0;
  let thumbnails = 0;
  const dial = (d) => ({ id: uid(), url: normalizeUrl(d.url), title: d.title || '', image: d.image || '' });
  const all = (d) => (d.dials ? d.dials.flatMap(all) : [d]);
  for (const g of groups) {
    let target = ownGroups(state.groups).find((x) => x.name.toLowerCase() === g.name.toLowerCase());
    if (!target) state.groups.push(target = { id: uid(), name: g.name, dials: [] });
    const items = g.dials.map((d) => (d.dials ? { id: uid(), name: d.name, dials: all(d).map(dial) } : dial(d)));
    for (const d of items.flatMap(all)) {
      const have = dialsOf(target).find((x) => x.url === d.url);
      if (have && !have.image && d.image) { have.image = d.image; thumbnails++; }
    }
    added += addMissing(target, items);
  }
  return { added, thumbnails };
}
