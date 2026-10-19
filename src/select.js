// Selection: several dials and folders of one list (a group's, or an open folder's) deleted, moved to another group,
// put in a folder or taken out of one at once. Each of these returns what undo() needs to put things back where they
// were. Nothing here saves; the caller does, after prune().
import { dialsOf, sameUrl } from './merge.js';

// Where an item sits: its group, the folders down to the list holding it, that list and its place in it.
function locate(state, id) {
  for (const group of state.groups) {
    const walk = (list, chain) => {
      const index = list.findIndex((d) => d.id === id);
      if (index >= 0) return { group, chain, list, index };
      for (const f of list) if (f.dials) { const at = walk(f.dials, [...chain, f]); if (at) return at; }
      return null;
    };
    const at = walk(group.dials, []);
    if (at) return at;
  }
  return null;
}

// A folder exists only while it holds a dial, and one that held only an emptied folder goes with it.
export function prune(list) {
  for (let i = list.length; i--;) if (list[i].dials && !prune(list[i].dials).length) list.splice(i, 1);
  return list;
}

// Whether a group has the address of a dial, or of any dial in a folder, already.
export const hasAddress = (group, item) => {
  const urls = dialsOf(group).map((d) => d.url);
  return (item.dials ? dialsOf(item) : [item]).some((d) => urls.some((u) => sameUrl(u, d.url)));
};

// The ids in the order they sit in, unknown ones dropped.
const inOrder = (state, ids) => ids.map((id) => locate(state, id)).filter(Boolean).sort((a, b) => a.index - b.index);

// Where each item is now, and a copy of it for a deletion to come back from.
function remember(state, kind, places) {
  return {
    kind,
    places: places.map(({ group, chain, list, index }) => ({
      id: list[index].id,
      group: group.id,
      path: chain.map((f, i) => ({ id: f.id, name: f.name, index: (i ? chain[i - 1].dials : group.dials).indexOf(f) })),
      index,
      after: list.slice(0, index).map((d) => d.id), // what was before it: it goes back after the last still there
      copy: structuredClone(list[index]),
    })),
  };
}

export function remove(state, ids) {
  const places = inOrder(state, ids);
  const record = remember(state, 'delete', places);
  for (const at of [...places].reverse()) at.list.splice(at.index, 1);
  return record;
}

// To the end of another group. One whose address that group has already stays where it is: `kept`.
export function moveTo(state, ids, groupId, newGroup = false) {
  const to = state.groups.find((g) => g.id === groupId);
  const places = inOrder(state, ids).filter((at) => to && at.group !== to);
  const kept = places.filter((at) => hasAddress(to, at.list[at.index])).map((at) => at.list[at.index]);
  const going = places.filter((at) => !kept.includes(at.list[at.index]));
  const record = { ...remember(state, 'move', going), ...(newGroup && { newGroup: groupId }) };
  const items = going.map((at) => at.list[at.index]);
  for (const at of [...going].reverse()) at.list.splice(at.index, 1);
  to?.dials.push(...items);
  return { record, moved: items, kept };
}

// Into a folder of the same group, at its end, or (no `folderId`) into `fresh`, a new `{ id, name }`, where the first
// of them was. A folder never goes into itself or one inside it.
export function putInFolder(state, ids, folderId, fresh) {
  const places = inOrder(state, ids);
  if (!places.length) return { record: remember(state, 'move', []), folder: null };
  let folder = folderId && locate(state, folderId)?.list.find((d) => d.id === folderId);
  if (folderId && !folder) return { record: remember(state, 'move', []), folder: null };
  const inside = (at) => folder && (at.list[at.index] === folder || locate(state, folder.id).chain.includes(at.list[at.index]));
  const going = places.filter((at) => !inside(at));
  const record = remember(state, 'move', going);
  const items = going.map((at) => at.list[at.index]);
  const first = going[0];
  if (!folder) {
    folder = { ...fresh, dials: [] };
    first.list.splice(first.index, 0, folder);
  }
  for (const item of items) { const at = locate(state, item.id); at.list.splice(at.index, 1); }
  folder.dials.push(...items);
  return { record, folder };
}

// From a folder to the list around it, just after the folder.
export function takeOutOfFolder(state, ids) {
  const places = inOrder(state, ids).filter((at) => at.chain.length);
  const record = remember(state, 'move', places);
  const folder = places[0]?.chain.at(-1);
  if (!folder) return record;
  const items = places.map((at) => at.list[at.index]);
  for (const at of [...places].reverse()) at.list.splice(at.index, 1);
  const outer = locate(state, folder.id);
  outer.list.splice(outer.index + 1, 0, ...items);
  return record;
}

// Puts back what `record` changed: each item to its place, through folders made again if they have gone meanwhile.
// What another tab or computer changed since is left alone: a moved item deleted there stays deleted, a deleted one
// that is back already isn't added twice, and a group deleted there stays deleted. A new group the move made goes
// again once empty. True if anything changed.
export function undo(state, record) {
  const back = [];
  for (const p of record.places) {
    const now = locate(state, p.id);
    if (record.kind === 'delete' ? now : !now) continue;
    back.push([p, now ? now.list.splice(now.index, 1)[0] : p.copy]);
  }
  // all out first, and the folders that left empty gone, so that each goes back among the same neighbours
  state.groups.forEach((g) => prune(g.dials));
  for (const [p, item] of back.sort(([a], [b]) => a.index - b.index)) {
    const group = state.groups.find((g) => g.id === p.group);
    if (!group) continue;
    let list = group.dials;
    for (const step of p.path) {
      const at = locate(state, step.id);
      let folder = at?.group === group ? at.list[at.index] : null;
      if (!folder) list.splice(Math.min(step.index, list.length), 0, folder = { id: step.id, name: step.name, dials: [] });
      list = folder.dials;
    }
    const before = p.after.findLast((id) => list.some((d) => d.id === id));
    list.splice(before ? list.findIndex((d) => d.id === before) + 1 : 0, 0, item);
  }
  const made = state.groups.find((g) => g.id === record.newGroup);
  const gone = Boolean(made) && !prune(made.dials).length;
  if (gone) state.groups.splice(state.groups.indexOf(made), 1);
  return back.length > 0 || gone;
}
