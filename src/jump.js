// Jump: `z` and a few words in the address bar opens the dial or browsing-history page that has every word in its
// address or title, the one visited most often and most recently first, like `z` in a shell. The address bar side is
// in background.js; the browsing history is turned on and off in Settings.
import { dialsOf, urlKey } from './merge.js';

// zoxide's frecency: the visits, weighted by how long ago the last one was.
export function frecency(visits, lastVisit, now) {
  const age = now - lastVisit;
  return visits * (age < 36e5 ? 4 : age < 864e5 ? 2 : age < 7 * 864e5 ? 0.5 : 0.25);
}

// Every dial and history page once (a dial and a page with the same address are one), best first. A dial takes the
// visits of its page in the history; one never visited still counts, after the visited ones, in grid order. The words
// leave out the https:// and www. that every address has.
export function candidates(dials, pages, now = Date.now()) {
  const byUrl = new Map();
  for (const { url, title } of dials) if (!byUrl.has(urlKey(url))) byUrl.set(urlKey(url), { url, title, score: 0 });
  for (const p of pages) {
    const score = frecency(p.visitCount, p.lastVisitTime, now);
    const dial = byUrl.get(urlKey(p.url));
    if (dial) dial.score = score;
    else byUrl.set(urlKey(p.url), { url: p.url, title: p.title || '', score });
  }
  return [...byUrl.values()].sort((a, b) => b.score - a.score)
    .map((c) => ({ ...c, words: `${c.url.replace(/^https?:\/\/(www\.)?/i, '')}\n${c.title}`.toLowerCase() }));
}

// The candidates with every word of `text` in their address or title, ignoring case. No words: all of them. Like z
// trying a strict match before a loose one, those where every word starts a word come first (`g` finds Google before
// Agent); the others still match, after them, as Chinese titles have no spaces between words.
export function matching(list, text) {
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  const starts = words.map((w) => new RegExp(`(?:^|[^\\p{L}\\p{N}])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'u'));
  const first = [], rest = [];
  for (const c of list) {
    if (words.every((w) => c.words.includes(w))) (starts.every((r) => r.test(c.words)) ? first : rest).push(c);
  }
  return first.concat(rest);
}

// The dials, plus the browsing history once the user has allowed it in Settings.
export async function jumpList(state) {
  const allowed = await chrome.permissions.contains({ permissions: ['history'] });
  // ponytail: the newest 5000 pages only; raise it if old favorites go missing. startTime: the default is the last day.
  const pages = allowed ? await chrome.history.search({ text: '', startTime: 0, maxResults: 5000 }) : [];
  return { allowed, list: candidates(state.groups.flatMap(dialsOf), pages.filter((p) => /^https?:/.test(p.url))) };
}

// The Search box: the dials of every group, those of the group being viewed first, each with its `dial`. matching()
// puts the ones where every word starts a word ahead, keeping this order within each; jump() opens the first match or
// searches the web, as Jump does.
export function searchBoxList(groups, activeId) {
  const dials = [...groups.filter((g) => g.id === activeId), ...groups.filter((g) => g.id !== activeId)].flatMap(dialsOf);
  return candidates(dials, []).map((c) => ({ ...c, dial: dials.find((d) => d.url === c.url) }));
}

// Open the best match for what was typed (or the suggestion picked, by its address) where the address bar says to:
// onInputEntered's disposition. With no match, search the web for it with the browser's default search engine.
export function jump(list, text, disposition = 'currentTab') {
  const best = list.find((c) => c.url === text) || matching(list, text)[0];
  if (best) return open(best.url, disposition);
  if (text.trim()) return chrome.search.query({ text, disposition: disposition === 'currentTab' ? 'CURRENT_TAB' : 'NEW_TAB' });
}

export function open(url, disposition) {
  return disposition === 'currentTab' ? chrome.tabs.update({ url }) : chrome.tabs.create({ url, active: disposition === 'newForegroundTab' });
}
