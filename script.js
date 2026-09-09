const wordmark = document.querySelector("[data-wordmark]");
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

if (wordmark && !reducedMotion.matches) {
  const word = wordmark.dataset.wordmark;
  const glyphs = "01<>/[]{}*+-=░▒▓";

  const randomGlyph = () => glyphs[Math.floor(Math.random() * glyphs.length)];

  const scramble = () => {
    const startedAt = performance.now();
    const duration = 850;

    const renderFrame = (now) => {
      const progress = Math.min((now - startedAt) / duration, 1);
      const revealedCharacters = Math.floor(progress * word.length);

      wordmark.textContent = Array.from(word, (character, index) =>
        index < revealedCharacters ? character : randomGlyph(),
      ).join("");

      if (progress < 1) {
        requestAnimationFrame(renderFrame);
        return;
      }

      wordmark.textContent = word;
      window.setTimeout(scramble, 2400);
    };

    requestAnimationFrame(renderFrame);
  };

  window.setTimeout(scramble, 900);
}
