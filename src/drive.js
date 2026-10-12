// Once a day, everything (dials, thumbnails, settings) goes to one file in the user's own Google Drive, so
// a new computer or a reinstall gets it all back in one click. Google keeps the file's earlier versions for about 30
// days. The drive.file scope only reaches files Tabdial itself created.
// Sign-in is launchWebAuthFlow on Chrome and Edge alike (Edge has no getAuthToken). The daily run renews the token
// without a window (prompt=none); if Google wants the user again, Settings asks them to reconnect.
import { exportState, historyOn } from './import.js';
import { isPaid, linkGoogleAccount } from './pay.js';
import { t } from './i18n.js';

// OAuth client ("Web application") from Google Cloud, with https://<extension id>.chromiumapp.org/ as redirect URIs.
// `npm run zip` refuses to package while CLIENT_ID is still the placeholder from package.json's check.
const CLIENT_ID = '758934795867-9ne6eu1dpafj6sp82r0g40och19b8k1j.apps.googleusercontent.com';
// openid adds an ID token: from a browser with the unlock, it tells nexuscortex.dev which Google account paid, without
// access to the user's Drive.
const SCOPE = 'openid https://www.googleapis.com/auth/drive.file';
const FILE_NAME = 'Tabdial backup.json';
const API = 'https://www.googleapis.com';
const JSON_TYPE = { 'Content-Type': 'application/json; charset=UTF-8' };
const DAY = 864e5;
export const signInNeeded = () => t('driveSignInAgain');
// Firefox can't make identity optional, so its build asks for it at install (package.json `zip:firefox`).
export const identity = () => (chrome.runtime.getManifest().optional_permissions?.includes('identity') ? ['identity'] : []);

export const getDrive = async () => (await chrome.storage.local.get('drive')).drive || null;
const updateDrive = async (changes) => chrome.storage.local.set({ drive: { ...await getDrive(), ...changes } });

function ok(res) {
  if (!res.ok) throw new Error(t('driveAnswered', res.status));
  return res;
}

async function signIn(interactive, account) {
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.search = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: 'token id_token',
    nonce: crypto.randomUUID(), // Google requires one with an ID token
    redirect_uri: chrome.identity.getRedirectURL(),
    scope: SCOPE,
    prompt: interactive ? 'select_account' : 'none',
    ...(account && { login_hint: account }),
  });
  let back = '';
  try {
    back = await chrome.identity.launchWebAuthFlow({
      url: url.href,
      interactive,
      // Google's no-prompt page redirects from a script after it loads; wait for that instead of stopping at load.
      // Not on Firefox: it takes only url and interactive, and any other option is an error.
      ...(globalThis.location?.protocol !== 'moz-extension:' && { abortOnLoadForNonInteractive: false, timeoutMsForNonInteractive: 15_000 }),
    });
  } catch (err) {
    // Without a window this is mostly no network yet (e.g. just woken from sleep), so the next hour tries again.
    // Only Google's own answer below (#error=…) means the user has to sign in again.
    if (!interactive) throw new Error(t('googleUnreachable', err.message));
    throw new Error(t('signInUnfinished', err.message));
  }
  const params = new URLSearchParams(new URL(back).hash.slice(1));
  const token = params.get('access_token');
  if (!token) throw new Error(interactive ? t('signInFailed', params.get('error') || t('noAccess')) : signInNeeded());
  const expiresAt = Date.now() + (Number(params.get('expires_in')) - 60) * 1000;
  await chrome.storage.session.set({ driveToken: { token, expiresAt } });
  const idToken = params.get('id_token');
  // A browser with the unlock tells nexuscortex.dev which Google account it backs up to: that is how the buyer's
  // other browsers unlock ("I already paid"). Without the unlock, a sign-in goes to Google alone.
  if (await isPaid()) await linkGoogleAccount(idToken).catch(() => {}); // the next sign-in tells it again
  return { token, idToken };
}

async function accessToken(interactive) {
  const { driveToken } = await chrome.storage.session.get('driveToken');
  if (driveToken?.expiresAt > Date.now()) return driveToken.token;
  const account = (await getDrive())?.account;
  try {
    return (await signIn(false, account)).token;
  } catch (err) {
    if (!interactive) throw err;
    return (await signIn(true, account)).token;
  }
}

// A Drive request with a token; a token Google no longer accepts is renewed once.
async function driveFetch(url, init = {}, interactive = false) {
  for (let retry = true; ; retry = false) {
    const res = await fetch(url, { ...init, headers: { ...init.headers, Authorization: `Bearer ${await accessToken(interactive)}` } });
    if (res.status !== 401 || !retry) return res;
    await chrome.storage.session.remove('driveToken');
  }
}

// By name, not by the id this computer knows: the file may have been made on another computer.
async function findBackup(interactive) {
  const q = encodeURIComponent(`name='${FILE_NAME}' and trashed=false`);
  const res = ok(await driveFetch(`${API}/drive/v3/files?q=${q}&orderBy=modifiedTime%20desc&pageSize=1&fields=files(id,modifiedTime)`, {}, interactive));
  return (await res.json()).files[0] || null;
}

// Call right after the identity permission was granted. With `unlock` ("I already paid"), it is also how another
// browser unlocks: signing in with the Google account that paid; an account that didn't changes nothing here. A backup
// already in Drive (from another computer or an earlier install) is not replaced until the user restores it or presses
// "Back up now" (`found` holds it until then).
export async function connectDrive(unlock = false) {
  const before = await getDrive(); // set when reconnecting: the file this computer already writes is not "from elsewhere"
  await chrome.storage.session.remove('driveToken');
  const { idToken } = await signIn(true);
  if (unlock && !(await isPaid())) {
    try {
      if (!(await linkGoogleAccount(idToken))) throw new Error(t('accountNotPaid'));
    } catch (err) {
      // The Drive this browser already backs up to, if any, stays as it was
      await (before ? chrome.storage.session.remove('driveToken') : disconnectDrive());
      throw err;
    }
  }
  const about = ok(await driveFetch(`${API}/drive/v3/about?fields=user(emailAddress)`));
  const account = (await about.json()).user.emailAddress;
  const found = await findBackup();
  const fromElsewhere = found && (found.id !== before?.fileId || Boolean(before?.found));
  await chrome.storage.local.set({ drive: {
    account, fileId: found?.id || '', found: fromElsewhere ? found.modifiedTime : '', lastAt: before?.lastAt || 0, rev: before?.rev, error: '',
  } });
  await scheduleDrive();
  if (!found) await backUpToDrive(true);
}

// Replace the backup file with everything stored now. A resumable upload, because thumbnails and a background image
// can pass the 5 MB limit of a simple one.
export async function backUpToDrive(interactive = false) {
  const { drive, tabdial } = await chrome.storage.local.get(['drive', 'tabdial']);
  if (!drive) throw new Error(t('driveNotConnected'));
  if (!tabdial) return; // nothing saved yet
  try {
    let res = drive.fileId && await driveFetch(`${API}/upload/drive/v3/files/${drive.fileId}?uploadType=resumable`,
      { method: 'PATCH', headers: JSON_TYPE, body: '{}' }, interactive);
    if (!res || res.status === 404) { // the first backup, or the user deleted the file
      res = await driveFetch(`${API}/upload/drive/v3/files?uploadType=resumable`,
        { method: 'POST', headers: JSON_TYPE, body: JSON.stringify({ name: FILE_NAME, mimeType: 'application/json' }) }, interactive);
    }
    const upload = ok(res).headers.get('Location');
    const file = await ok(await driveFetch(upload, { method: 'PUT', body: exportState(tabdial, await historyOn()) }, interactive)).json();
    await updateDrive({ fileId: file.id, lastAt: Date.now(), rev: tabdial.rev, found: '', error: '' });
  } catch (err) {
    await updateDrive({ error: err.message });
    throw err;
  }
}

// The hourly alarm: back up once a day, and only if something changed. It waits while the user has a backup from
// elsewhere to decide on, or Google said they must sign in again (so a hidden sign-in isn't retried every hour).
export async function backUpIfDue() {
  const [drive, { tabdial }] = [await getDrive(), await chrome.storage.local.get('tabdial')];
  if (!drive || drive.found || drive.error === signInNeeded()) return;
  if (Date.now() - drive.lastAt < DAY || drive.rev === tabdial?.rev) return;
  await backUpToDrive();
}

// The Drive backup as text in Tabdial's export format; the page merges it in.
export async function readDriveBackup() {
  const file = await findBackup(true);
  if (!file) throw new Error(t('noDriveBackup'));
  await updateDrive({ fileId: file.id });
  return (await ok(await driveFetch(`${API}/drive/v3/files/${file.id}?alt=media`, {}, true))).text();
}

// The backup file stays in the user's Drive; they can remove Tabdial's access in their Google Account.
export async function disconnectDrive() {
  await chrome.storage.session.remove('driveToken');
  await chrome.storage.local.remove('drive');
  await chrome.alarms.clear('drive');
  await chrome.permissions.remove({ permissions: identity() });
}

// Alarms may not survive a browser restart, so the service worker also calls this on startup.
export async function scheduleDrive() {
  if (await getDrive()) await chrome.alarms.create('drive', { delayInMinutes: 1, periodInMinutes: 60 });
}
