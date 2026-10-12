// Puts on the background picked in Settings before newtab.js has read them (it keeps this copy current), so a new tab
// doesn't show the default background first. An uploaded picture is too big to copy, so it still comes a moment later.
try {
  const paint = JSON.parse(localStorage.getItem('paint'));
  if (paint) {
    Object.assign(document.body.style, { backgroundColor: paint.color, backgroundImage: paint.image });
    document.body.dataset.tone = paint.tone;
  }
} catch {}
