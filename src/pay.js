// The one-time unlock, sold through Stripe Managed Payments (the merchant of record: it handles tax, receipts and
// disputes). Stripe's API needs a secret key, so Tabdial talks to its own site instead (tabdial/web/api/purchases.js in
// this repo), which links a random purchase id to the Stripe payment. The id lives in sync storage, so a purchase follows
// the user to their other computers through Chrome sync; other browsers unlock by signing in with the Google account the
// buyer backs up to, or with the license key the thank-you page shows after payment.
import { t } from './i18n.js';

const API = 'https://nexuscortex.dev/api/tabdial';
const KEY = 'purchaseId';

export const storedPurchaseId = async () => (await chrome.storage.sync.get(KEY))[KEY] || null;

async function purchaseId() {
  const id = await storedPurchaseId();
  if (id) return id;
  const created = crypto.randomUUID();
  await chrome.storage.sync.set({ [KEY]: created });
  return created;
}

async function answer(res) {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || t('paymentServiceError', res.status));
  return body;
}

// Asks whether this purchase id has been paid for and remembers the answer (read with isPaid) for offline use.
// Without an id the user has never opened the payment page or entered a key, so there is nothing to ask.
export async function checkPaid() {
  const id = await storedPurchaseId();
  if (!id) return false;
  const paid = Boolean((await answer(await fetch(`${API}/paid?id=${id}`))).paid);
  await chrome.storage.local.set({ paid });
  return paid;
}

// A refund ends the unlock everywhere, so a paid browser asks again once a day (the first new tab of the day does).
export async function recheckPaid() {
  const { paid, paidCheckedAt = 0 } = await chrome.storage.local.get(['paid', 'paidCheckedAt']);
  if (!paid || Date.now() - paidCheckedAt < 864e5) return;
  await chrome.storage.local.set({ paidCheckedAt: Date.now() }); // first: one try a day, even when offline
  await checkPaid().catch(() => {});
}

export const isPaid = async () => Boolean((await chrome.storage.local.get('paid')).paid);
export const hasAskedToPay = async () => Boolean(await storedPurchaseId());

// Sort (sort.js): the site checks that this id is paid, then asks Jev. Plain text, not JSON, so no CORS preflight.
export async function askSort(request) {
  return answer(await fetch(`${API}/sort`, { method: 'POST', body: JSON.stringify({ id: await storedPurchaseId(), ...request }) }));
}

export async function openPaymentPage() {
  await chrome.tabs.create({ url: `${API}/buy?id=${await purchaseId()}` });
}

// Called with a Google sign-in (drive.js): the site remembers that this account paid, or, if it did, unlocks this
// browser. Returns whether this browser is paid now.
export async function linkGoogleAccount(idToken) {
  const body = new URLSearchParams({ id: await purchaseId(), idToken });
  const { paid } = await answer(await fetch(`${API}/account`, { method: 'POST', body }));
  if (paid) await chrome.storage.local.set({ paid: true });
  return Boolean(paid);
}

// For a browser the purchase didn't reach through Chrome sync (Edge, or sync off): the key from the thank-you page.
export async function unlockWithKey(key) {
  const body = new URLSearchParams({ id: await purchaseId(), key: key.trim() });
  await answer(await fetch(`${API}/license`, { method: 'POST', body }));
  await chrome.storage.local.set({ paid: true });
}
