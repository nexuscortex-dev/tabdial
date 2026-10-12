// Interface text in the browser's language, from _locales/<lang>/messages.json (English where a language has none).
// Messages take substitutions as $1, $2…; a literal $ is written $$.
export const t = (key, ...subs) => chrome.i18n.getMessage(key, subs.map(String));

export const uiLanguage = () => chrome.i18n.getUILanguage();

// "1 dial", "5 dials": the message <key>_one or <key>_other, chosen by the language's plural rule, with the number as $1.
export function plural(n, key) {
  return t(`${key}_${new Intl.PluralRules(uiLanguage()).select(n) === 'one' ? 'one' : 'other'}`, n);
}
