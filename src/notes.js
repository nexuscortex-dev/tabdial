// Notes: the user's own pages of rich text, in a drawer of the new tab page (newtab.js). They are `state.notes`, each
// { id, rev, at, html }: `rev` changes with every edit (sync compares it), `at` is when it was last edited (the list is
// newest first). The html is what the editor wrote, put through clean() before it is ever shown.
//
// They follow the user the way the look does (sync.js). Through the browser's own sync a note is [id, rev, at, html],
// its pictures named, not carried: <img data-pic="ID"> (synced()); a computer that never had one shows its place.
// With a sync code the encrypted list holds only an index of the notes, [id, rev, at, ref]: each note's text (its
// "body", the html with its pictures named) is kept by the site on its own, encrypted, as a picture is, under an id
// worked out from it and the key (forSite()). So the notes don't weigh on the list, one note's change is one body,
// and a body the site already has (the same text) isn't sent again. A body too long to be kept that way (MAX_DATA)
// stays in the index itself, as its html. A note whose body this browser hasn't fetched yet is { id, rev, at, body }
// with no html: it isn't shown, and goes on being named, until fetchPictures (sync.js) brings the body (fromSite()).
//
// The pure helpers are unit-tested in Node; clean() needs a DOM, and is tested in the page (test/e2e.mjs).

const rid = () => crypto.getRandomValues(new Uint8Array(9)).toBase64({ alphabet: 'base64url' });

export const newNote = (html = '') => ({ id: rid(), rev: rid(), at: Date.now(), html });
export function edit(note, html) {
  note.html = html;
  note.rev = rid();
  note.at = Date.now();
}
export const newestFirst = (notes) => [...notes].sort((a, b) => b.at - a.at);

// ---------- merging ----------
// Take the synced notes (`theirs`, local form) into this computer's, knowing what both had when they last met (`seen`,
// id → rev; null: never). A note changed on one side only takes that side's; one deleted on one side and unchanged on
// the other goes; one changed on both (or, the first time, two different notes under one id) is kept twice, the one
// edited last in its place and the other as a copy. Nothing written on either side is lost. Returns the notes.
// `copies` false (to-dos, todos.js): of one changed on both, the one changed last is kept, and no copy.
export function mergeNotes(mine, theirs, seen, copies = true) {
  const here = new Map(mine.map((n) => [n.id, n]));
  const there = new Map(theirs.map((n) => [n.id, n]));
  const out = [];
  for (const id of new Set([...here.keys(), ...there.keys()])) {
    const m = here.get(id);
    const t = there.get(id);
    const was = seen?.[id];
    if (m && t) {
      if (m.rev === t.rev || t.rev === was) out.push(m); // the same, or changed here only
      else if (m.rev === was) out.push(t); // changed there only
      else {
        const [first, second] = m.at >= t.at ? [m, t] : [t, m];
        out.push(first);
        if (copies && second.html !== first.html) out.push({ ...second, id: rid(), rev: rid() });
      }
    } else if (m) {
      if (!was || m.rev !== was) out.push(m); // new here, or changed here after it was deleted there
    } else if (!was || t.rev !== was) out.push(t); // new there, or changed there after it was deleted here
  }
  return out;
}

// id → rev of synced notes, for the next merge.
export const revsOf = (synced) => synced && Object.fromEntries(synced.map(([id, rev]) => [id, rev]));

// Synced notes as Tabdial writes them, or null: whoever can write to the user's sync could put anything there.
export function readSynced(value) {
  const ok = Array.isArray(value) && value.every((n) => Array.isArray(n) && n.length === 4 && typeof n[0] === 'string'
    && typeof n[1] === 'string' && Number.isFinite(n[2]) && typeof n[3] === 'string');
  return ok ? value : null;
}

// ---------- pictures ----------
const PICTURE_IN = /<img src="(data:image\/[^"]+)">/g;
const NAMED_IN = /<img data-pic="([\w-]{22})">/g;

export const shown = (notes) => notes.filter((n) => typeof n.html === 'string'); // not waiting for their body
const isId = (ref) => /^[\w-]{22}$/.test(ref);

// A note's html with its pictures named by `idOf` (async, picture → id). One it can't name (too big to sync, idOf
// answers '') is left out there.
async function body(html, idOf) {
  const ids = new Map();
  for (const [, data] of html.matchAll(PICTURE_IN)) ids.set(data, await idOf(data));
  return html.replace(PICTURE_IN, (all, data) => (ids.get(data) ? `<img data-pic="${ids.get(data)}">` : ''));
}

// The notes as the browser's own sync carries them: [id, rev, at, html].
export const synced = (notes, idOf) => Promise.all(shown(notes).map(async ({ id, rev, at, html }) => [id, rev, at, await body(html, idOf)]));

// The notes as the site keeps them: the index, and the bodies it names by id (bodyId: body → id, or '' when too long).
export async function forSite(notes, idOf, bodyId) {
  const bodies = new Map();
  const index = await Promise.all(notes.map(async (n) => {
    if (typeof n.html !== 'string') return [n.id, n.rev, n.at, n.body]; // not here yet: as it was named
    const text = await body(n.html, idOf);
    const ref = await bodyId(text);
    if (ref) bodies.set(ref, text);
    return [n.id, n.rev, n.at, ref || text];
  }));
  return { index, bodies };
}

// Synced notes as this computer keeps them, the bodies and pictures `have` has (id → body or picture) put in.
export const local = (notes, have) => notes.map(([id, rev, at, ref]) => {
  if (!isId(ref)) return { id, rev, at, html: withPictures(ref, have) };
  return have.has(ref) ? { id, rev, at, html: withPictures(have.get(ref), have) } : { id, rev, at, body: ref };
});
export const withPictures = (html, have) => html.replace(NAMED_IN, (all, id) => (have.has(id) && have.get(id).startsWith('data:image/') ? `<img src="${have.get(id)}">` : all));

// Bodies and pictures have come (id → what it is): put them in the notes waiting for them.
export function fill(notes, have) {
  for (const n of notes) {
    if (typeof n.html !== 'string' && have.has(n.body)) {
      n.html = have.get(n.body);
      delete n.body;
    }
    if (typeof n.html === 'string') n.html = withPictures(n.html, have);
  }
}

// The pictures in these notes (local form); the ids of the bodies and pictures they name and this computer doesn't
// have yet.
export const picturesIn = (notes) => shown(notes).flatMap((n) => [...n.html.matchAll(PICTURE_IN)].map((m) => m[1]));
export const namedIn = (notes) => notes.flatMap((n) => (typeof n.html === 'string' ? [...n.html.matchAll(NAMED_IN)].map((m) => m[1]) : [n.body]));
// What an index and its bodies name on the site: the bodies, and the pictures in them.
export const namedBy = (index, bodies) => [...(index || []).map(([, , , ref]) => ref).filter(isId),
  ...[...bodies.values(), ...(index || []).map(([, , , ref]) => ref).filter((ref) => !isId(ref))].flatMap((html) => [...html.matchAll(NAMED_IN)].map((m) => m[1]))];

// ---------- cleaning ----------
// Only what the editor makes, and nothing that runs or reaches out: the html came from the user's sync, a pasted page
// or an imported file. Other elements give up their text (script and the like nothing); links are http(s) or mailto;
// pictures are data: images or named ones; styles are a color and a background color.
const KEEP = new Set(['P', 'BR', 'B', 'STRONG', 'I', 'EM', 'U', 'S', 'DEL', 'STRIKE', 'H1', 'H2', 'H3', 'UL', 'OL', 'LI', 'BLOCKQUOTE',
  'PRE', 'CODE', 'A', 'SPAN', 'MARK', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TD', 'TH', 'IMG', 'HR', 'SUB', 'SUP']);
const DROP = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'TEMPLATE', 'SVG', 'MATH', 'NOSCRIPT', 'TITLE', 'HEAD', 'META', 'LINK',
  'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'VIDEO', 'AUDIO', 'CANVAS', 'FORM']);
const AS = { DIV: 'P', H4: 'H3', H5: 'H3', H6: 'H3', FONT: 'SPAN', INS: 'U' };
const COLOR = /^(#[0-9a-f]{3,8}|rgba?\([\d\s.,%]+\)|[a-z]{3,20})$/i;

export function clean(html) {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  const out = doc.createElement('body');
  const copy = (from, to) => {
    for (const node of from.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) { to.append(node.textContent); continue; }
      if (node.nodeType !== Node.ELEMENT_NODE || DROP.has(node.tagName)) continue;
      const tag = AS[node.tagName] || node.tagName;
      if (!KEEP.has(tag)) { copy(node, to); continue; }
      const el = doc.createElement(tag);
      if (tag === 'A') {
        const href = node.getAttribute('href') || '';
        if (/^(https?:|mailto:)/i.test(href)) el.setAttribute('href', href);
      } else if (tag === 'IMG') {
        const src = node.getAttribute('src') || '';
        const pic = node.getAttribute('data-pic') || '';
        if (/^data:image\/(png|jpeg|gif|webp);base64,[\w+/=]+$/.test(src)) el.setAttribute('src', src);
        else if (/^[\w-]{22}$/.test(pic)) el.setAttribute('data-pic', pic);
        else continue; // a picture on a server: it would be asked for on every new tab
      } else if (tag === 'UL' && node.hasAttribute('data-checklist')) el.setAttribute('data-checklist', '');
      else if (tag === 'LI' && node.getAttribute('data-done') === 'true') el.setAttribute('data-done', 'true');
      else if (tag === 'TD' || tag === 'TH') {
        for (const name of ['colspan', 'rowspan']) if (/^\d{1,2}$/.test(node.getAttribute(name) || '')) el.setAttribute(name, node.getAttribute(name));
      }
      const style = [['color', node.style?.color || (node.tagName === 'FONT' && node.getAttribute('color'))], ['background-color', node.style?.backgroundColor]]
        .filter(([, v]) => v && COLOR.test(v.trim())).map(([name, v]) => `${name}: ${v.trim()}`).join('; ');
      if (style && ['SPAN', 'MARK', 'TD', 'TH'].includes(tag)) el.setAttribute('style', style);
      copy(node, el);
      if (tag === 'SPAN' && !el.attributes.length) to.append(...el.childNodes);
      else if (tag !== 'P' || el.childNodes.length) to.append(el); // a paragraph with nothing in it shows nothing
    }
  };
  copy(doc.body, out);
  return out.innerHTML;
}
