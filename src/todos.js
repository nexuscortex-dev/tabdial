// To-dos: the user's list of things to do, in a card on the new tab page (newtab.js). They are `state.todos`, each
// { id, rev, at, text, done, pos }: `rev` changes with every change (sync compares it), `at` is when it last changed,
// `pos` places a to-do among those not done (smaller first; a new one goes first). Those done are shown apart, the one
// done last first.
//
// They follow the user the way the notes do (sync.js): through the browser's own sync in chunks of their own, or with a
// sync code in what is encrypted with the list, each as [id, rev, at, text, done (1 or 0), pos]. Two computers that
// changed the same to-do before either heard of the other keep the change made last (notes.js mergeNotes).

import { mergeNotes, revsOf } from './notes.js';

const rid = () => crypto.getRandomValues(new Uint8Array(9)).toBase64({ alphabet: 'base64url' });
export const MAX_TEXT = 500;

export const newTodo = (text, pos) => ({ id: rid(), rev: rid(), at: Date.now(), text: text.slice(0, MAX_TEXT), done: false, pos });
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
export const synced = (todos) => todos.map(({ id, rev, at, text, done: d, pos }) => [id, rev, at, text, d ? 1 : 0, pos]);
export const local = (rows) => rows.map(([id, rev, at, text, d, pos]) => ({ id, rev, at, text, done: d === 1, pos }));
// Synced to-dos as Tabdial writes them, or null: whoever can write to the user's sync could put anything there.
export function readSynced(value) {
  const ok = Array.isArray(value) && value.length <= 2000 && value.every((x) => Array.isArray(x) && x.length === 6
    && typeof x[0] === 'string' && typeof x[1] === 'string' && Number.isFinite(x[2]) && typeof x[3] === 'string'
    && x[3].length <= MAX_TEXT && (x[4] === 0 || x[4] === 1) && Number.isFinite(x[5]));
  return ok ? value : null;
}

// Take synced to-dos (`theirs`, as sync carries them) into this computer's, knowing what both had when they last met
// (`seen`, the same form; null: never).
export const mergeTodos = (mine, theirs, seen) => mergeNotes(mine, local(theirs), revsOf(seen), false);
