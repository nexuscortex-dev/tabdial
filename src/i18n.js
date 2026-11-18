// Interface text in the browser's language, from _locales/<lang>/messages.json (English where a language has none).
// Messages take substitutions as $1, $2…; a literal $ is written $$.
export const t = (key, ...subs) => chrome.i18n.getMessage(key, subs.map(String));

export const uiLanguage = () => chrome.i18n.getUILanguage();

// "1 dial", "5 dials": the message <key>_<category> for the language's plural rule (Intl.PluralRules), with the number
// as $1. Every language has <key>_one and <key>_other; a language with more forms (Russian's "few", Arabic's "two"…)
// adds those it needs, and any category it has no message for takes <key>_other.
export function plural(n, key) {
  const category = new Intl.PluralRules(uiLanguage()).select(n);
  return (category === 'one' ? '' : t(`${key}_${category}`, n)) || t(`${key}_${category === 'one' ? 'one' : 'other'}`, n);
}

// The page's direction, from the language whose messages are shown: rtl for Arabic, ltr for the rest (and for a
// right-to-left browser language Tabdial has no messages in, since the text is then English).
export const direction = () => t('textDirection') || 'ltr';
