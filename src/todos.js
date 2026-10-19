// To-dos: the user's list of things to do, in a card on the new tab page (newtab.js). They are `state.todos`, each
// { id, rev, at, text, done, pos, due }: `rev` changes with every change (sync compares it), `at` is when it last changed,
// `pos` places a to-do among those not done (smaller first; a new one goes first), `due` is when it is due, in the
// user's own clock: '' (never), a day ('2026-10-20') or a day and time ('2026-10-20T14:00'), which the background
// worker reminds them of (background.js). Those done are shown apart, the one done last first.
//
// They follow the user the way the notes do (sync.js): through the browser's own sync in chunks of their own, or with a
// sync code in what is encrypted with the list, each as [id, rev, at, text, done (1 or 0), pos], and due after them when it has one. 0.5 reads
// only rows of 6. The browser's sync carries the dues in the rows, so a 0.5 browser takes in no to-do list with one, and
// writes none over it either, until it updates. The site gets the rows of 6 and the dues apart (forSite), since a 0.5
// browser that couldn't read them would write its old ones over them: it keeps to the list, writing it back without
// the dues, and a browser that reads them back without any keeps its own (null in the 7th place, mergeTodos). Two computers that
// changed the same to-do before either heard of the other keep the change made last (notes.js mergeNotes).

import { mergeNotes, revsOf } from './notes.js';

const rid = () => crypto.getRandomValues(new Uint8Array(9)).toBase64({ alphabet: 'base64url' });
export const MAX_TEXT = 500;
export const DUE = /^\d{4}-\d\d-\d\d(T\d\d:\d\d)?$/;

export const newTodo = (text, pos) => ({ id: rid(), rev: rid(), at: Date.now(), text: text.slice(0, MAX_TEXT), done: false, pos, due: '' });
export function change(todo, fields) {
  Object.assign(todo, fields, { rev: rid(), at: Date.now() });
  todo.text = todo.text.slice(0, MAX_TEXT);
}
export const pending = (todos) => todos.filter((x) => !x.done).sort((a, b) => a.pos - b.pos);
export const finished = (todos) => todos.filter((x) => x.done).sort((a, b) => b.at - a.at);
// Where a to-do put before `next` among those not done goes (none: last; first: before them all).
export function posBefore(todos, next) {
  const list = pending(todos);
  const i = next ? list.indexOf(next) : list.length;
  const [a, b] = [list[i - 1]?.pos, list[i]?.pos];
  return a === undefined ? (b ?? 0) - 1 : b === undefined ? a + 1 : (a + b) / 2;
}

// As sync carries them, and back.
export const synced = (todos) => todos.map(({ id, rev, at, text, done: d, pos, due }) => [id, rev, at, text, d ? 1 : 0, pos, ...(due ? [due] : [])]);
export const local = (rows) => rows.map(([id, rev, at, text, d, pos, due = '']) => ({ id, rev, at, text, done: d === 1, pos, due }));
// What goes to the site, and back. A list read without dues goes back without them.
export function forSite(rows) {
  const todos = rows.map((x) => x.slice(0, 6));
  return rows.some((x) => x[6] === null) ? { todos } : { todos, dues: rows.filter((x) => x[6]).map((x) => [x[0], x[6]]) };
}
export function fromSite(todos, dues) {
  if (!Array.isArray(todos)) return todos;
  const of = Array.isArray(dues) ? new Map(dues.filter((x) => Array.isArray(x) && DUE.test(x[1]))) : null;
  return todos.map((x) => (!Array.isArray(x) ? x : !of ? [...x, null] : of.has(x[0]) ? [...x, of.get(x[0])] : x));
}
// Synced to-dos as Tabdial writes them, or null: whoever can write to the user's sync could put anything there.
export function readSynced(value) {
  const ok = Array.isArray(value) && value.length <= 2000 && value.every((x) => Array.isArray(x) && (x.length === 6 || (x.length === 7 && (x[6] === null || DUE.test(x[6]))))
    && typeof x[0] === 'string' && typeof x[1] === 'string' && Number.isFinite(x[2]) && typeof x[3] === 'string'
    && x[3].length <= MAX_TEXT && (x[4] === 0 || x[4] === 1) && Number.isFinite(x[5]));
  return ok ? value : null;
}

// Take synced to-dos (`theirs`, as sync carries them) into this computer's, knowing what both had when they last met
// (`seen`, the same form; null: never).
export function mergeTodos(mine, theirs, seen) {
  const out = mergeNotes(mine, local(theirs), revsOf(seen), false);
  for (const x of out) if (x.due === null) x.due = mine.find((m) => m.id === x.id)?.due || ''; // from a 0.5 browser
  return out;
}

// When a due day and time is, in ms (the user's clock as it is now); null for none, or a day alone.
export const remindAt = (due) => (due?.includes('T') ? new Date(due).getTime() : null);
// A day in the user's clock as due dates write it ('2026-10-20'), `add` days on.
export const dayOf = (date, add = 0) => {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate() + add);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60e3).toISOString().slice(0, 10);
};
// 'over' once a due to-do's day (or day and time) has gone by, 'today' on its day, else ''.
export function dueState(due, now = new Date()) {
  if (!due) return '';
  const today = dayOf(now);
  const day = due.slice(0, 10);
  if (day < today || (due.includes('T') && remindAt(due) <= now.getTime())) return 'over';
  return day === today ? 'today' : '';
}
// The part of the list a to-do not done goes in: 'over', 'today', 'tomorrow', 'later', or 'none' without a due date.
export function sectionOf(due, now = new Date()) {
  if (!due) return 'none';
  return dueState(due, now) || (due.slice(0, 10) === dayOf(now, 1) ? 'tomorrow' : 'later');
}
export const SECTIONS = ['over', 'today', 'tomorrow', 'later'];
// Within a part: soonest first, those with a time before those with a day alone; then as the user placed them.
const dueKey = (due) => (due.includes('T') ? due : `${due}T24:00`);
export const byDue = (a, b) => dueKey(a.due).localeCompare(dueKey(b.due)) || a.pos - b.pos;
