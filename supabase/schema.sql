-- ============================================================
--  TimeTrack — Schema normalizzato + Supabase Auth + RLS reale
--  Eseguire nel SQL Editor del progetto Supabase. Si può RIESEGUIRE
--  a ogni nuova versione: tabelle e indici si creano solo se mancano,
--  funzioni, trigger e policy si sostituiscono. I dati restano.
--  Le tabelle convivono con la vecchia `timetrack_data`, che non
--  viene toccata.
--  test/schema.test.mjs carica questo file in un Postgres vero
--  (con test/supabase-stub.sql al posto di Supabase) e ne prova le
--  regole: RLS, guardie sui profili, ricalcolo dei costi.
--
--  DOPO questo script, nel Dashboard:
--   1. Authentication → Sign In / Up → disabilitare "Allow new users to sign up"
--   2. Authentication → Sign In / Up → Password: minimo 8 caratteri
--   3. Authentication → URL Configuration → Site URL = URL dell'app
--      (serve per i link di invito/recovery)
-- ============================================================

set client_min_messages = warning;   -- i «drop … if exists» di una riesecuzione non sono notizie

-- ═══════════════════════════════════════════════════════════
-- 1. TABELLE
--    PK testuali per le entità di dominio: gli id esistenti
--    ('c1', 'id42', ...) migrano senza rimappature. Solo gli
--    utenti cambiano id (auth.uid), mappati via legacy_id.
-- ═══════════════════════════════════════════════════════════

-- PROFILES (1:1 con auth.users)
create table if not exists public.profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  name       text not null,
  username   text unique,
  email      text default '',
  role       text not null default 'operator' check (role in ('admin','operator')),
  color      text not null default '#3A7BE8' check (color ~ '^#[0-9A-Fa-f]{6}$'),
  active     boolean not null default true,
  legacy_id  text unique
);

-- CLIENTS
create table if not exists public.clients (
  id        text primary key default gen_random_uuid()::text,
  name      text not null,
  referente text default '',
  email     text default '',
  active    boolean not null default true
);

-- PROJECTS
create table if not exists public.projects (
  id             text primary key default gen_random_uuid()::text,
  client_id      text not null references public.clients(id) on delete cascade,
  name           text not null,
  code           text default '',
  referente      text default '',
  status         text not null default 'active' check (status in ('active','completed','suspended')),
  budget_hours   numeric default 0,
  deadline       date,
  assigned_users uuid[] not null default '{}'   -- vuoto = visibile a tutti
);
create index if not exists projects_client_idx on public.projects(client_id);

-- Budget € separato: leggibile solo dagli admin
create table if not exists public.project_finance (
  project_id text primary key references public.projects(id) on delete cascade,
  budget     numeric not null default 0
);

-- ACTIVITIES
create table if not exists public.activities (
  id         text primary key default gen_random_uuid()::text,
  project_id text not null references public.projects(id) on delete cascade,
  name       text not null
);
create index if not exists activities_project_idx on public.activities(project_id);

-- RATES (user/client/project null = "tutti"; risoluzione a priorità)
create table if not exists public.rates (
  id          text primary key default gen_random_uuid()::text,
  user_id     uuid references public.profiles(id) on delete cascade,
  client_id   text references public.clients(id) on delete cascade,
  project_id  text references public.projects(id) on delete cascade,
  cost_rate   numeric,
  client_rate numeric,
  valid_from  date not null,
  valid_to    date
);

-- ENTRIES (senza colonne costo: quelle stanno in entry_costs, admin-only)
create table if not exists public.entries (
  id          text primary key default gen_random_uuid()::text,
  user_id     uuid not null references public.profiles(id) on delete cascade,
  client_id   text not null references public.clients(id) on delete cascade,
  project_id  text not null references public.projects(id) on delete cascade,
  activity_id text references public.activities(id) on delete set null,
  date        date not null,
  hours       numeric not null check (hours > 0 and hours <= 24),
  note        text default '',
  created_at  timestamptz not null default now()
);
create index if not exists entries_user_date_idx on public.entries(user_id, date);
create index if not exists entries_project_idx on public.entries(project_id);
create index if not exists entries_date_idx on public.entries(date);

-- Snapshot tariffe per entry: leggibile SOLO da admin, scritto solo dal trigger
create table if not exists public.entry_costs (
  entry_id    text primary key references public.entries(id) on delete cascade,
  cost_rate   numeric not null default 0,
  client_rate numeric not null default 0
);

-- Impostazioni applicative (contatore codici commessa) — solo admin
create table if not exists public.app_settings (
  key   text primary key,
  value text not null
);

-- ═══════════════════════════════════════════════════════════
-- 2. FUNZIONI E TRIGGER
-- ═══════════════════════════════════════════════════════════

-- Helper anti-ricorsione RLS: verifica il ruolo leggendo profiles
-- come security definer (bypassa RLS, quindi nessuna ricorsione)
create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'admin' and active
  );
$$;

-- Profilo attivo: un account sospeso (o appena nato, vedi profilo_crea)
-- non legge né scrive nulla, a parte il proprio profilo.
create or replace function public.is_active() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and active
  );
$$;

-- Risoluzione tariffe: stessa priorità del vecchio resolveRate() JS:
-- user+project > user+client > project > user > client > globale,
-- con validità temporale; a parità di priorità vince valid_from più recente.
create or replace function public.resolve_rates(
  p_user uuid, p_client text, p_project text, p_date date,
  out o_cost numeric, out o_client numeric
) language plpgsql stable security definer set search_path = public as $$
begin
  with ranked as (
    select cost_rate, client_rate, valid_from,
      case
        when user_id = p_user and project_id = p_project and client_id is null then 0
        when user_id = p_user and client_id = p_client and project_id is null then 1
        when user_id is null and project_id = p_project and client_id is null then 2
        when user_id = p_user and client_id is null and project_id is null then 3
        when user_id is null and client_id = p_client and project_id is null then 4
        when user_id is null and client_id is null and project_id is null then 5
        else 9
      end as prio
    from rates
    where valid_from <= p_date and (valid_to is null or valid_to >= p_date)
  )
  select
    (select cost_rate   from ranked where prio < 9 and cost_rate   is not null order by prio, valid_from desc limit 1),
    (select client_rate from ranked where prio < 9 and client_rate is not null order by prio, valid_from desc limit 1)
  into o_cost, o_client;
  o_cost := coalesce(o_cost, 0);
  o_client := coalesce(o_client, 0);
end $$;

-- Ricalcola e salva il costo/ricavo di UNA entry (helper condiviso da
-- entries_snapshot_rates e rates_recompute_affected).
create or replace function public.recompute_entry_cost(p_entry_id text) returns void
language plpgsql security definer set search_path = public as $$
declare c numeric; r numeric; e record;
begin
  select user_id, client_id, project_id, date into e from public.entries where id = p_entry_id;
  if not found then return; end if;
  select o_cost, o_client into c, r
  from public.resolve_rates(e.user_id, e.client_id, e.project_id, e.date);
  insert into public.entry_costs(entry_id, cost_rate, client_rate)
  values (p_entry_id, c, r)
  on conflict (entry_id) do update
    set cost_rate = excluded.cost_rate, client_rate = excluded.client_rate;
end $$;

-- Snapshot tariffe su insert/update entry (server-side: gli operator
-- non vedono mai le tariffe, ma i costi vengono comunque registrati)
create or replace function public.snapshot_entry_rates() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform public.recompute_entry_cost(new.id);
  return new;
end $$;

drop trigger if exists entries_snapshot_rates on public.entries;
create trigger entries_snapshot_rates
  after insert or update of date, project_id, client_id, user_id
  on public.entries
  for each row execute function public.snapshot_entry_rates();

-- Ricalcola entry_costs per tutte le entries potenzialmente interessate
-- da una modifica in `rates` (insert/update/delete): stessa data range
-- (unione OLD/NEW) e stesso ambito user/client/project (rispettando i
-- NULL = "tutti"). Cosi' creare/modificare/eliminare una tariffa aggiorna
-- anche le registrazioni gia' esistenti nel periodo interessato.
create or replace function public.rates_recompute_affected() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_from date; v_to date; v_user uuid; v_client text; v_project text; r record;
begin
  if tg_op = 'DELETE' then
    v_from := old.valid_from; v_to := old.valid_to;
    v_user := old.user_id; v_client := old.client_id; v_project := old.project_id;
  elsif tg_op = 'INSERT' then
    v_from := new.valid_from; v_to := new.valid_to;
    v_user := new.user_id; v_client := new.client_id; v_project := new.project_id;
  else
    v_from := least(old.valid_from, new.valid_from);
    v_to := case when old.valid_to is null or new.valid_to is null then null
                 else greatest(old.valid_to, new.valid_to) end;
  end if;

  for r in
    select id from public.entries e
    where e.date >= v_from and (v_to is null or e.date <= v_to)
      and (
        (tg_op = 'UPDATE' and (
          ((old.user_id is null or e.user_id = old.user_id)
           and (old.client_id is null or e.client_id = old.client_id)
           and (old.project_id is null or e.project_id = old.project_id))
          or
          ((new.user_id is null or e.user_id = new.user_id)
           and (new.client_id is null or e.client_id = new.client_id)
           and (new.project_id is null or e.project_id = new.project_id))
        ))
        or
        (tg_op <> 'UPDATE'
          and (v_user is null or e.user_id = v_user)
          and (v_client is null or e.client_id = v_client)
          and (v_project is null or e.project_id = v_project))
      )
  loop
    perform public.recompute_entry_cost(r.id);
  end loop;

  return coalesce(new, old);
end $$;

drop trigger if exists rates_recompute on public.rates;
create trigger rates_recompute
  after insert or update or delete on public.rates
  for each row execute function public.rates_recompute_affected();

-- Ricalcolo massivo di entry_costs per tutte le entries (funzione di
-- servizio, admin-only): corregge derive pregresse o dopo import massivi
-- con trigger disattivati.
create or replace function public.recompute_all_entry_costs() returns integer
language plpgsql security definer set search_path = public as $$
declare n integer := 0; r record;
begin
  if not public.is_admin() then
    raise exception 'Operazione riservata agli amministratori';
  end if;
  for r in select id from public.entries loop
    perform public.recompute_entry_cost(r.id);
    n := n + 1;
  end loop;
  return n;
end $$;

-- Protezione campi profilo. Chi passa dall'app o dall'API (ruoli
-- `authenticated`/`anon`) e non è admin non cambia ruolo, stato, email,
-- legacy_id né id: niente auto-promozione ad admin. Dal SQL Editor e con la
-- service_role (script in migrations/, Edge Function) il controllo non vale:
-- lì auth.uid() è nullo e l'amministratore del progetto deve poter
-- rimettere a posto un profilo. L'email è dell'account di accesso: il link
-- di reimpostazione parte da auth.users, e un'email del profilo cambiata a
-- mano farebbe credere all'app di parlare con un altro.
-- L'ultimo admin attivo non si declassa e non si sospende, da nessuna parte.
drop trigger if exists profiles_protect on public.profiles;
drop function if exists public.protect_profile_fields();
-- Niente security definer qui: il controllo legge current_user, che dentro
-- una funzione security definer sarebbe sempre il proprietario.
create or replace function public.profiles_guardia() returns trigger
language plpgsql set search_path = public as $$
begin
  -- if annidati: Postgres non garantisce l'ordine di valutazione di un `and`,
  -- e is_admin() non è eseguibile da tutti i ruoli
  if current_user in ('authenticated', 'anon') then
    if (new.role is distinct from old.role
        or new.active is distinct from old.active
        or new.legacy_id is distinct from old.legacy_id
        or new.email is distinct from old.email
        or new.id <> old.id)
       and not public.is_admin() then
      raise exception 'Campo protetto: modificabile solo da un amministratore';
    end if;
  end if;
  if old.role = 'admin' and old.active
     and (new.role is distinct from 'admin' or not new.active)
     and not exists (select 1 from public.profiles p
                     where p.id <> old.id and p.role = 'admin' and p.active) then
    raise exception 'Deve restare almeno un amministratore attivo';
  end if;
  return new;
end $$;
drop trigger if exists profiles_guardia on public.profiles;
create trigger profiles_guardia before update on public.profiles
  for each row execute function public.profiles_guardia();

-- E non si elimina: né dall'API né cancellando il suo utente nel Dashboard
-- (Authentication → Users), che porta via il profilo con sé.
create or replace function public.profiles_ultimo_admin() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if old.role = 'admin' and old.active
     and not exists (select 1 from public.profiles p
                     where p.id <> old.id and p.role = 'admin' and p.active) then
    raise exception 'Deve restare almeno un amministratore attivo';
  end if;
  return old;
end $$;
drop trigger if exists profiles_ultimo_admin on public.profiles;
create trigger profiles_ultimo_admin before delete on public.profiles
  for each row execute function public.profiles_ultimo_admin();

-- Auto-creazione profilo alla creazione dell'utente auth.
-- Ruolo e stato NON arrivano dai metadata dell'utente (chiunque si registri
-- li può scrivere): il profilo nasce operator SOSPESO, e ruolo, username,
-- colore e stato li assegna poi un admin (dall'app o dalla Edge Function
-- invite-user, con il suo token). Così anche una registrazione pubblica
-- lasciata aperta per sbaglio nel Dashboard non apre i dati a nessuno.
-- Unica eccezione: il primissimo profilo diventa admin attivo (è l'utente
-- creato a mano nel Dashboard su un progetto nuovo).
create or replace function public.profilo_crea(uid uuid, mail text, nome text)
returns void language plpgsql security definer set search_path = public as $$
declare primo boolean;
begin
  primo := not exists (select 1 from public.profiles);
  insert into public.profiles(id, name, email, role, active)
  values (
    uid,
    coalesce(nullif(nome, ''), split_part(coalesce(mail, ''), '@', 1)),
    coalesce(mail, ''),
    case when primo then 'admin' else 'operator' end,
    primo
  )
  on conflict (id) do nothing;
end $$;
revoke all on function public.profilo_crea(uuid, text, text) from public, anon, authenticated;

create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform public.profilo_crea(new.id, new.email, new.raw_user_meta_data->>'name');
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- Contatore codice commessa (atomico, solo admin)
create or replace function public.next_project_num() returns integer
language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  if not public.is_admin() then
    raise exception 'Operazione riservata agli amministratori';
  end if;
  insert into public.app_settings(key, value) values ('next_project_num', '1')
  on conflict (key) do nothing;
  update public.app_settings set value = (value::integer + 1)::text
  where key = 'next_project_num'
  returning value::integer - 1 into n;
  return n;
end $$;

-- Le funzioni esposte sono eseguibili solo da utenti autenticati
revoke all on function public.is_admin() from public, anon;
revoke all on function public.is_active() from public, anon;
revoke all on function public.next_project_num() from public, anon;
revoke all on function public.recompute_all_entry_costs() from public, anon;
-- Funzioni interne (trigger e calcolo tariffe): security definer, quindi
-- chiamarle via /rest/v1/rpc/… scavalcherebbe la RLS. resolve_rates() in
-- particolare restituirebbe le tariffe a un operator. Le usano solo i
-- trigger e le altre funzioni security definer, che non hanno bisogno del
-- grant.
revoke all on function public.resolve_rates(uuid, text, text, date) from public, anon, authenticated;
revoke all on function public.recompute_entry_cost(text) from public, anon, authenticated;
revoke all on function public.snapshot_entry_rates() from public, anon, authenticated;
revoke all on function public.rates_recompute_affected() from public, anon, authenticated;
revoke all on function public.handle_new_user() from public, anon, authenticated;
revoke all on function public.profiles_ultimo_admin() from public, anon, authenticated;
revoke all on function public.profiles_guardia() from public, anon, authenticated;
grant execute on function public.is_admin() to authenticated;
grant execute on function public.is_active() to authenticated;
grant execute on function public.next_project_num() to authenticated;
grant execute on function public.recompute_all_entry_costs() to authenticated;

-- ═══════════════════════════════════════════════════════════
-- 3. ROW LEVEL SECURITY
--    Nessuna policy per `anon`: la anon key senza sessione non
--    vede e non scrive NULLA.
-- ═══════════════════════════════════════════════════════════
alter table public.profiles        enable row level security;
alter table public.clients         enable row level security;
alter table public.projects        enable row level security;
alter table public.project_finance enable row level security;
alter table public.activities      enable row level security;
alter table public.rates           enable row level security;
alter table public.entries         enable row level security;
alter table public.entry_costs     enable row level security;
alter table public.app_settings    enable row level security;

-- Il vecchio blob della 1.x (se c'è ancora): resta come archivio, ma la
-- chiave pubblica non deve più leggerlo né scriverlo (conteneva anche gli
-- hash delle password). Lo legge solo chi entra dal Dashboard.
do $$
declare pol text;
begin
  if to_regclass('public.timetrack_data') is not null then
    for pol in select policyname from pg_policies where schemaname = 'public' and tablename = 'timetrack_data' loop
      execute format('drop policy %I on public.timetrack_data', pol);
    end loop;
    alter table public.timetrack_data enable row level security;
    revoke all on public.timetrack_data from anon, authenticated;
  end if;
end $$;

-- Difesa in profondità: revoca i grant di default al ruolo anon
revoke all on public.profiles, public.clients, public.projects,
  public.project_finance, public.activities, public.rates,
  public.entries, public.entry_costs, public.app_settings from anon;

-- PROFILES: gli utenti attivi leggono tutti i profili (nomi/colori servono
-- alla UI), un sospeso solo il proprio (l'app gli dice «Account sospeso»);
-- update del proprio profilo o da admin (role/active protetti dal trigger);
-- insert/delete solo via trigger/cascade (nessuna policy = negato)
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles
  for select to authenticated using (id = auth.uid() or public.is_active());
drop policy if exists profiles_update on public.profiles;
create policy profiles_update on public.profiles
  for update to authenticated
  using (id = auth.uid() or public.is_admin())
  with check (id = auth.uid() or public.is_admin());

-- CLIENTS / PROJECTS / ACTIVITIES: lettura utenti attivi, scrittura solo admin
drop policy if exists clients_select on public.clients;
create policy clients_select on public.clients
  for select to authenticated using (public.is_active());
drop policy if exists clients_admin_write on public.clients;
create policy clients_admin_write on public.clients
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists projects_select on public.projects;
create policy projects_select on public.projects
  for select to authenticated using (public.is_active());
drop policy if exists projects_admin_write on public.projects;
create policy projects_admin_write on public.projects
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists activities_select on public.activities;
create policy activities_select on public.activities
  for select to authenticated using (public.is_active());
drop policy if exists activities_admin_write on public.activities;
create policy activities_admin_write on public.activities
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- PROJECT_FINANCE / RATES / APP_SETTINGS: tutto solo admin
drop policy if exists finance_admin on public.project_finance;
create policy finance_admin on public.project_finance
  for all to authenticated using (public.is_admin()) with check (public.is_admin());
drop policy if exists rates_admin on public.rates;
create policy rates_admin on public.rates
  for all to authenticated using (public.is_admin()) with check (public.is_admin());
drop policy if exists settings_admin on public.app_settings;
create policy settings_admin on public.app_settings
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- ENTRY_COSTS: lettura solo admin; scrittura solo dal trigger (security definer)
drop policy if exists entry_costs_admin_select on public.entry_costs;
create policy entry_costs_admin_select on public.entry_costs
  for select to authenticated using (public.is_admin());

-- ENTRIES: operator attivo solo le proprie, admin tutte; un sospeso nessuna
drop policy if exists entries_select on public.entries;
create policy entries_select on public.entries
  for select to authenticated
  using ((user_id = auth.uid() and public.is_active()) or public.is_admin());
drop policy if exists entries_insert on public.entries;
create policy entries_insert on public.entries
  for insert to authenticated
  with check ((user_id = auth.uid() and public.is_active()) or public.is_admin());
drop policy if exists entries_update on public.entries;
create policy entries_update on public.entries
  for update to authenticated
  using ((user_id = auth.uid() and public.is_active()) or public.is_admin())
  with check ((user_id = auth.uid() and public.is_active()) or public.is_admin());
drop policy if exists entries_delete on public.entries;
create policy entries_delete on public.entries
  for delete to authenticated
  using ((user_id = auth.uid() and public.is_active()) or public.is_admin());

-- ═══════════════════════════════════════════════════════════
-- 4. REALTIME (rispetta RLS per gli utenti autenticati)
--    Aggiunge solo le tabelle che mancano: rieseguire non dà errori.
-- ═══════════════════════════════════════════════════════════
do $$
declare t text;
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    return;   -- Postgres senza Supabase (test): niente Realtime
  end if;
  foreach t in array array['profiles','clients','projects','activities',
                           'entries','rates','project_finance','entry_costs'] loop
    if not exists (select 1 from pg_publication_tables
                   where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

-- ═══════════════════════════════════════════════════════════
-- 5. VERIFICA
-- ═══════════════════════════════════════════════════════════
select tablename, rowsecurity from pg_tables
where schemaname = 'public'
  and tablename in ('profiles','clients','projects','project_finance',
                    'activities','rates','entries','entry_costs','app_settings');
