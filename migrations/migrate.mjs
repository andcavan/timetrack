#!/usr/bin/env node
// ============================================================
//  TimeTrack — Migrazione dati: blob JSON (timetrack_data id=1)
//  → tabelle normalizzate + account Supabase Auth.
//
//  Eseguire LOCALMENTE (mai nel browser) con la service_role key:
//
//    npm install @supabase/supabase-js
//    set SUPABASE_URL=https://xxxx.supabase.co
//    set SUPABASE_SERVICE_ROLE_KEY=eyJ...   (Dashboard → Settings → API)
//    node migrate.mjs --dry-run     (prova senza scrivere nulla)
//    node migrate.mjs               (migrazione reale)
//
//  Opzioni:
//    --dry-run            non scrive nulla, stampa solo il report
//    --fallback-domain=X  dominio per utenti SENZA email reale
//                         (es. --fallback-domain=azienda.it →
//                          crea username@azienda.it con password
//                          temporanea stampata a video, da comunicare
//                          a voce). Senza questa opzione gli utenti
//                          senza email bloccano la migrazione.
//
//  La service_role key NON va mai committata né messa nell'app.
// ============================================================
import { createClient } from '@supabase/supabase-js';
import crypto from 'node:crypto';

const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL || !KEY) {
  console.error('Imposta SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY nelle variabili d\'ambiente.');
  process.exit(1);
}
const DRY = process.argv.includes('--dry-run');
const fallbackArg = process.argv.find(a => a.startsWith('--fallback-domain='));
const FALLBACK_DOMAIN = fallbackArg ? fallbackArg.split('=')[1] : null;

const supa = createClient(URL, KEY, { auth: { autoRefreshToken: false, persistSession: false } });

function die(msg, err) {
  console.error('\n✗ ERRORE:', msg);
  if (err) console.error(err);
  process.exit(1);
}

async function insertAll(table, rows) {
  if (!rows.length) return;
  if (DRY) { console.log(`  [dry-run] ${table}: ${rows.length} righe`); return; }
  // batch da 500 per sicurezza
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const { error } = await supa.from(table).upsert(chunk);
    if (error) die(`insert in ${table} (batch ${i})`, error);
  }
  console.log(`  ✓ ${table}: ${rows.length} righe`);
}

(async () => {
  console.log(`\n═══ TimeTrack migrazione ${DRY ? '(DRY RUN — nessuna scrittura)' : ''} ═══\n`);

  // ── 1. Leggi il blob ──────────────────────────────────────
  const { data: blobRow, error: blobErr } = await supa
    .from('timetrack_data').select('data').eq('id', 1).single();
  if (blobErr) die('lettura timetrack_data id=1', blobErr);
  const db = blobRow.data;
  console.log(`Blob letto: ${db.users?.length || 0} utenti, ${db.clients?.length || 0} clienti, ` +
    `${db.projects?.length || 0} commesse, ${db.entries?.length || 0} registrazioni, ${db.rates?.length || 0} tariffe`);

  // ── 2. Valida le email degli utenti ───────────────────────
  const noEmail = (db.users || []).filter(u => !u.email || !u.email.includes('@'));
  if (noEmail.length && !FALLBACK_DOMAIN) {
    die(`Utenti senza email valida: ${noEmail.map(u => u.username || u.name).join(', ')}.\n` +
      `  Inserisci le email nella tab Utenti dell'app attuale, oppure usa --fallback-domain=tuodominio.it`);
  }

  // ── 3. Crea gli account auth (invito o password temporanea) ──
  const idMap = {}; // vecchio id utente → uuid auth
  const tempPasswords = [];
  // gestisci ri-esecuzioni: riusa gli account già creati (match su legacy_id nei profiles)
  const { data: existingProfiles } = await supa.from('profiles').select('id, legacy_id');
  const existingByLegacy = Object.fromEntries((existingProfiles || []).filter(p => p.legacy_id).map(p => [p.legacy_id, p.id]));

  for (const u of db.users || []) {
    if (existingByLegacy[u.id]) {
      idMap[u.id] = existingByLegacy[u.id];
      console.log(`  = utente già migrato: ${u.username || u.name}`);
      continue;
    }
    const meta = {
      name: u.name, username: u.username || '', role: u.role || 'operator',
      color: /^#[0-9A-Fa-f]{6}$/.test(u.color || '') ? u.color : '#3A7BE8',
      legacy_id: u.id
    };
    const hasEmail = u.email && u.email.includes('@');
    if (DRY) {
      console.log(`  [dry-run] utente ${u.username || u.name} → ${hasEmail ? 'invito a ' + u.email : 'password temporanea (' + (u.username || 'user') + '@' + FALLBACK_DOMAIN + ')'}`);
      idMap[u.id] = 'dry-' + u.id;
      continue;
    }
    if (hasEmail) {
      const { data, error } = await supa.auth.admin.inviteUserByEmail(u.email, { data: meta });
      if (error) die(`invito a ${u.email}`, error);
      idMap[u.id] = data.user.id;
      console.log(`  ✓ invito inviato: ${u.email} (${u.username || u.name})`);
    } else {
      const email = `${(u.username || 'user' + u.id).toLowerCase()}@${FALLBACK_DOMAIN}`;
      const tempPwd = crypto.randomBytes(9).toString('base64url');
      const { data, error } = await supa.auth.admin.createUser({
        email, password: tempPwd, email_confirm: true, user_metadata: meta
      });
      if (error) die(`creazione ${email}`, error);
      idMap[u.id] = data.user.id;
      tempPasswords.push({ user: u.name, email, tempPwd });
      console.log(`  ✓ account creato: ${email} (password temporanea, vedi report finale)`);
    }
    // se l'utente era sospeso, ripristina active=false (il trigger crea active=true)
    if (u.active === false) {
      const { error } = await supa.from('profiles').update({ active: false }).eq('id', idMap[u.id]);
      if (error) die(`sospensione profilo ${u.name}`, error);
    }
  }

  // ── 4. Dati di dominio (id invariati; user id rimappati) ──
  const remap = (oldId) => oldId == null ? null : (idMap[oldId] || die(`user id sconosciuto: ${oldId}`));

  await insertAll('clients', (db.clients || []).map(c => ({
    id: c.id, name: c.name, referente: c.referente || '', email: c.email || '', active: c.active !== false
  })));

  await insertAll('projects', (db.projects || []).map(p => ({
    id: p.id, client_id: p.clientId, name: p.name, code: p.code || '', referente: p.referente || '',
    status: p.status || 'active', budget_hours: p.budgetHours || 0, deadline: p.deadline || null,
    // utenti assegnati non più esistenti: semplicemente scartati
    assigned_users: DRY ? [] : (p.assignedUsers || []).map(id => idMap[id]).filter(Boolean)
  })));

  await insertAll('project_finance', (db.projects || [])
    .filter(p => p.budget)
    .map(p => ({ project_id: p.id, budget: p.budget })));

  await insertAll('activities', (db.projects || []).flatMap(p =>
    (p.activities || []).map(a => ({ id: a.id, project_id: p.id, name: a.name }))));

  const validRates = (db.rates || []).filter(r => {
    const ok = r.userId == null || idMap[r.userId];
    if (!ok) console.log(`  ⚠ tariffa scartata (utente inesistente): ${r.id}`);
    return ok;
  });
  await insertAll('rates', validRates.map(r => ({
    id: r.id, user_id: DRY ? null : remap(r.userId), client_id: r.clientId, project_id: r.projectId,
    cost_rate: r.costRate, client_rate: r.clientRate, valid_from: r.from, valid_to: r.to
  })));

  // set di id validi per scartare entry orfane (progetti/attività cancellati)
  const projIds = new Set((db.projects || []).map(p => p.id));
  const actIds = new Set((db.projects || []).flatMap(p => (p.activities || []).map(a => a.id)));
  const clientIds = new Set((db.clients || []).map(c => c.id));
  const entries = (db.entries || []).filter(e => {
    const ok = projIds.has(e.projectId) && clientIds.has(e.clientId) && idMap[e.userId];
    if (!ok) console.log(`  ⚠ entry scartata (riferimenti mancanti): ${e.id} del ${e.date}`);
    return ok;
  });

  await insertAll('entries', entries.map(e => ({
    id: e.id, user_id: DRY ? null : remap(e.userId), client_id: e.clientId, project_id: e.projectId,
    activity_id: actIds.has(e.activityId) ? e.activityId : null,
    date: e.date, hours: e.hours, note: e.note || '',
    created_at: e.createdAt || new Date().toISOString()
  })));

  // ── 5. Snapshot costi STORICI dal blob (sovrascrive il ricalcolo del trigger) ──
  await insertAll('entry_costs', entries.map(e => ({
    entry_id: e.id, cost_rate: e.costRate || 0, client_rate: e.clientRate || 0
  })));

  // contatore codice commessa
  if (!DRY) {
    const { error } = await supa.from('app_settings')
      .upsert({ key: 'next_project_num', value: String(db.nextProjectNum || 1) });
    if (error) die('app_settings', error);
  }

  // ── 6. Verifica conteggi ──────────────────────────────────
  if (!DRY) {
    console.log('\n═══ Verifica ═══');
    const count = async (t) => (await supa.from(t).select('*', { count: 'exact', head: true })).count;
    const checks = [
      ['profiles', (db.users || []).length],
      ['clients', (db.clients || []).length],
      ['projects', (db.projects || []).length],
      ['activities', (db.projects || []).flatMap(p => p.activities || []).length],
      ['rates', validRates.length],
      ['entries', entries.length],
      ['entry_costs', entries.length],
    ];
    let allOk = true;
    for (const [t, expected] of checks) {
      const got = await count(t);
      const ok = got === expected;
      if (!ok) allOk = false;
      console.log(`  ${ok ? '✓' : '✗'} ${t}: ${got} / attese ${expected}`);
    }
    const totHours = entries.reduce((s, e) => s + e.hours, 0);
    const { data: sumRows } = await supa.from('entries').select('hours');
    const gotHours = (sumRows || []).reduce((s, r) => s + Number(r.hours), 0);
    console.log(`  ${Math.abs(gotHours - totHours) < 0.001 ? '✓' : '✗'} ore totali: ${gotHours} / attese ${totHours}`);
    console.log(allOk ? '\n✓ MIGRAZIONE COMPLETATA' : '\n✗ CONTEGGI NON COINCIDONO — verificare prima dello switch!');
  }

  if (tempPasswords.length) {
    console.log('\n═══ PASSWORD TEMPORANEE (comunicare a voce, poi far cambiare) ═══');
    tempPasswords.forEach(t => console.log(`  ${t.user}: ${t.email} / ${t.tempPwd}`));
  }
  console.log('');
})();
