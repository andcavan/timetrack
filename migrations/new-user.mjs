#!/usr/bin/env node
// ============================================================
//  Crea un NUOVO utente TimeTrack e stampa il link di invito
//  (nessuna email inviata: il link va girato a mano).
//
//  Uso (stesse variabili d'ambiente di migrate.mjs):
//    node new-user.mjs email "Nome Cognome" username [ruolo]
//
//  Esempi:
//    node new-user.mjs mario.rossi@azienda.it "Mario Rossi" mario
//    node new-user.mjs anna@azienda.it "Anna Bianchi" anna admin
//
//  ruolo: operator (default) oppure admin.
//  Il profilo compare nell'app al primo accesso dell'utente.
// ============================================================
import { createClient } from '@supabase/supabase-js';

const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL || !KEY) {
  console.error('Imposta SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY nelle variabili d\'ambiente.');
  process.exit(1);
}

const [email, name, username, role = 'operator'] = process.argv.slice(2);
if (!email || !email.includes('@') || !name || !username) {
  console.error('Uso: node new-user.mjs email "Nome Cognome" username [operator|admin]');
  process.exit(1);
}
if (!['operator', 'admin'].includes(role)) {
  console.error('Ruolo non valido: usare "operator" oppure "admin".');
  process.exit(1);
}

const color = '#' + Math.floor(Math.random() * 16777215).toString(16).padStart(6, '0');
const supa = createClient(URL, KEY, { auth: { autoRefreshToken: false, persistSession: false } });

const { data, error } = await supa.auth.admin.generateLink({
  type: 'invite', email,
  options: { data: { name, username, role, color } }
});
if (error) {
  console.error('✗ Errore:', error.message);
  if (error.message.includes('already been registered'))
    console.error('  (utente già esistente: per un nuovo link password usa "node gen-links.mjs ' + email + '")');
  process.exit(1);
}

console.log(`\n✓ Utente creato: ${name} <${email}> — ruolo: ${role}`);
console.log('\nLink di invito da inviare (scade in ~24h):\n');
console.log('  ' + data.properties.action_link + '\n');
