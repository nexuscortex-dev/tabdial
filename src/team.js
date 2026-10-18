// Teams: team groups that every member of a team sees, stored on nexuscortex.dev (tabdial/web/api/teams.js) only
// encrypted, with a key that travels in the invite link's # part and never reaches the site
// (docs/adr/0002-team-groups-stored-encrypted.md). AES-GCM, a 256-bit key, a fresh IV for every write. What is
// encrypted is { v, name, groups }, v being the version that write makes on the site: the site can't pass an older
// payload off as a newer one (opened). A team dial's thumbnail and its site's icon reach the members too ("pictures",
// at the end).
//
// Which teams the user is in follows them through sync storage (`teams`: per team id, its key and this user's
// credential); each computer fetches the team groups itself. They sit in state.groups like the user's own groups,
// marked with `team`, and state.teams[id] holds what this computer knows of the team: { name, version, admin, frozen,
// list }, `list` being the team groups as the site last had them, so an admin's save can tell what changed.
import { uid, normalizeUrl } from './store.js';
import { dialsOf, pick } from './merge.js';
import { fetchInto, isPicture, picturesOf, refs, sendBatches, withPictures } from './sync.js';
import { storedPurchaseId } from './pay.js';
import { t } from './i18n.js';

const API = 'https://nexuscortex.dev/api/tabdial/team';
export const JOIN_PAGE = 'https://nexuscortex.dev/tabdial/join/';
const CHECK_EVERY = 5 * 60e3;
const B64 = { alphabet: 'base64url', omitPadding: true };

// A group only a team's admins can change, while the team isn't frozen. Every way of changing groups or dials asks this.
export const readOnly = (state, group) => Boolean(group?.team) && (!state.teams?.[group.team]?.admin || Boolean(state.teams[group.team].frozen));

// ---------- encryption ----------
const random = () => crypto.getRandomValues(new Uint8Array(32)).toBase64(B64);
const aes = (key) => crypto.subtle.importKey('raw', Uint8Array.fromBase64(key, B64), 'AES-GCM', false, ['encrypt', 'decrypt']);

export async function seal(key, value) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aes(key), new TextEncoder().encode(JSON.stringify(value)));
  const out = new Uint8Array(12 + data.byteLength);
  out.set(iv);
  out.set(new Uint8Array(data), 12);
  return out.toBase64(B64);
}

export async function unseal(key, sealed) {
  const bytes = Uint8Array.fromBase64(sealed, B64);
  return JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.subarray(0, 12) }, await aes(key), bytes.subarray(12))));
}

// What a payload from the site holds, checked to be the version the site says it is and, where this computer has seen
// one, a later version than `after`. Sync between browsers (sync.js) reads its lists with this too.
export async function opened(key, { payload, version }, after = 0) {
  const value = await unseal(key, payload);
  if (value?.v !== version || !(version > after)) throw new TeamError(t('syncUnreadable'), 'bad');
  return value;
}

// ---------- invite links ----------
// https://nexuscortex.dev/tabdial/join/#<team id>.<join secret>.<key>: browsers never send the part after # to the site.
export const inviteLink = (team, secret, key) => `${JOIN_PAGE}#${team}.${secret}.${key}`;

export function parseInvite(text) {
  const m = String(text || '').trim().match(/(?:^|#)([\w-]{22})\.([\w-]{43})\.([\w-]{43})$/);
  return m && { team: m[1], secret: m[2], key: m[3] };
}

// ---------- the site ----------
class TeamError extends Error {
  constructor(message, code, answer = {}) {
    super(message);
    Object.assign(this, { name: 'TeamError', code, answer });
  }
}
const MESSAGES = { gone: 'teamLinkGone', 'not-member': 'teamNotMember', 'not-admin': 'teamNotAdmin', frozen: 'teamFrozen', 'last-admin': 'teamLastAdmin', 'not-paid': 'teamNeedsUnlock', 'no-copy': 'copyGone', none: 'syncCodeUnknown', stopped: 'syncStopped', 'too-long': 'syncTooLong' };

// Also how the user's own list is synced between browsers (sync.js), at `api`.
export async function ask(action, body, api = API) {
  let res;
  try {
    res = await fetch(`${api}/${action}`, { method: 'POST', body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
  } catch {
    throw new TeamError(t('teamUnreachable'), 'offline');
  }
  const answer = await res.json().catch(() => ({}));
  if (!res.ok) throw new TeamError(MESSAGES[answer.code] ? t(MESSAGES[answer.code]) : answer.error || t('teamServiceError', res.status), answer.code, answer);
  return answer;
}

export const memberships = async () => (await chrome.storage.sync.get('teams')).teams || {};
async function setMembership(id, member) {
  const teams = await memberships();
  if (!member && !teams[id]) return;
  if (member) teams[id] = member; else delete teams[id];
  await chrome.storage.sync.set({ teams });
}
async function credentials(id) {
  const member = (await memberships())[id];
  if (!member) throw new TeamError(t('teamNotMember'), 'not-member');
  return member;
}

// ---------- the team in the state ----------
const groupsOf = (state, id) => state.groups.filter((g) => g.team === id);

// The team's groups as the site keeps them: a dial's thumbnail and icon are named (`pic`, `ico`: sync.js refs), the
// pictures themselves go apart.
export async function teamGroups(state, id, key) {
  const item = async (d) => {
    if (d.dials) return { id: d.id, name: d.name, dials: await Promise.all(d.dials.map(item)) };
    const [pic, ico] = await refs(d, key);
    return { id: d.id, url: d.url, title: d.title, ...(pic && { pic }), ...(ico && { ico }) };
  };
  return Promise.all(groupsOf(state, id).map(item));
}

// Put the team as the site has it into the state. Team groups the member already has stay where they placed them,
// new ones go after all the other groups, and ones the admins deleted go. A dial shows the pictures the team names
// for it: those this computer already has are put in, the rest stay named until they are fetched (fetchTeamPictures).
export async function applyTeam(state, id, key, { name, groups }, version) {
  const have = await picturesOf(groupsOf(state, id), key);
  const named = (v) => typeof v === 'string' && v;
  const dial = (d) => {
    const out = { id: String(d.id), url: normalizeUrl(d.url), title: String(d.title || ''), image: '', ...(named(d.pic) && { pic: d.pic }), ...(named(d.ico) && { ico: d.ico }) };
    withPictures(out, have);
    return out;
  };
  const item = (d) => (Array.isArray(d.dials) ? { id: String(d.id), name: String(d.name || ''), dials: d.dials.map(item) } : dial(d));
  const fresh = (g) => ({ id: String(g.id), name: String(g.name), team: id, dials: pick(g.dials.map(item), (d) => d.url) });
  const byId = new Map(groups.map((g) => [String(g.id), fresh(g)]));
  state.groups = state.groups.filter((g) => g.team !== id || byId.has(g.id)).map((g) => (g.team === id ? byId.get(g.id) : g));
  for (const g of byId.values()) if (!state.groups.includes(g)) state.groups.push(g);
  state.teams[id] = { ...state.teams[id], name: String(name), version, list: JSON.stringify(await teamGroups(state, id, key)) };
  if (!state.groups.some((g) => g.id === state.activeGroup)) state.activeGroup = state.groups[0].id;
}

// Takes the team off this computer: its groups go, dials copied from it stay.
export async function dropTeam(state, id) {
  state.groups = state.groups.filter((g) => g.team !== id);
  delete state.teams[id];
  if (!state.groups.some((g) => g.id === state.activeGroup)) state.activeGroup = state.groups[0].id;
  await setMembership(id, null);
  await want(id, []);
}

const differs = async (state, id, key) => JSON.stringify(await teamGroups(state, id, key)) !== state.teams[id].list;
const pending = (state, id, key) => !readOnly(state, { team: id }) && differs(state, id, key);

// ---------- keeping up to date ----------
// Called when a new tab opens: at most every 5 minutes per computer, each team is asked whether it changed; a team
// joined on another computer (it arrives through sync) is fetched at once, and one left there goes. An admin's change
// that couldn't be sent yet is sent instead. Offline, the team groups stay as they last were. Returns whether the
// state changed; the caller saves.
export async function refreshTeams(state) {
  const mine = await memberships();
  if (!Object.keys(mine).length && !Object.keys(state.teams).length) return false;
  const known = async () => JSON.stringify([state.teams, await Promise.all(Object.keys(state.teams).map((id) => mine[id] && teamGroups(state, id, mine[id].key)))]);
  const before = await known();
  for (const id of Object.keys(state.teams)) if (!mine[id]) await dropTeam(state, id);
  const { teamsCheckedAt = 0 } = await chrome.storage.local.get('teamsCheckedAt');
  const due = Date.now() - teamsCheckedAt >= CHECK_EVERY;
  if (due) await chrome.storage.local.set({ teamsCheckedAt: Date.now() });
  for (const id of Object.keys(mine).filter((id) => due || !state.teams[id])) {
    try {
      if (state.teams[id] && await pending(state, id, mine[id].key)) await publish(state, id);
      else await check(state, id, mine[id]);
    } catch {} // offline, the site is down, or it said why (and the state shows it): as it last was
  }
  return await known() !== before;
}

async function check(state, id, { credential, key }) {
  const answer = await ask('check', { team: id, credential, version: state.teams[id]?.version || 0 }).catch(async (err) => {
    if (err.code === 'not-member') await dropTeam(state, id); // removed, or the team was deleted
    throw err;
  });
  const team = answer.payload && await opened(key, answer, state.teams[id]?.version);
  state.teams[id] = { ...state.teams[id], admin: answer.admin, frozen: answer.frozen };
  if (team) await applyTeam(state, id, key, team, answer.version);
  // Someone who can't change the team (any more) sees it as the site has it, whatever a page did meanwhile.
  else if (readOnly(state, { team: id }) && await differs(state, id, key)) {
    await applyTeam(state, id, key, { name: state.teams[id].name, groups: JSON.parse(state.teams[id].list) }, state.teams[id].version);
  }
}

// store.js save(): sends what an admin changed in each team, based on the version it was changed from, and returns the
// problems to show. Another admin's save in between, a refund or a lost admin role puts the site's version back.
export async function publishTeams(state) {
  const problems = [];
  const ids = Object.keys(state.teams || {});
  const mine = ids.length ? await memberships() : {};
  for (const id of ids) {
    if (mine[id] && await pending(state, id, mine[id].key)) await publish(state, id).catch((err) => problems.push(err));
  }
  return problems;
}

async function publish(state, id) {
  const team = state.teams[id];
  const { credential, key } = await credentials(id);
  const groups = await teamGroups(state, id, key);
  const pictures = [...new Set(groups.flatMap(dialsOf).flatMap((d) => [d.pic, d.ico]).filter(isPicture))];
  try {
    const { version, missing = [] } = await ask('save', { team: id, credential, version: team.version, payload: await seal(key, { v: team.version + 1, name: team.name, groups }), pictures });
    Object.assign(team, { version, list: JSON.stringify(groups) });
    if (missing.length) await want(id, [...(await wanted())[id] || [], ...missing]);
  } catch (err) {
    if (err.code === 'conflict') {
      await applyTeam(state, id, key, await opened(key, err.answer, team.version), err.answer.version);
      throw new TeamError(t('teamConflict', team.name), err.code);
    }
    if (err.code === 'not-member') await dropTeam(state, id);
    if (err.code === 'frozen' || err.code === 'not-admin') {
      Object.assign(team, err.code === 'frozen' ? { frozen: true } : { admin: false });
      await applyTeam(state, id, key, { name: team.name, groups: JSON.parse(team.list) }, team.version);
    }
    throw err; // offline: the change is sent with the next save
  }
}

// ---------- what Settings does ----------
// Paid: a new team with one empty team group named like it. Returns that group.
export async function createTeam(state, name, memberName) {
  const [key, joinSecret, credential] = [random(), random(), random()];
  const groups = [{ id: uid(), name, dials: [] }];
  const { team, version } = await ask('create', {
    purchase: await storedPurchaseId(), payload: await seal(key, { v: 1, name, groups }), joinSecret, credential,
    name: await seal(key, memberName), link: await seal(key, joinSecret),
  });
  state.teams[team] = { admin: true, frozen: false };
  await applyTeam(state, team, key, { name, groups }, version);
  await setMembership(team, { key, credential });
  return state.groups.find((g) => g.team === team);
}

// The team behind an invite link, named, before joining it.
export async function peekTeam(link) {
  const invite = parseInvite(link);
  if (!invite) throw new TeamError(t('teamLinkInvalid'), 'bad');
  const answer = await ask('join', { team: invite.team, joinSecret: invite.secret });
  return { ...invite, name: (await opened(invite.key, answer)).name, joined: Boolean((await memberships())[invite.team]) };
}

// Free, no account: the team knows the member by the name they give.
export async function joinTeam(state, { team, secret, key }, memberName) {
  const credential = (await memberships())[team]?.credential || random();
  const answer = await ask('join', { team, joinSecret: secret, credential, name: await seal(key, memberName) });
  state.teams[team] = { ...state.teams[team], admin: answer.admin, frozen: false };
  await applyTeam(state, team, key, await opened(key, answer), answer.version);
  await setMembership(team, { key, credential });
}

// A team action that finds the user is no longer in the team takes the team off this computer.
async function act(state, id, action, body = {}) {
  const { credential, key } = await credentials(id);
  try {
    return { key, answer: await ask(action, { team: id, credential, ...body }) };
  } catch (err) {
    if (err.code === 'not-member') await dropTeam(state, id);
    throw err;
  }
}

export async function leaveTeam(state, id) {
  await act(state, id, 'leave').catch((err) => { if (err.code !== 'not-member') throw err; });
  await dropTeam(state, id);
}

export async function deleteTeam(state, id) {
  await act(state, id, 'delete');
  await dropTeam(state, id);
}

// Admins: the invite link and the members, oldest first, with the names they gave.
export async function listMembers(state, id) {
  const { key, answer } = await act(state, id, 'members');
  const members = await Promise.all(answer.members.map(async (m) => ({ ...m, name: await unseal(key, m.name).catch(() => '?') })));
  return { link: inviteLink(id, await unseal(key, answer.link), key), members };
}

async function newLink(id) {
  const { key } = await credentials(id);
  const joinSecret = random();
  return { joinSecret, link: await seal(key, joinSecret), url: inviteLink(id, joinSecret, key) };
}

// Removing a member also replaces the invite link, so they can't come back with the old one. Returns the new link.
export async function removeMember(state, id, member) {
  const { joinSecret, link, url } = await newLink(id);
  await act(state, id, 'remove', { member, joinSecret, link });
  return url;
}

export async function replaceLink(state, id) {
  const { joinSecret, link, url } = await newLink(id);
  await act(state, id, 'link', { joinSecret, link });
  return url;
}

export async function setAdmin(state, id, member, admin) {
  await act(state, id, 'admin', { member, admin });
}

export const listCopies = async (state, id) => (await act(state, id, 'copies')).answer.copies;

// The copy becomes this admin's change, and the save that follows publishes it like any other: its ciphertext says
// which version it was, so the site can't make it the current one by itself. Every member then gets it on their next
// check.
export async function restoreCopy(state, id, day) {
  if (state.teams[id]?.frozen) throw new TeamError(t('teamFrozen'), 'frozen');
  const { key, answer } = await act(state, id, 'copy', { day });
  const { version, list } = state.teams[id];
  await applyTeam(state, id, key, await unseal(key, answer.payload), version);
  state.teams[id].list = list; // what the site has: the copy differs from it, so it is published
}

// ---------- pictures ----------
// A team dial's thumbnail and its site's icon go to the members as they go between a user's browsers with a sync code
// (sync.js, "pictures"): each kept by the site on its own, encrypted with the team's key, under an id the team's groups
// name. An admin's save is told which the site lacks (`teamWanted` in local storage, per team) and they are sent after
// it; everyone fetches the ones their dials name. So what an admin's thumbnail shows, every member sees.
const wanted = async () => (await chrome.storage.local.get('teamWanted')).teamWanted || {};
async function want(id, ids) {
  const teamWanted = await wanted();
  if (!ids.length && !teamWanted[id]) return;
  if (ids.length) teamWanted[id] = [...new Set(ids)]; else delete teamWanted[id];
  await chrome.storage.local.set({ teamWanted });
}

// After a save (store.js), not in its queue, and with a new tab (newtab.js). What couldn't go stays wanted, for the
// next of either.
let sending = null;
export function sendTeamPictures(state) {
  return sending ??= (async () => {
    for (const [id, ids] of Object.entries(await wanted())) {
      const { credential, key } = (await memberships())[id] || {};
      if (!key || readOnly(state, { team: id })) await want(id, []);
      else await sendBatches(key, await picturesOf(groupsOf(state, id), key), ids, (pictures) => ask('put', { team: id, credential, pictures }), (left) => want(id, left));
    }
  })().finally(() => { sending = null; });
}

// Fetch the pictures the team dials name that this computer lacks. Returns whether any came; the caller saves. One
// the site doesn't have yet (the admin's browser is still sending it) is asked for again with the next new tab.
export async function fetchTeamPictures(state) {
  let got = false;
  for (const id of Object.keys(state.teams)) {
    const waiting = groupsOf(state, id).flatMap(dialsOf).filter((d) => d.pic || d.ico);
    const { credential, key } = waiting.length && (await memberships())[id] || {};
    if (key && await fetchInto(waiting, key, (ids) => ask('get', { team: id, credential, ids })).catch(() => false)) got = true;
  }
  return got;
}
