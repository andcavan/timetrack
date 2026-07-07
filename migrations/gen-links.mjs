#!/usr/bin/env node
// ============================================================
//  Genera link "imposta/reimposta password" per gli utenti GIÀ
//  esistenti in Supabase Auth, SENZA inviare email (aggira il
//  rate limit del servizio email integrato).
//
//  Uso (stesse variabili d'ambiente di migrate.mjs):
//    node gen-links.mjs                → link per TUTTI gli utenti
//    node gen-links.mjs mario@x.it     → solo per quell'email
//
//  I link scadono (~24h): distribuirli subito. Chi clicca atterra
//  sull'app con la schermata "Imposta la tua password".
// ============================================================
import { createClient } from '@supabase/supabase-js';

const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL || !KEY) {
  console.error('Imposta SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY nelle variabili d\'ambiente.');
  process.exit(1);
}
const onlyEmail = process.argv[2] || null;
const supa = createClient(URL, KEY, { auth: { autoRefreshToken: false, persistSession: false } });

const { data, error } = await supa.auth.admin.listUsers({ perPage: 1000 });
if (error) { console.error('Errore lettura utenti:', error); process.exit(1); }

const users = data.users.filter(u => !onlyEmail || u.email?.toLowerCase() === onlyEmail.toLowerCase());
if (!users.length) { console.log('Nessun utente trovato.'); process.exit(0); }

console.log('\n═══ LINK IMPOSTA PASSWORD (scadono in ~24h, inviarli a mano) ═══');
for (const u of users) {
  const { data: link, error: linkErr } = await supa.auth.admin.generateLink({
    type: 'recovery', email: u.email
  });
  if (linkErr) { console.error(`  ✗ ${u.email}: ${linkErr.message}`); continue; }
  const name = u.user_metadata?.name || '';
  console.log(`\n  ${name} <${u.email}>:\n  ${link.properties.action_link}`);
}
console.log('');
