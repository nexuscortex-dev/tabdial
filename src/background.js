import { load, save, addDial, shortTitle, targetGroup } from './store.js';
import { parseInvite } from './team.js';
import { parseCode } from './sync.js';
import { dialsOf, sameUrl } from './merge.js';
import { backUpIfDue, scheduleDrive } from './drive.js';
import { jumpList, matching, jump, open } from './jump.js';
import { t } from './i18n.js';

// Toolbar button: add the current page to the group picked in its popup (popup.js), with a screenshot of it as the
// thumbnail. A page the group already has, in a folder too, gets a fresh screenshot instead of a second dial.
async function addTab(tab, groupId) {
  if (!tab.url || !/^https?:/.test(tab.url)) return;
  const image = await capture(tab).catch(() => '');
  const state = await load();
  const group = targetGroup(state, groupId ?? state.activeGroup);
  const known = dialsOf(group).find((d) => sameUrl(d.url, tab.url));
  if (!known) addDial(state, group.id, { url: tab.url, title: shortTitle(tab.title), image });
  else if (image) {
    known.image = image;
    delete known.pic; // the picture a synced list or a team still named for it (sync.js)
  }
  await save(state);
  chrome.action.setBadgeText({ tabId: tab.id, text: '✓' }).catch(() => {});
  // Not chrome.alarms: they can't fire sooner than 30 s. If the worker stops first, the ✓ just stays on that tab.
  setTimeout(() => chrome.action.setBadgeText({ tabId: tab.id, text: '' }).catch(() => {}), 1500);
}

// activeTab lets us screenshot the visible tab; shrink it so storage stays small.
async function capture(tab) {
  const shot = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 80 });
  const bitmap = await createImageBitmap(await (await fetch(shot)).blob());
  const width = 640;
  const height = Math.round(width * 10 / 16);
  const canvas = new OffscreenCanvas(width, height);
  // Crop to the top 16:10 of the page, scaled to the tile size.
  const srcH = Math.min(bitmap.height, Math.round(bitmap.width * 10 / 16));
  canvas.getContext('2d').drawImage(bitmap, 0, 0, bitmap.width, srcH, 0, 0, width, height);
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.8 });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:image/jpeg;base64,${btoa(bin)}`;
}

// Remember when Tabdial arrived (existing installs count from this update) for the one-time rating prompt,
// and point uninstalls at a short, optional feedback page. Chrome keeps the uninstall URL across restarts.
chrome.runtime.onInstalled.addListener(async () => {
  try {
    const { installedAt } = await chrome.storage.local.get('installedAt');
    if (!installedAt) await chrome.storage.local.set({ installedAt: Date.now() });
    await chrome.runtime.setUninstallURL(`https://nexuscortex.dev/tabdial/bye/?v=${chrome.runtime.getManifest().version}`);
  } catch (err) {
    console.error('Tabdial setup failed', err);
  }
});

// The daily Google Drive backup (drive.js). The alarm only exists while Drive is connected.
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'drive') backUpIfDue().catch((err) => console.error('Drive backup failed', err));
});
chrome.runtime.onStartup.addListener(() => scheduleDrive().catch(() => {}));

// Jump (jump.js): the address bar's suggestions for `z …`. The best match is the default one (Enter), then the next
// ones. Until the user allows the browsing history, the last row offers it, unless they once said no: picking it opens
// Settings with what was typed. Chrome shows at most 8 rows, the default one included, and reads the descriptions as
// XML; Firefox shows them as plain text.
const xml = (s) => (location.protocol === 'moz-extension:' ? s
  : s.replace(/[&<>"']/g, (c) => `&${{ '&': 'amp', '<': 'lt', '>': 'gt', '"': 'quot', "'": 'apos' }[c]};`));
const describe = ({ url, title }) => (location.protocol === 'moz-extension:' ? [title, url].filter(Boolean).join(' – ')
  : `${title ? `${xml(title)} <dim>–</dim> ` : ''}<url>${xml(url)}</url>`);
let session; // the dials and the history, read once per address bar session
let typed = ''; // picking the history row puts its own text in place of what was typed
const jumpData = () => (session ??= load().then(jumpList));

chrome.omnibox.onInputStarted.addListener(() => {
  session = null;
  chrome.omnibox.setDefaultSuggestion({ description: xml(t('jumpType')) });
});
chrome.omnibox.onInputChanged.addListener(async (text, suggest) => {
  if (text === t('jumpHistory')) return;
  typed = text;
  const { allowed, list } = await jumpData();
  const [top, ...more] = matching(list, text);
  const offer = !allowed && !(await chrome.storage.local.get('historyDeclined')).historyDeclined;
  chrome.omnibox.setDefaultSuggestion({ description: top ? describe(top) : xml(t(text.trim() ? 'jumpSearch' : 'jumpType', text)) });
  const rows = more.slice(0, offer ? 6 : 7).map((c) => ({ content: c.url, description: describe(c) }));
  if (offer) rows.push({ content: t('jumpHistory'), description: xml(t('jumpHistory')) });
  suggest(rows);
});
chrome.omnibox.onInputEntered.addListener(async (text, disposition) => {
  await chrome.storage.local.set({ jumpHintDone: true }); // no need for the new tab page's tip about Jump anymore
  if (text === t('jumpHistory')) await open(`${chrome.runtime.getURL('newtab.html')}?jump=${encodeURIComponent(typed)}`, disposition);
  else await jump((await jumpData()).list, text, disposition);
});

// Teams: the join page on nexuscortex.dev (manifest: externally_connectable; Chrome and Edge only) hands over an invite
// link. Its tab turns into the new tab page, which names the team and asks before joining. Sync between browsers: the
// same page hands over a link with a sync code, and the new tab page asks before using it.
chrome.runtime.onMessageExternal?.addListener((message, sender, respond) => {
  if (sender.origin !== 'https://nexuscortex.dev' || !sender.tab || !(parseInvite(message?.join) || parseCode(message?.join))) return;
  chrome.tabs.update(sender.tab.id, { url: `${chrome.runtime.getURL('newtab.html')}#join=${encodeURIComponent(message.join)}` });
  respond({ ok: true });
});

chrome.runtime.onMessage.addListener(({ addTab: tab, groupId }, sender, respond) => {
  if (!tab) return;
  addTab(tab, groupId).catch((err) => {
    console.error('Adding the page failed', err);
    chrome.action.setBadgeText({ tabId: tab.id, text: '!' }).catch(() => {});
  }).then(respond);
  return true; // the popup waits for the answer before it closes
});
// Unpacked builds only (store installs get an update_url): lets the e2e test drive the toolbar path.
if (!chrome.runtime.getManifest().update_url) globalThis.addTab = addTab;
