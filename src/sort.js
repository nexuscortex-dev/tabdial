// Sort (paid): which of the user's other groups each dial of a group fits, asked of nexuscortex.dev
// (tabdial/web/api/sort.js), which asks Jev. Only hostnames, titles and group names leave the browser, and only when
// the user clicks Continue; why at all: docs/adr/0001-sort-sends-sites-to-jev.md. Team groups are never sorted or
// sorted into, so their addresses never leave the browser this way (docs/adr/0002-team-groups-stored-encrypted.md).
import { hostOf, ownGroups } from './merge.js';
import { askSort } from './pay.js';

const EXAMPLES = 5; // hostnames per other group, to tell Jev what a group like "Home" holds

// The dials Sort looks at: not the ones in folders, which stay where the user put them and never leave the browser.
export const loose = (group) => group.dials.filter((d) => !d.dials);

// Returns [{ dial, to }] for the loose dials of groupId that fit another group better. Changes nothing.
export async function suggestMoves(state, groupId) {
  const others = ownGroups(state.groups).filter((g) => g.id !== groupId);
  const dials = loose(ownGroups(state.groups).find((g) => g.id === groupId));
  const { moves } = await askSort({
    groups: others.map((g) => ({ name: g.name, examples: loose(g).slice(0, EXAMPLES).map((d) => hostOf(d.url)) })),
    dials: dials.map((d) => ({ host: hostOf(d.url), title: d.title })),
  });
  return moves.map((m) => ({ dial: dials[m.dial], to: others[m.group] })).filter((m) => m.dial && m.to);
}
