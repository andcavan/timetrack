// ═══════════════════════════════════════════════════════════
//  TIMETRACK — sw.js (service worker)
// ═══════════════════════════════════════════════════════════
// Serve a due cose (dalla 5.4.0): che il telefono proponga di installare
// l'app, e che l'app installata si apra anche con la rete che va e viene.
// Lo stesso approccio di Bomtrack, con una differenza voluta: qui si chiede
// **prima alla rete** e la cache è solo il ripiego.
//
// ── Perché "prima la rete" ──
// Bomtrack serve i suoi file dalla cache e cambia il nome della cache a ogni
// versione. TimeTrack si pubblica copiando i file sull'hosting, e senza
// Supabase non registra niente: un'app servita dalla cache con un app.js
// vecchio contro uno schema nuovo farebbe più danni di un'attesa. Così chi è
// in linea riceve sempre i file appena pubblicati, senza dover cambiare
// niente qui a ogni versione; chi è senza rete apre lo stesso l'app, che gli
// dice che manca la rete invece di una pagina bianca.
//
// ── Cosa NON fa ──
// Non tocca i dati: le chiamate a Supabase (ore, accesso, archivio) vanno a
// un'altra origine e non passano di qui. Si mettono da parte solo i file del
// programma e le librerie dei CDN, che hanno la versione nell'indirizzo e
// quindi non cambiano mai.

const CACHE = 'timetrack-v1';

// I file dell'app. test/pwa.test.mjs controlla che ci sia ogni script e foglio
// di stile di index.html, e che ogni voce esista davvero.
const FILE = [
  './',
  './index.html',
  './style.css',
  './icons.js',
  './app.js',
  './schede.js',
  './theme.js',
  './manifest.webmanifest',
  './icone/icona.svg',
  './icone/icona-192.png',
  './icone/apple-touch-icon.png',
];

// Le librerie da CDN: indirizzo con la versione dentro, quindi immutabili.
const CDN = ['https://cdn.jsdelivr.net', 'https://cdnjs.cloudflare.com', 'https://fonts.googleapis.com', 'https://fonts.gstatic.com'];

self.addEventListener('install', e => {
  // Un file per volta, e un errore non ferma gli altri: un'icona dimenticata
  // sull'hosting non deve lasciare l'app senza cache (addAll è tutto o niente).
  e.waitUntil(caches.open(CACHE)
    .then(c => Promise.all(FILE.map(u => c.add(new Request(u, { cache: 'reload' })).catch(() => {}))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(k => Promise.all(k.filter(x => x.startsWith('timetrack-') && x !== CACHE).map(x => caches.delete(x))))
      .then(() => self.clients.claim())
  );
});

function deposita(req, res) {
  // Solo risposte buone: un errore in cache diventerebbe un errore permanente,
  // e una pagina arrivata dopo un redirect Safari la rifiuta se servita da qui.
  if (res && res.ok && !res.redirected && (res.type === 'basic' || res.type === 'cors')) {
    const copia = res.clone();
    caches.open(CACHE).then(c => c.put(req, copia)).catch(() => {});
  }
  return res;
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Librerie dei CDN: prima la cache (la versione è nell'indirizzo).
  if (CDN.includes(url.origin)) {
    e.respondWith(caches.match(req).then(c => c || fetch(req).then(r => deposita(req, r))));
    return;
  }
  // Tutto il resto fuori da questa origine (Supabase compreso) non si tocca.
  if (url.origin !== self.location.origin) return;

  // File dell'app: prima la rete, la cache se la rete manca. Le pagine si
  // depositano senza la parte dopo il «?» (il link di collegamento): una sola
  // copia, e niente indirizzi del progetto in cache.
  const chiave = req.mode === 'navigate' ? url.origin + url.pathname : req;
  e.respondWith(
    fetch(req).then(r => deposita(chiave, r)).catch(() =>
      // ignoreSearch: il link di collegamento (…?supabase=…) apre la stessa pagina.
      caches.match(req, { ignoreSearch: req.mode === 'navigate' }).then(c =>
        c || (req.mode === 'navigate' ? caches.match('./index.html') : Response.error())))
  );
});
