// ============================================================
//  supabase/schema.sql contro un Postgres vero.
//
//  Carica test/supabase-stub.sql (auth.users, auth.uid(), i ruoli
//  dell'API) e poi lo schema, due volte: deve potersi rieseguire.
//  Poi prova le regole che contano facendo le chiamate COME un utente
//  dell'app (ruolo `authenticated` e il suo id dove auth.uid() lo
//  legge): il superutente ignora la RLS, e un test di permessi fatto
//  da lui non proverebbe niente.
//
//  Nessuna dipendenza: si parla con `psql`. Attivo solo se la
//  variabile TIMETRACK_PG contiene i parametri di connessione (es.
//  "host=localhost port=5432 user=postgres"); altrimenti i test si
//  dichiarano saltati. In CI il servizio c'è (.github/workflows/test.yml).
//
//  Uso:  TIMETRACK_PG="host=localhost user=postgres" node --test test/schema.test.mjs
// ============================================================
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const CONN = process.env.TIMETRACK_PG || '';
const DIR = path.dirname(fileURLToPath(import.meta.url));
const STUB = readFileSync(path.join(DIR, 'supabase-stub.sql'), 'utf8');
const SCHEMA = readFileSync(path.join(DIR, '..', 'supabase', 'schema.sql'), 'utf8');
const DB = `timetrack_test_${process.pid}`;

function psql(db, sql) {
  try {
    return execFileSync('psql', [`${CONN} dbname=${db}`, '-v', 'ON_ERROR_STOP=1', '-q', '-At', '-f', '-'],
      { input: 'set client_min_messages = warning;\n' + sql, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch (e) {
    const msg = String(e.stderr || e.message).split('\n').filter(r => /ERROR/.test(r)).join('\n');
    throw new Error(msg || String(e.message));
  }
}
const sql = q => psql(DB, q);
// Le stesse query come un utente dell'app (o come anon / service_role).
const as = uid => q => sql(`set role authenticated; select set_config('request.jwt.claim.sub', '${uid}', false) \\g /dev/null\n${q}`);
const asRole = role => q => sql(`set role ${role};\n${q}`);
const rejects = (fn, re) => assert.throws(fn, re);

const A1 = '00000000-0000-0000-0000-0000000000a1';
const A2 = '00000000-0000-0000-0000-0000000000a2';
const OP = '00000000-0000-0000-0000-00000000000b';
const X = '00000000-0000-0000-0000-00000000000c';
const newAuthUser = (id, email, meta = {}) =>
  sql(`insert into auth.users(id, email, raw_user_meta_data) values ('${id}', '${email}', '${JSON.stringify(meta)}'::jsonb);`);
const profile = id => sql(`select role || '|' || active from public.profiles where id = '${id}';`);

describe('supabase/schema.sql', { skip: !CONN && 'TIMETRACK_PG non impostata: test su Postgres saltati' }, () => {
  before(() => {
    psql('postgres', `drop database if exists ${DB}; create database ${DB};`);
    sql(STUB);
    sql(SCHEMA);
  });
  after(() => { psql('postgres', `drop database if exists ${DB};`); });

  test('tutte le tabelle hanno la RLS attiva', () => {
    const rows = sql(`select tablename || '=' || rowsecurity from pg_tables where schemaname = 'public' order by 1;`).split('\n');
    assert.equal(rows.length, 12);
    rows.forEach(r => assert.match(r, /=(t|true)$/, r));
  });

  test('il primo utente diventa admin attivo, gli altri operator sospesi', () => {
    newAuthUser(A1, 'admin@x.it', { name: 'Admin' });
    // I metadata dicono "admin": non devono contare
    newAuthUser(OP, 'op@x.it', { name: 'Op', role: 'admin', legacy_id: 'u9' });
    assert.equal(profile(A1), 'admin|true');
    assert.equal(profile(OP), 'operator|false');
    assert.equal(sql(`select coalesce(legacy_id, '-') from public.profiles where id = '${OP}';`), '-');
  });

  test('dati di prova scritti dall\'admin, sotto RLS', () => {
    as(A1)(`
      insert into public.clients(id, name) values ('c1', 'Cliente');
      insert into public.projects(id, client_id, name) values ('p1', 'c1', 'Commessa');
      insert into public.project_finance(project_id, budget) values ('p1', 1000);
      insert into public.rates(id, cost_rate, client_rate, valid_from) values ('r1', 30, 50, '2026-01-01');
      insert into public.entries(id, user_id, client_id, project_id, date, hours) values ('e1', '${A1}', 'c1', 'p1', '2026-03-01', 2);
    `);
    assert.equal(sql(`select cost_rate || '/' || client_rate from public.entry_costs where entry_id = 'e1';`), '30/50');
  });

  test('un sospeso vede solo il proprio profilo e non scrive ore', () => {
    const op = as(OP);
    assert.equal(op(`select count(*) from public.profiles;`), '1');
    assert.equal(op(`select count(*) from public.clients;`), '0');
    assert.equal(op(`select count(*) from public.projects;`), '0');
    rejects(() => op(`insert into public.entries(id, user_id, client_id, project_id, date, hours) values ('e2', '${OP}', 'c1', 'p1', '2026-03-02', 1);`), /row-level security/);
  });

  test('un non-admin non si attiva e non si promuove da solo', () => {
    rejects(() => as(OP)(`update public.profiles set active = true where id = '${OP}';`), /Campo protetto/);
    rejects(() => as(OP)(`update public.profiles set role = 'admin' where id = '${OP}';`), /Campo protetto/);
    rejects(() => as(OP)(`update public.profiles set email = 'admin@x.it' where id = '${OP}';`), /Campo protetto/);
    as(OP)(`update public.profiles set name = 'Operatore' where id = '${OP}';`);
    assert.equal(sql(`select name from public.profiles where id = '${OP}';`), 'Operatore');
  });

  test('l\'admin attiva l\'operator, che vede solo le sue ore e nessuna tariffa', () => {
    as(A1)(`update public.profiles set active = true, username = 'op' where id = '${OP}';`);
    const op = as(OP);
    op(`insert into public.entries(id, user_id, client_id, project_id, date, hours) values ('e2', '${OP}', 'c1', 'p1', '2026-03-02', 1);`);
    assert.equal(op(`select string_agg(id, ',') from public.entries;`), 'e2');
    assert.equal(op(`select count(*) from public.rates;`), '0');
    assert.equal(op(`select count(*) from public.entry_costs;`), '0');
    assert.equal(op(`select count(*) from public.project_finance;`), '0');
    // ...ma il costo della sua ora viene registrato dal trigger
    assert.equal(sql(`select cost_rate from public.entry_costs where entry_id = 'e2';`), '30');
    rejects(() => op(`insert into public.entries(id, user_id, client_id, project_id, date, hours) values ('e3', '${A1}', 'c1', 'p1', '2026-03-02', 1);`), /row-level security/);
    rejects(() => op(`select public.next_project_num();`), /riservata agli amministratori/);
  });

  test('note di commessa e attività: vuote per default, scritte dall\'admin, lette dall\'operator', () => {
    assert.equal(sql(`select note = '' from public.projects where id = 'p1';`), 't');
    as(A1)(`
      update public.projects set note = E'Prima riga\\nseconda riga' where id = 'p1';
      insert into public.activities(id, project_id, name, note) values ('a1', 'p1', 'Montaggio', 'In cantiere');
      insert into public.activities(id, project_id, name) values ('a2', 'p1', 'Progetto');
    `);
    const op = as(OP);
    assert.equal(op(`select note from public.projects where id = 'p1';`), 'Prima riga\nseconda riga');
    assert.equal(op(`select string_agg(id || '=' || note, ',' order by id) from public.activities;`), 'a1=In cantiere,a2=');
    // La RLS nasconde le righe all'update dell'operator: nessuna riga cambia
    op(`update public.projects set note = 'x' where id = 'p1'; update public.activities set note = 'x';`);
    assert.equal(sql(`select note from public.projects where id = 'p1';`), 'Prima riga\nseconda riga');
    assert.equal(sql(`select note from public.activities where id = 'a1';`), 'In cantiere');
    rejects(() => op(`insert into public.activities(id, project_id, name, note) values ('a3', 'p1', 'X', 'y');`), /row-level security/);
  });

  test('orario dalle/alle: le ore le calcola il server, un orario a metà o rovesciato no', () => {
    const op = as(OP);
    op(`insert into public.entries(id, user_id, client_id, project_id, date, hours, start_time, end_time)
        values ('e3', '${OP}', 'c1', 'p1', '2026-03-03', 1, '08:30', '12:50');`);
    assert.equal(sql(`select hours from public.entries where id = 'e3';`), '4.33');
    op(`update public.entries set end_time = '09:00' where id = 'e3';`);
    assert.equal(sql(`select hours from public.entries where id = 'e3';`), '0.50');
    // Senza orario le ore restano quelle scritte
    op(`update public.entries set start_time = null, end_time = null, hours = 3 where id = 'e3';`);
    assert.equal(sql(`select hours from public.entries where id = 'e3';`), '3');
    rejects(() => op(`update public.entries set start_time = '08:00' where id = 'e3';`), /entries_orario_check/);
    rejects(() => op(`update public.entries set start_time = '12:00', end_time = '08:00' where id = 'e3';`), /check constraint/);
    op(`delete from public.entries where id = 'e3';`);
  });

  test('timer: ognuno vede e scrive solo il proprio, uno per utente', () => {
    const op = as(OP);
    op(`insert into public.timers(user_id, project_id, activity_id, note) values ('${OP}', 'p1', 'a1', 'via');`);
    rejects(() => op(`insert into public.timers(user_id, project_id) values ('${OP}', 'p1');`), /duplicate key/);
    rejects(() => op(`insert into public.timers(user_id, project_id) values ('${A1}', 'p1');`), /row-level security/);
    assert.equal(op(`select count(*) from public.timers;`), '1');
    // Nemmeno l'admin vede il timer di un altro
    assert.equal(as(A1)(`select count(*) from public.timers;`), '0');
    op(`delete from public.timers where user_id = '${OP}';`);
    assert.equal(sql(`select count(*) from public.timers;`), '0');
  });

  test('modelli di commessa: solo admin', () => {
    as(A1)(`insert into public.project_templates(id, name, activities)
            values ('t1', 'Impianto', '[{"name":"Progetto","note":""},{"name":"Montaggio","note":"In cantiere"}]');`);
    assert.equal(as(OP)(`select count(*) from public.project_templates;`), '0');
    rejects(() => as(OP)(`insert into public.project_templates(name) values ('X');`), /row-level security/);
    rejects(() => as(A1)(`insert into public.project_templates(name) values ('  ');`), /check constraint/);
    rejects(() => as(A1)(`insert into public.project_templates(name, activities) values ('X', '{}');`), /check constraint/);
  });

  test('registro delle modifiche: scritto dal trigger con autore e campi cambiati, letto solo dall\'admin', () => {
    const op = as(OP);
    op(`update public.entries set hours = 1.5, note = 'corretta' where id = 'e2';`);
    assert.equal(sql(`select actor || '|' || action || '|' || old_data::text || '|' || new_data::text from public.audit_log
                      where table_name = 'entries' and row_id = 'e2' order by id desc limit 1;`),
      `${OP}|update|{"note": "", "hours": 1}|{"note": "corretta", "hours": 1.5}`);
    // Un update che non cambia nulla non lascia traccia
    const n = sql(`select count(*) from public.audit_log;`);
    op(`update public.entries set hours = 1.5 where id = 'e2';`);
    assert.equal(sql(`select count(*) from public.audit_log;`), n);
    // Creazioni ed eliminazioni, anche dell'admin, con la riga intera
    assert.equal(sql(`select action || ':' || (new_data->>'name') from public.audit_log where table_name = 'projects' and row_id = 'p1' order by id limit 1;`), 'insert:Commessa');
    assert.equal(sql(`select actor from public.audit_log where table_name = 'project_finance' and row_id = 'p1' limit 1;`), A1);
    op(`insert into public.entries(id, user_id, client_id, project_id, date, hours) values ('e9', '${OP}', 'c1', 'p1', '2026-03-09', 1);
        delete from public.entries where id = 'e9';`);
    assert.equal(sql(`select string_agg(action, ',' order by id) from public.audit_log where row_id = 'e9';`), 'insert,delete');
    assert.equal(sql(`select old_data->>'hours' from public.audit_log where row_id = 'e9' and action = 'delete';`), '1');
    // L'operator non lo legge e nessuno lo scrive o lo cancella dall'API
    assert.equal(op(`select count(*) from public.audit_log;`), '0');
    assert.ok(Number(as(A1)(`select count(*) from public.audit_log;`)) > 0);
    rejects(() => op(`insert into public.audit_log(table_name, row_id, action) values ('entries', 'x', 'insert');`), /row-level security/);
    const m = sql(`select count(*) from public.audit_log where actor is not null;`);
    as(A1)(`delete from public.audit_log; update public.audit_log set actor = null;`);
    assert.equal(sql(`select count(*) from public.audit_log where actor is not null;`), m);
  });

  test('modificare una tariffa ricalcola le ore già registrate', () => {
    as(A1)(`update public.rates set cost_rate = 40 where id = 'r1';`);
    assert.equal(sql(`select string_agg(cost_rate::text, ',' order by entry_id) from public.entry_costs;`), '40,40');
  });

  test('l\'ultimo admin attivo non si declassa, non si sospende, non si elimina', () => {
    rejects(() => as(A1)(`update public.profiles set role = 'operator' where id = '${A1}';`), /almeno un amministratore/);
    rejects(() => as(A1)(`update public.profiles set active = false where id = '${A1}';`), /almeno un amministratore/);
    // Nemmeno cancellando l'utente dal Dashboard (superutente, cascade da auth.users)
    rejects(() => sql(`delete from auth.users where id = '${A1}';`), /almeno un amministratore/);
    // Con un secondo admin, sì
    newAuthUser(A2, 'admin2@x.it');
    sql(`update public.profiles set role = 'admin', active = true where id = '${A2}';`);
    as(A1)(`update public.profiles set active = false where id = '${A2}';`);
    assert.equal(profile(A2), 'admin|false');
  });

  test('la service_role (script e Edge Function) assegna ruolo e stato', () => {
    newAuthUser(X, 'x@x.it');
    asRole('service_role')(`update public.profiles set role = 'admin', active = true where id = '${X}';`);
    assert.equal(profile(X), 'admin|true');
  });

  test('le funzioni interne non si chiamano dall\'API', () => {
    rejects(() => as(OP)(`select * from public.resolve_rates('${OP}', 'c1', 'p1', '2026-03-01');`), /permission denied/);
    rejects(() => as(OP)(`select public.recompute_entry_cost('e1');`), /permission denied/);
    rejects(() => asRole('anon')(`select * from public.resolve_rates(null, 'c1', 'p1', '2026-03-01');`), /permission denied/);
  });

  test('il vecchio blob timetrack_data non è più raggiungibile con la chiave pubblica', () => {
    sql(`create table public.timetrack_data (id int primary key, data jsonb);
         alter table public.timetrack_data enable row level security;
         create policy "Allow all operations" on public.timetrack_data for all using (true) with check (true);
         insert into public.timetrack_data values (1, '{}');`);
    assert.equal(asRole('anon')(`select count(*) from public.timetrack_data;`), '1');
    sql(SCHEMA);
    rejects(() => asRole('anon')(`select count(*) from public.timetrack_data;`), /permission denied/);
    rejects(() => as(A1)(`select count(*) from public.timetrack_data;`), /permission denied/);
    assert.equal(sql(`select count(*) from public.timetrack_data;`), '1');
    sql(`drop table public.timetrack_data;`);
  });

  test('senza sessione (anon) non si legge niente', () => {
    for (const t of ['profiles', 'clients', 'entries', 'rates']) {
      rejects(() => asRole('anon')(`select count(*) from public.${t};`), /permission denied/);
    }
  });

  test('un database di prima della 4.3.0 riceve le colonne delle note', () => {
    sql(`alter table public.activities drop column note; alter table public.projects drop column note;`);
    sql(SCHEMA);
    assert.equal(sql(`select string_agg(table_name || '.' || column_name || ':' || is_nullable || ':' || column_default, ',' order by table_name)
      from information_schema.columns where table_schema = 'public' and column_name = 'note' and table_name in ('projects','activities');`),
      "activities.note:NO:''::text,projects.note:NO:''::text");
    assert.equal(sql(`select count(*) from public.activities where note = '';`), '2');
  });

  test('un database di prima della 5.0.0 riceve l\'orario delle registrazioni', () => {
    sql(`alter table public.entries drop column start_time, drop column end_time;`);
    sql(SCHEMA);
    assert.equal(sql(`select string_agg(column_name || ':' || data_type, ',' order by column_name) from information_schema.columns
      where table_schema = 'public' and table_name = 'entries' and column_name in ('start_time','end_time');`),
      'end_time:time without time zone,start_time:time without time zone');
    assert.equal(sql(`select count(*) from pg_constraint where conname = 'entries_orario_check';`), '1');
  });

  test('lo schema si riesegue senza errori e senza perdere dati', () => {
    sql(SCHEMA);
    assert.equal(sql(`select count(*) from public.entries;`), '2');
    assert.equal(profile(A1), 'admin|true');
    assert.equal(sql(`select count(*) from pg_publication_tables where pubname = 'supabase_realtime';`), '10');
    assert.equal(sql(`select count(*) from pg_trigger where tgname like '%_audit' and not tgisinternal;`), '7');
    assert.equal(sql(`select count(*) from pg_trigger where tgrelid = 'public.profiles'::regclass and not tgisinternal;`), '2');
  });
});
