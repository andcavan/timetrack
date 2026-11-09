// ═══════════════════════════════════════════════════════════
//  TIMETRACK — schede.js: la pagina «Schede» (dalla 5.5.0)
// ═══════════════════════════════════════════════════════════
// Un altro modo di registrare le ore, accanto a «Ore»: a sinistra le schede
// delle commesse attive dell'utente (con dettagli e attività), a destra gli
// stessi comandi di inserimento e la stessa settimana della pagina Ore.
//
// ── Niente doppioni ──
// La zona «Tempo» (timer, data, orario, ore, nota, Registra / Avvia timer) e
// la settimana NON sono copiate: sono gli stessi elementi di index.html, che
// skSposta() porta qui quando si apre la pagina e rimette al loro posto
// quando si torna su Ore. Così addEntry(), startTimer() e la settimana restano
// una cosa sola. Scegliere scheda e attività compila i campi nascosti
// dell'inserimento rapido (qe-project, qe-activity), che quei comandi leggono.
//
// ── Le preferite ──
// Restano sul dispositivo (localStorage), una lista per utente: nessuna
// tabella nuova sul database. Su un altro PC o telefono si scelgono da capo.

const SK_KEY = 'tt_schede_';
let skTab = 'pref', skQuery = '', skCasa = null;

// Preferite, scheda aperta e attività scelta dell'utente su questo dispositivo
function skStato() {
  try { const o = JSON.parse(localStorage.getItem(SK_KEY + currentUser.id) || '{}'); return o && typeof o === 'object' ? o : {}; }
  catch (e) { return {}; }
}
function skSalva(o) {
  try { localStorage.setItem(SK_KEY + currentUser.id, JSON.stringify(o)); } catch (e) { /* senza localStorage le preferite durano fino alla chiusura */ }
}
// Le commesse su cui l'utente può registrare: attive e assegnate a lui
function skCommesse() {
  return db.projects.filter(p => p.status === 'active' && isProjectVisible(p))
    .sort((a, b) => (a.code || a.name).localeCompare(b.code || b.name, 'it', { numeric: true }));
}
function skPreferite() {
  const fav = skStato().fav || [];
  return skCommesse().filter(p => fav.includes(p.id));
}
// La scelta salvata, se la commessa e l'attività ci sono ancora
function skScelta() {
  const s = skStato(), pr = s.p ? skCommesse().find(p => p.id === s.p) : null;
  if (!pr) return { pr: null, a: null };
  return { pr, a: (pr.activities || []).find(a => a.id === s.a) || null };
}

// Zona «Tempo» e settimana: qui sulla pagina Schede, al loro posto altrove.
// Un commento segna il posto da cui sono partite.
function skSposta(qui) {
  const tempo = document.querySelector('.qz-tempo'), week = document.querySelector('.week-section');
  if (!tempo || !week) return;
  if (!skCasa) {
    if (!qui) return;
    skCasa = { tempo: document.createComment('qz-tempo'), week: document.createComment('week-section') };
    tempo.before(skCasa.tempo); week.before(skCasa.week);
  }
  if (qui) {
    document.getElementById('sk-tempo-slot').appendChild(tempo);
    document.getElementById('sk-week-slot').appendChild(week);
  } else {
    skCasa.tempo.after(tempo); skCasa.week.after(week);
  }
}

function renderSchede() {
  selectedWeek = selectedWeek || getWeekStart(todayStr());
  const d = document.getElementById('qe-date');
  if (!d.value) d.value = todayStr();
  selectedDay = d.value;
  // Senza preferite si parte da «Tutte attive», dove si scelgono
  skTab = skStato().vista || (skPreferite().length ? 'pref' : 'tutte');
  skApplica();
  renderQH();
  renderWeek(); // ridisegna anche la barra (renderTimer → renderSkBarra)
}

// La barra a sinistra: schede in alto, elenco sotto. La ricerca resta fuori
// dall'elenco, così chi scrive non perde il campo a ogni aggiornamento.
function renderSkBarra() {
  const box = document.getElementById('sk-list');
  if (!box || !db || !currentUser) return;
  const tutte = skCommesse(), fav = skStato().fav || [], pref = tutte.filter(p => fav.includes(p.id));
  document.getElementById('sk-tab-pref').classList.toggle('on', skTab === 'pref');
  document.getElementById('sk-tab-tutte').classList.toggle('on', skTab === 'tutte');
  document.getElementById('sk-n-pref').textContent = pref.length;
  document.getElementById('sk-n-tutte').textContent = tutte.length;
  document.getElementById('sk-cerca-box').style.display = skTab === 'tutte' ? '' : 'none';
  let lista = skTab === 'pref' ? pref : tutte;
  if (skTab === 'tutte' && skQuery) {
    const q = skQuery.toLowerCase();
    lista = lista.filter(p => (p.code + ' ' + p.name + ' ' + (db.clients.find(c => c.id === p.clientId)?.name || '')).toLowerCase().includes(q));
  }
  if (!lista.length) {
    box.innerHTML = skTab === 'pref'
      ? `<div class="sk-empty">Nessuna preferita. In <button class="sk-link" onclick="skVista('tutte')">Tutte attive</button> tocca la stella delle commesse su cui lavori.</div>`
      : `<div class="sk-empty">${skQuery ? 'Nessuna commessa trovata' : 'Nessuna commessa attiva assegnata a te'}</div>`;
    return;
  }
  const sel = skScelta();
  box.innerHTML = lista.map(p => skCard(p, sel, fav.includes(p.id))).join('');
}

function skCard(p, sel, preferita) {
  const mie = db.entries.filter(e => e.userId === currentUser.id && e.projectId === p.id);
  const oggi = mie.filter(e => e.date === todayStr()).reduce((s, e) => s + e.hours, 0);
  const aperta = sel.pr && sel.pr.id === p.id;
  const cl = db.clients.find(c => c.id === p.clientId);
  const id = esc(p.id);
  let det = '';
  if (aperta) {
    const tot = mie.reduce((s, e) => s + e.hours, 0), acts = p.activities || [], t = db.timer;
    const fatti = (p.referente ? `<dt>Referente</dt><dd>${esc(p.referente)}</dd>` : '')
      + (p.deadline ? `<dt>Scadenza</dt><dd>${fmtDate(p.deadline)}</dd>` : '')
      + `<dt>Le tue ore</dt><dd>${+tot.toFixed(2)}${p.budgetHours ? ` su ${p.budgetHours} previste<div class="sk-bar"><i style="width:${Math.min(100, tot / p.budgetHours * 100)}%"></i></div>` : ''}</dd>`;
    det = `<div class="sk-det"><dl class="sk-facts">${fatti}</dl>${p.note ? `<div class="sk-note">${esc(p.note)}</div>` : ''}
      <div class="sk-lab">Attività</div>
      ${acts.length ? `<div class="sk-acts">${acts.map(a => {
        const run = !!t && t.projectId === p.id && t.activityId === a.id;
        const h = mie.filter(e => e.activityId === a.id).reduce((s, e) => s + e.hours, 0);
        return `<button type="button" class="sk-act ${sel.a && sel.a.id === a.id ? 'on' : ''} ${run ? 'run' : ''}" onclick="skScegli('${id}','${esc(a.id)}')"><span class="dot"></span><span class="nm">${esc(a.name)}</span>${run ? '<span class="h sk-run">timer</span>' : h ? `<span class="h">${+h.toFixed(2)}h</span>` : ''}</button>`;
      }).join('')}</div>` : `<p class="sk-hint">La commessa non ha attività: chiedi a un amministratore di aggiungerne una.</p>`}
    </div>`;
  }
  return `<div class="sk-card ${aperta ? 'sel' : ''}" onclick="if(!event.target.closest('button'))skScegli('${id}','')">
    <div class="sk-row"><div class="sk-main"><div class="sk-code">${esc(p.code)}</div><div class="sk-name">${esc(p.name)}</div><div class="sk-client">${esc(cl?.name || '')}</div></div>
    ${oggi ? `<span class="sk-oggi" title="Le tue ore di oggi su questa commessa">${+oggi.toFixed(2)}h oggi</span>` : ''}
    <button type="button" class="sk-star ${preferita ? 'on' : ''}" onclick="skStella('${id}')" title="${preferita ? 'Togli dalle preferite' : 'Aggiungi alle preferite'}" aria-label="${preferita ? 'Togli dalle preferite' : 'Aggiungi alle preferite'}" aria-pressed="${preferita}">${ico('star')}</button></div>
    ${det}</div>`;
}

// Scegliere una scheda (aid vuoto) o un'attività. Una scheda con una sola
// attività la sceglie da sé.
function skScegli(pid, aid) {
  const pr = skCommesse().find(p => p.id === pid);
  if (!pr) return;
  const acts = pr.activities || [];
  if (!aid) {
    const s = skStato();
    aid = s.p === pid && s.a ? s.a : (acts.length === 1 ? acts[0].id : '');
  }
  skSalva({ ...skStato(), p: pid, a: aid });
  skApplica();
  renderSkBarra();
}
// La scelta va nei campi dell'inserimento rapido, che Registra Ore e Avvia
// timer leggono, e nell'intestazione «Stai registrando su».
function skApplica() {
  const { pr, a } = skScelta();
  const head = document.getElementById('sk-sel');
  if (!head) return;
  if (pr) {
    selectProject(pr.id, qrProjectLabel(pr));
    if (a) document.getElementById('qe-activity').value = a.id;
    renderQeQr();
  } else {
    document.getElementById('qe-project-search').value = '';
    document.getElementById('qe-project').value = '';
    onQeProjectChange3();
  }
  const cl = pr ? db.clients.find(c => c.id === pr.clientId) : null;
  head.innerHTML = pr
    ? `<div class="k">Stai registrando su</div><div class="v">${pr.code ? `<span class="c">${esc(pr.code)}</span>` : ''}${esc(pr.name)}</div><div class="a">${esc(cl?.name || '')} · ${a ? `<b>${esc(a.name)}</b>` : '<span class="sk-manca">scegli l\'attività nella scheda</span>'}</div>`
    : `<div class="k">Stai registrando su</div><div class="a">Scegli una commessa e un'attività dalle schede ${window.matchMedia('(max-width:900px)').matches ? 'qui sopra' : 'a sinistra'}.</div>`;
}
function skStella(pid) {
  const s = skStato(), fav = s.fav || [];
  s.fav = fav.includes(pid) ? fav.filter(x => x !== pid) : fav.concat(pid);
  skSalva(s);
  renderSkBarra();
}
function skVista(v) {
  skTab = v === 'tutte' ? 'tutte' : 'pref';
  skSalva({ ...skStato(), vista: skTab });
  renderSkBarra();
}
function skCerca(v) { skQuery = String(v || '').trim(); renderSkBarra(); }
