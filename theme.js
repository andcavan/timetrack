// ═══ TIMETRACK — theme.js ═══
// Tema chiaro, scuro o «come il sistema» (valore di partenza), come in Bomtrack.
// La scelta resta in questo browser: è una comodità di chi guarda lo schermo,
// non un dato dell'azienda. Il colore vero sta tutto in style.css; qui si
// scrive solo l'attributo data-theme su <html>.
// ATTENZIONE: la chiave è ripetuta nello script in testa a index.html, che
// applica il tema prima del primo disegno. Se cambia, cambia in tutti e due.
const THEME_KEY = 'tt_theme';
const THEMES = ['auto', 'light', 'dark'];
const THEME_LABEL = { auto: 'Come il sistema', light: 'Chiaro', dark: 'Scuro' };
let theme = 'auto';

function themeLoad() {
  try { const v = localStorage.getItem(THEME_KEY); if (THEMES.includes(v)) theme = v; } catch (e) { /* si resta in automatico */ }
  return theme;
}
// In automatico l'attributo si toglie: è l'assenza a lasciar decidere alla media query.
function themeApply() {
  const r = document.documentElement;
  if (theme === 'auto') r.removeAttribute('data-theme'); else r.setAttribute('data-theme', theme);
}
function themeEffective() {
  if (theme !== 'auto') return theme;
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}
function themeNext() { return THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length]; }
function themeSet(t) {
  theme = THEMES.includes(t) ? t : 'auto';
  themeApply();
  try { localStorage.setItem(THEME_KEY, theme); } catch (e) { /* niente da salvare */ }
  themeButtonFill();
}
function themeToggle() {
  themeSet(themeNext());
  showToast('Tema: ' + THEME_LABEL[theme].toLowerCase());
}
// L'icona dice dove si è (sole se lo schermo è chiaro, luna se è scuro); il
// titolo nomina lo stato per esteso e il prossimo del giro.
function themeButtonFill() {
  const b = document.getElementById('theme-btn');
  if (!b) return;
  const eff = themeEffective();
  const ora = theme === 'auto' ? `come il sistema (${eff === 'dark' ? 'scuro' : 'chiaro'})` : THEME_LABEL[theme].toLowerCase();
  const testo = `Tema: ${ora} · premi per «${THEME_LABEL[themeNext()].toLowerCase()}»`;
  b.innerHTML = ico(eff === 'dark' ? 'moon' : 'sun', 'tinted');
  b.title = testo;
  b.setAttribute('aria-label', testo);
}
if (window.matchMedia) {
  const mm = window.matchMedia('(prefers-color-scheme: light)');
  if (mm.addEventListener) mm.addEventListener('change', () => { if (theme === 'auto') themeButtonFill(); });
}
themeLoad(); themeApply(); themeButtonFill();
