// The page background.js opens once, when Tabdial is installed. On the first new tab after that, Chrome, Edge and
// Firefox each ask whether to change the new tab page back, and changing it back turns Tabdial off: the page says so
// before that question comes, and in Firefox also how to let Tabdial run in private windows.
import { t, uiLanguage } from './i18n.js';

document.documentElement.lang = uiLanguage();
document.title = t('installedTitle');
for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
document.querySelector('#installed-text').textContent = t('installedText', /Mac/.test(navigator.platform) ? '⌘T' : 'Ctrl+T');
document.querySelector('#private').hidden = !chrome.runtime.getURL('').startsWith('moz-extension:');
document.querySelector('#open').addEventListener('click', () => chrome.tabs.create({}));
