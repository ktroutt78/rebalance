// Info/annotation layer: the first-load intro card + a recallable "About" panel.
// Behavior only — no app state and (by design) no browser storage, so the intro
// simply shows once per load; the "?" button recalls the fuller About panel anytime.

const $ = (id) => document.getElementById(id);

export function initInfo() {
  const intro = $('intro-overlay');
  const about = $('about-overlay');

  const open = (el) => el && el.classList.remove('hidden');
  const close = (el) => el && el.classList.add('hidden');

  // First-load card: dismiss via its button or by clicking the backdrop.
  $('intro-dismiss')?.addEventListener('click', () => close(intro));
  intro?.addEventListener('click', (e) => { if (e.target === intro) close(intro); });

  // "?" recalls the About panel (works after the intro is dismissed too).
  $('help-btn')?.addEventListener('click', () => open(about));
  $('about-close')?.addEventListener('click', () => close(about));
  about?.addEventListener('click', (e) => { if (e.target === about) close(about); });

  // Esc closes whichever overlay is open.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { close(intro); close(about); }
  });

  // Show the intro card once on load.
  open(intro);
}
