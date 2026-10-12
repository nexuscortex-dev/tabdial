import { load, targetGroup } from './store.js';
import { readOnly } from './team.js';
import { t } from './i18n.js';

// Toolbar button: asks which group the current page goes to, with the active group marked and under Enter. With only
// one group to pick, it adds at once. The service worker does the adding (background.js), then this popup closes.
const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
const state = await load();
const groups = state.groups.filter((g) => !readOnly(state, g));
function add(groupId) {
  document.body.inert = true; // one click, one dial
  chrome.runtime.sendMessage({ addTab: tab, groupId }).finally(() => window.close());
}

if (!/^https?:/.test(tab?.url)) window.close(); // the browser's own pages can't be dials
else if (groups.length === 1) add(groups[0].id);
else {
  document.querySelector('#title').textContent = t('actionTitle');
  const active = targetGroup(state, state.activeGroup);
  for (const group of groups) {
    const button = document.createElement('button');
    button.textContent = group.name;
    button.addEventListener('click', () => add(group.id));
    document.querySelector('#groups').append(button);
    if (group !== active) continue;
    button.setAttribute('aria-current', 'true');
    button.focus();
  }
}
