// ─── Icone ───
// Stesso set a tratto di Bomtrack (griglia 24×24, tratto 1.8, terminazioni tonde)
// al posto delle emoji di sistema: seguono il colore del testo, si allineano alla
// linea di base e hanno lo stesso aspetto su ogni dispositivo. I tracciati stanno
// in uno sprite nascosto; ogni icona sul DOM è un <use> che lo referenzia.
const ICONS = {
  key: '<circle cx="7.8" cy="15.8" r="3.8"/><path d="m10.6 13.1 9.6-9.6"/><path d="m17.4 6.3 2.4 2.4M15 8.7l2.4 2.4"/>',
  edit: '<path d="M4 20h4.2L18.9 9.3a2.2 2.2 0 0 0-3.1-3.1L5 16.9V20z"/><path d="m14.6 7.4 3.1 3.1"/>',
  trash: '<path d="M4 6.4h16"/><path d="M9.5 6.4V4.6a1.1 1.1 0 0 1 1.1-1.1h2.8a1.1 1.1 0 0 1 1.1 1.1v1.8"/><path d="m6.4 6.4.9 13.1a1.2 1.2 0 0 0 1.2 1.1h7a1.2 1.2 0 0 0 1.2-1.1l.9-13.1"/><path d="M10.4 10v7M13.6 10v7"/>',
  check: '<path d="m4.6 12.4 5 5L19.4 6.6"/>',
  close: '<path d="m6.2 6.2 11.6 11.6M17.8 6.2 6.2 17.8"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="10.6" cy="10.6" r="6.6"/><path d="m15.4 15.4 5.1 5.1"/>',
  refresh: '<path d="M20.3 12a8.3 8.3 0 1 1-2.6-6"/><path d="M20.5 3.5V9h-5.5"/>',
  chart: '<path d="M3.6 20.4h16.8"/><path d="M6.8 20.4v-6.6M11.6 20.4V7.6M16.4 20.4v-9.4"/>',
  clipboard: '<rect x="5.4" y="4.6" width="13.2" height="16" rx="1.8"/><path d="M9 4.6V3.4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v1.2"/><path d="M9 10.6h6M9 14.4h6M9 18h3.5"/>',
  settings: '<path d="M13.6 2.6h-3.2l-.4 2.4-2 .8-2-1.3-2.3 2.3 1.3 2-.8 2-2.4.4v3.2l2.4.4.8 2-1.3 2 2.3 2.3 2-1.3 2 .8.4 2.4h3.2l.4-2.4 2-.8 2 1.3 2.3-2.3-1.3-2 .8-2 2.4-.4v-3.2l-2.4-.4-.8-2 1.3-2-2.3-2.3-2 1.3-2-.8z"/><circle cx="12" cy="12" r="3.1"/>',
  cloud: '<path d="M7.2 18.6h10a4.1 4.1 0 0 0 .7-8.1 5.7 5.7 0 0 0-11-1.3 4.7 4.7 0 0 0 .3 9.4z"/>',
  file: '<path d="M13.4 3.4H6.9a1.6 1.6 0 0 0-1.6 1.6v14a1.6 1.6 0 0 0 1.6 1.6h10.2a1.6 1.6 0 0 0 1.6-1.6V8.4z"/><path d="M13.4 3.4v5h5.3"/><path d="M8.6 13h6.8M8.6 16.6h4.8"/>',
  sheet: '<rect x="3.4" y="4.4" width="17.2" height="15.2" rx="1.8"/><path d="M3.4 9.6h17.2M3.4 14.6h17.2M9.6 4.4v15.2"/>',
  link: '<path d="M10.2 13.8a4.2 4.2 0 0 0 6 0l2.9-2.9a4.2 4.2 0 0 0-6-6l-1.7 1.7"/><path d="M13.8 10.2a4.2 4.2 0 0 0-6 0l-2.9 2.9a4.2 4.2 0 0 0 6 6l1.7-1.7"/>',
  copy: '<rect x="8.6" y="8.6" width="11.9" height="11.9" rx="2"/><path d="M5.6 15.4H4.5a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1h9.9a1 1 0 0 1 1 1v1.1"/>',
  save: '<path d="M5.4 3.6h11l3.2 3.2v13a1.8 1.8 0 0 1-1.8 1.8H5.4a1.8 1.8 0 0 1-1.8-1.8V5.4a1.8 1.8 0 0 1 1.8-1.8z"/><path d="M7.8 3.6v5.6h8V3.6"/><path d="M7.8 21.6v-6.4h8.4v6.4"/>',
  book: '<path d="M4.4 4.8a1.8 1.8 0 0 1 1.8-1.8h11.4a1.8 1.8 0 0 1 1.8 1.8v14.4a1.8 1.8 0 0 1-1.8 1.8H6.2a1.8 1.8 0 0 1-1.8-1.8z"/><path d="M7.8 3v18"/><path d="M10.8 7.8h5.4M10.8 11.2h5.4M10.8 14.6h3.4"/>',
  users: '<circle cx="9.4" cy="8.4" r="3.4"/><path d="M3.4 20c.6-3.6 3-5.6 6-5.6s5.4 2 6 5.6"/><path d="M16 5.4a3.4 3.4 0 0 1 0 6.6"/><path d="M17.4 14.8c2 .7 3.3 2.5 3.7 5.2"/>',
  clock: '<circle cx="12" cy="12" r="8.6"/><path d="M12 6.9v5.4l3.5 2"/>',
  pause: '<path d="M9.4 5.4v13.2M14.6 5.4v13.2"/>',
  euro: '<path d="M18.2 6.4a7.5 7.5 0 1 0 0 11.2"/><path d="M4.6 10.4h9.2M4.6 13.9h9.2"/>',
  warning: '<path d="M12 3.6 2.9 19.5a1.1 1.1 0 0 0 1 1.6h16.2a1.1 1.1 0 0 0 1-1.6z"/><path d="M12 9.4v4.8M12 17.4h.01"/>',
  logout: '<path d="M9 20.6H5.4a1.9 1.9 0 0 1-1.9-1.9V5.3a1.9 1.9 0 0 1 1.9-1.9H9"/><path d="m16 16.8 4.8-4.8L16 7.2"/><path d="M20.5 12H9"/>',
  sun: '<circle cx="12" cy="12" r="4.2"/><path d="M12 2.6v2.4M12 19v2.4M21.4 12H19M5 12H2.6M18.6 5.4l-1.7 1.7M7.1 16.9l-1.7 1.7M18.6 18.6l-1.7-1.7M7.1 7.1 5.4 5.4"/>',
  moon: '<path d="M20.4 14.2A8.6 8.6 0 0 1 9.8 3.6a8.6 8.6 0 1 0 10.6 10.6z"/>',
  wrench: '<path d="M15.4 3.4a5 5 0 0 0-3.6 6.7L4.4 17.5a2.1 2.1 0 0 0 3 3l7.4-7.4a5 5 0 0 0 6.7-3.6l-3.2 1.5-2.6-1.1-1.1-2.6z"/>',
  folder: '<path d="M3.4 6.6a1.6 1.6 0 0 1 1.6-1.6h4.2l2 2.6h7.4a1.6 1.6 0 0 1 1.6 1.6v9.2a1.6 1.6 0 0 1-1.6 1.6H5a1.6 1.6 0 0 1-1.6-1.6z"/>',
  calendar: '<rect x="3.4" y="4.8" width="17.2" height="16" rx="2"/><path d="M3.4 9.6h17.2M8 2.8v3.6M16 2.8v3.6"/>',
  user: '<circle cx="12" cy="8.2" r="3.8"/><path d="M4.6 20.4c.8-4 3.7-6.2 7.4-6.2s6.6 2.2 7.4 6.2"/>',
  trend: '<path d="m3.4 16.6 5.4-5.4 3.8 3.8 7.8-8"/><path d="M15.4 7h5v5"/>',
  bolt: '<path d="M13.4 2.8 5 13.4h6l-1 7.8 8.4-10.6h-6z"/>',
  plug: '<path d="M9 3v5M15 3v5"/><path d="M6.4 8h11.2v3.2a5.6 5.6 0 0 1-11.2 0z"/><path d="M12 16.8V21"/>',
  dot: '<circle cx="12" cy="12" r="5"/>',
};

// Tinta costante per icona, dalla tavolozza dell'app (come in Bomtrack):
// si applica solo dove serve, con ico('trash','tinted').
const ICON_TINT = {
  edit: 'accent', trash: 'red', link: 'purple', search: 'accent', plus: 'green',
  copy: 'accent', check: 'green', close: 'red', refresh: 'accent',
  warning: 'orange', clock: 'purple', pause: 'orange', key: 'orange', logout: 'red',
  file: 'red', sheet: 'green', euro: 'green', trend: 'green', chart: 'purple',
  clipboard: 'accent', calendar: 'accent', settings: 'text-dim', book: 'text-dim',
  cloud: 'accent', save: 'accent', users: 'accent', user: 'accent', wrench: 'purple',
  folder: 'orange', bolt: 'orange', plug: 'accent', dot: 'accent'
};

function icoEsc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
// `label` è il suggerimento al passaggio del mouse; assente o vuoto, nessuno
// (il testo accanto all'icona la spiega già).
function ico(name, cls, label) {
  if (!ICONS[name]) return '';
  const svg = '<svg class="ico ic-' + name + (cls ? ' ' + cls : '') + '" aria-hidden="true"><use href="#ic-' + name + '"></use></svg>';
  return label ? '<span class="ico-w" title="' + icoEsc(label) + '">' + svg + '</span>' : svg;
}

function iconSprite() {
  const symbols = Object.keys(ICONS)
    .map(k => '<symbol id="ic-' + k + '" viewBox="0 0 24 24">' + ICONS[k] + '</symbol>').join('');
  return '<svg xmlns="http://www.w3.org/2000/svg" style="display:none" aria-hidden="true">' + symbols + '</svg>';
}
function iconTintCss() {
  return '.ico.tinted{color:var(--ic-tint,currentColor)}'
    + Object.keys(ICON_TINT).map(k => '.ico.ic-' + k + '{--ic-tint:var(--' + ICON_TINT[k] + ')}').join('');
}

if (typeof document !== 'undefined' && document.body && document.body.insertAdjacentHTML) {
  document.body.insertAdjacentHTML('afterbegin', iconSprite());
  const st = document.createElement('style');
  st.id = 'icon-tints';
  st.textContent = iconTintCss();
  document.head.appendChild(st);
}
