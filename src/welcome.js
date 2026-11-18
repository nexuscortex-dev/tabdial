// The page background.js opens once, when Tabdial is installed. On the first new tab after that, Chrome, Edge and
// Firefox each ask whether to change the new tab page back, and changing it back turns Tabdial off: the page says so
// before that question comes, and in Firefox also how to let Tabdial run in private windows.
import { t, uiLanguage, direction } from './i18n.js';

document.documentElement.lang = uiLanguage();
document.documentElement.dir = direction();
document.title = t('installedTitle');
for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
// The shortcut isolated from the text around it (U+2068…U+2069), so a right-to-left language keeps it ⌘T, not T⌘.
const shortcut = /Mac/.test(navigator.platform) ? '⌘T' : 'Ctrl+T';
document.querySelector('#installed-text').textContent = t('installedText', `\u2068${shortcut}\u2069`);
document.querySelector('#private').hidden = !chrome.runtime.getURL('').startsWith('moz-extension:');
document.querySelector('#open').addEventListener('click', () => chrome.tabs.create({}));
