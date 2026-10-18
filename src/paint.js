// Puts on the theme, the font and the background picked in Settings before newtab.js has read them (it keeps this copy current),
// so a new tab doesn't show the default ones first. An uploaded picture is too big to copy, so it still comes a moment later.
try {
  const paint = JSON.parse(localStorage.getItem('paint'));
  if (paint?.theme) document.documentElement.dataset.theme = paint.theme;
  if (paint?.font) document.documentElement.style.setProperty('--font', `"${paint.font}"`);
  if (paint && 'image' in paint) {
    Object.assign(document.body.style, { backgroundColor: paint.color, backgroundImage: paint.image });
    document.body.dataset.tone = paint.tone;
  }
} catch {}
