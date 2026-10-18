// Shared by imports, sync, "add most visited sites", Sort and Jump. No imports, so store.js, sync.js and import.js can all use it.

// Two addresses are the same dial when they differ only in ways the browser ignores: "https://A.com" = "https://a.com/".
export const urlKey = (url) => { try { return new URL(url).href; } catch { return url; } };
export const sameUrl = (a, b) => urlKey(a) === urlKey(b);

export function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
}

// The address to store, or '' if it isn't one. With a scheme, it's taken as typed; without one, it gets https:// and
// must name a real-looking host (a dot, localhost or a port), so a stray word or a typo like "githubcom" is refused.
export function normalizeUrl(raw) {
  const s = String(raw || '').trim();
  if (!s || /^(javascript|data|vbscript):/i.test(s)) return ''; // a dial must never run code
  const typedScheme = /^[a-z][a-z0-9+.-]*:(?!\d)/i.test(s); // "localhost:3000" is a host and port, not a scheme
  try {
    const url = new URL(typedScheme ? s : `https://${s}`);
    if (!typedScheme && !/[.:]/.test(url.hostname) && url.hostname !== 'localhost' && !url.port) return '';
  } catch {
    return '';
  }
  return typedScheme ? s : `https://${s}`;
}

// A group's `dials` are its dials and its folders, in the order shown; a folder is { id, name, dials } and holds dials
// and folders. `itemsIn` is every dial and folder of a group (or of a folder), however deep; `dialsOf` its dials.
export const itemsIn = (group) => group.dials.flatMap((d) => [d, ...(d.dials ? itemsIn(d) : [])]);
export const dialsOf = (group) => itemsIn(group).filter((d) => !d.dials);

// Of dials and folders, the dials `keep` says yes to; a folder left with none is left out.
export const pick = (items, keep) => items.flatMap((d) => {
  if (!d.dials) return keep(d) ? [d] : [];
  const dials = pick(d.dials, keep);
  return dials.length ? [{ ...d, dials }] : [];
});

// Add dials to a group, skipping addresses the group already has (the same site may sit in two groups on purpose).
// A folder's contents go into the folder the list has with that id, else that name, else the folder comes along, and
// so on down; two folders can have the same name, so each of the list's takes in one. Dials come in finished: final
// id, normalized url. Returns how many were added.
export function addMissing(group, items) {
  const seen = new Set(dialsOf(group).map((d) => urlKey(d.url)));
  const fresh = (d) => {
    if (!d.url || seen.has(urlKey(d.url))) return false;
    seen.add(urlKey(d.url));
    return true;
  };
  let added = 0;
  const into = (list, items) => {
    const had = list.filter((d) => d.dials);
    for (const item of items) {
      if (!item.dials) {
        if (fresh(item)) { list.push(item); added++; }
        continue;
      }
      let i = had.findIndex((f) => f.id === item.id);
      if (i < 0) i = had.findIndex((f) => f.name.toLowerCase() === item.name.toLowerCase());
      if (i >= 0) { into(had.splice(i, 1)[0].dials, item.dials); continue; }
      const folder = { ...item, dials: [] };
      into(folder.dials, item.dials);
      if (folder.dials.length) list.push(folder);
    }
  };
  into(group.dials, items);
  return added;
}

// Give dials without a thumbnail the one a dial in `from` has, matched by id, then by address; and dials without an
// icon the one kept there for their address (an icon is its site's, whatever dial shows it).
export function fillImages(groups, from) {
  const dials = from.flatMap(dialsOf);
  const byId = new Map(dials.filter((d) => d.image).map((d) => [d.id, d.image]));
  const byUrl = new Map(dials.filter((d) => d.image).map((d) => [d.url, d.image]));
  const icons = new Map(dials.filter((d) => d.icon).map((d) => [d.url, d.icon]));
  for (const d of groups.flatMap(dialsOf)) {
    d.image ||= byId.get(d.id) || byUrl.get(d.url) || '';
    if (!d.icon && icons.has(d.url)) d.icon = icons.get(d.url);
  }
}

// Team groups (team.js) aren't the user's own: they stay out of Chrome sync, daily copies, backups and imports.
export const ownGroups = (groups) => groups.filter((g) => !g.team);

// The user's own groups replaced by `own` (from sync or a daily copy), with the team groups kept where they were.
export function withTeamGroups(groups, own) {
  const out = [...own];
  groups.forEach((g, i) => { if (g.team) out.splice(i, 0, g); });
  return out;
}

export const countDials = (state) => state?.groups.reduce((n, g) => n + dialsOf(g).length, 0) || 0;
