// ============================================================
//  L'app installabile (dalla 5.4.0): manifest, icone e service worker.
//
//  Non prova il service worker in un browser, ma le cose che vanno fuori
//  sincrono in silenzio e si vedono solo sul telefono o senza rete:
//  uno script aggiunto a index.html e dimenticato in sw.js, un file
//  elencato che non esiste, un'icona del manifest che manca.
//
//  Uso:  node --test test/pwa.test.mjs
// ============================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const leggi = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const esiste = f => fs.existsSync(path.join(ROOT, f));

function fileDelWorker() {
  const m = leggi('sw.js').match(/const FILE = \[([\s\S]*?)\];/);
  assert.ok(m, 'sw.js deve dichiarare l\'elenco FILE');
  return [...m[1].matchAll(/'(\.\/[^']*)'/g)].map(x => x[1].replace(/^\.\//, ''));
}

test('sw.js mette in cache ogni script e foglio di stile locale di index.html', () => {
  const html = leggi('index.html');
  const locali = [...html.matchAll(/<script src="([^":]+)"/g), ...html.matchAll(/<link rel="stylesheet" href="([^":]+)"/g)].map(x => x[1]);
  const inCache = new Set(fileDelWorker());
  assert.deepEqual(locali.filter(f => !inCache.has(f)), [], 'uno script fuori dalla cache sparisce senza rete');
});

test('ogni file elencato in sw.js esiste', () => {
  assert.deepEqual(fileDelWorker().filter(f => f && !esiste(f)), []);
});

test('il manifest è valido e le sue icone esistono', () => {
  const m = JSON.parse(leggi('manifest.webmanifest'));
  assert.ok(m.name && m.short_name && m.start_url && m.display === 'standalone');
  const misure = m.icons.map(i => i.sizes);
  assert.ok(misure.includes('192x192') && misure.includes('512x512'), 'Android chiede icone PNG 192 e 512');
  assert.ok(m.icons.some(i => i.purpose === 'maskable'), 'senza icona maskable Android la rimpicciolisce in un cerchio bianco');
  assert.deepEqual(m.icons.map(i => i.src).filter(f => !esiste(f)), []);
});

test('index.html collega manifest e icona per iPhone', () => {
  const html = leggi('index.html');
  for (const r of ['rel="manifest" href="manifest.webmanifest"', 'rel="apple-touch-icon" href="icone/apple-touch-icon.png"', 'id="install-btn"'])
    assert.ok(html.includes(r), 'manca ' + r);
  assert.ok(esiste('icone/apple-touch-icon.png'));
});

test('app.js registra il service worker', () => {
  assert.match(leggi('app.js'), /serviceWorker\.register\('sw\.js'\)/);
});
