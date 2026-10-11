// Extras when the game runs as the SniperValley program (window.desktop is set by
// electron/preload.cjs; in a browser it is absent): Quit buttons, the Fullscreen setting and
// the program-only controls (class "desk").
export const desktop = window.desktop || null;

export function setupDesktop() {
  if (!desktop) return;
  document.body.classList.add('desktop');
  for (const id of ['btn-quit', 'btn-quit2', 'btn-quit3']) {
    const b = document.getElementById(id);
    if (b) b.addEventListener('click', () => desktop.quit());
  }
  const sels = ['s0-fullscreen', 's1-fullscreen'].map((id) => document.getElementById(id)).filter(Boolean);
  const show = (on) => { for (const s of sels) s.value = on ? '1' : '0'; };
  desktop.fullscreen().then(show);
  desktop.onFullscreen(show);
  for (const s of sels) s.addEventListener('change', () => desktop.fullscreen(s.value === '1').then(show));
}
