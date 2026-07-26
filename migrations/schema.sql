-- ============================================================
--  TimeTrack — Schema normalizzato + Supabase Auth + RLS reale
--  Eseguire nel SQL Editor del progetto Supabase (una volta sola).
--  Le nuove tabelle convivono con la vecchia `timetrack_data`,
--  che resta intoccata fino a fine migrazione.
--
--  DOPO questo script, nel Dashboard:
--   1. Authentication → Sign In / Up → disabilitare "Allow new users to sign up"
--   2. Authentication → Sign In / Up → Password: minimo 8 caratteri
--   3. Authentication → URL Configuration → Site URL = URL dell'app
--      (serve per i link di invito/recovery)
-- ============================================================

-- ═══════════════════════════════════════════════════════════
-- 1. TABELLE
--    PK testuali per le entità di dominio: gli id esistenti
--    ('c1', 'id42', ...) migrano senza rimappature. Solo gli
--    utenti cambiano id (auth.uid), mappati via legacy_id.
-- ═══════════════════════════════════════════════════════════

-- PROFILES (1:1 con auth.users)
create table public.profiles (
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
create table public.clients (
  id        text primary key default gen_random_uuid()::text,
  name      text not null,
  referente text default '',
  email     text default '',
  active    boolean not null default true
);

-- PROJECTS
create table public.projects (
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
create index projects_client_idx on public.projects(client_id);

-- Budget € separato: leggibile solo dagli admin
create table public.project_finance (
  project_id text primary key references public.projects(id) on delete cascade,
  budget     numeric not null default 0
);

-- ACTIVITIES
create table public.activities (
  id         text primary key default gen_random_uuid()::text,
  project_id text not null references public.projects(id) on delete cascade,
  name       text not null
);
create index activities_project_idx on public.activities(project_id);

-- RATES (user/client/project null = "tutti"; risoluzione a priorità)
create table public.rates (
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
create table public.entries (
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
create index entries_user_date_idx on public.entries(user_id, date);
create index entries_project_idx on public.entries(project_id);
create index entries_date_idx on public.entries(date);

-- Snapshot tariffe per entry: leggibile SOLO da admin, scritto solo dal trigger
create table public.entry_costs (
  entry_id    text primary key references public.entries(id) on delete cascade,
  cost_rate   numeric not null default 0,
  client_rate numeric not null default 0
);

-- Impostazioni applicative (contatore codici commessa) — solo admin
create table public.app_settings (
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

-- Protezione campi profilo: un non-admin non può cambiare role/active/legacy_id
-- (niente auto-promozione ad admin, nemmeno via API diretta con la anon key)
create or replace function public.protect_profile_fields() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then
    if new.role is distinct from old.role
       or new.active is distinct from old.active
       or new.legacy_id is distinct from old.legacy_id then
      raise exception 'Campo protetto: modificabile solo da un amministratore';
    end if;
  end if;
  return new;
end $$;

create trigger profiles_protect before update on public.profiles
  for each row execute function public.protect_profile_fields();

-- Auto-creazione profilo alla creazione dell'utente auth
-- (i metadata role/name/... sono impostati SOLO dallo script di migrazione
--  o dal Dashboard con service_role; il signup pubblico va disabilitato)
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles(id, name, username, email, role, color, legacy_id)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'name', new.email),
    nullif(new.raw_user_meta_data->>'username',''),
    coalesce(new.email, ''),
    coalesce(new.raw_user_meta_data->>'role', 'operator'),
    coalesce(nullif(new.raw_user_meta_data->>'color',''), '#3A7BE8'),
    nullif(new.raw_user_meta_data->>'legacy_id','')
  )
  on conflict (id) do nothing;
  return new;
end $$;

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
revoke all on function public.next_project_num() from public, anon;
revoke all on function public.recompute_all_entry_costs() from public, anon;
grant execute on function public.is_admin() to authenticated;
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

-- Difesa in profondità: revoca i grant di default al ruolo anon
revoke all on public.profiles, public.clients, public.projects,
  public.project_finance, public.activities, public.rates,
  public.entries, public.entry_costs, public.app_settings from anon;

-- PROFILES: tutti gli autenticati leggono (nomi/colori servono alla UI);
-- update del proprio profilo o da admin (role/active protetti dal trigger);
-- insert/delete solo via trigger/cascade (nessuna policy = negato)
create policy profiles_select on public.profiles
  for select to authenticated using (true);
create policy profiles_update on public.profiles
  for update to authenticated
  using (id = auth.uid() or public.is_admin())
  with check (id = auth.uid() or public.is_admin());

-- CLIENTS / PROJECTS / ACTIVITIES: lettura autenticati, scrittura solo admin
create policy clients_select on public.clients
  for select to authenticated using (true);
create policy clients_admin_write on public.clients
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

create policy projects_select on public.projects
  for select to authenticated using (true);
create policy projects_admin_write on public.projects
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

create policy activities_select on public.activities
  for select to authenticated using (true);
create policy activities_admin_write on public.activities
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- PROJECT_FINANCE / RATES / APP_SETTINGS: tutto solo admin
create policy finance_admin on public.project_finance
  for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy rates_admin on public.rates
  for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy settings_admin on public.app_settings
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- ENTRY_COSTS: lettura solo admin; scrittura solo dal trigger (security definer)
create policy entry_costs_admin_select on public.entry_costs
  for select to authenticated using (public.is_admin());

-- ENTRIES: operator solo le proprie, admin tutte; insert bloccato se sospeso
create policy entries_select on public.entries
  for select to authenticated
  using (user_id = auth.uid() or public.is_admin());
create policy entries_insert on public.entries
  for insert to authenticated
  with check (
    (user_id = auth.uid() or public.is_admin())
    and exists (select 1 from public.profiles where id = auth.uid() and active)
  );
create policy entries_update on public.entries
  for update to authenticated
  using (user_id = auth.uid() or public.is_admin())
  with check (user_id = auth.uid() or public.is_admin());
create policy entries_delete on public.entries
  for delete to authenticated
  using (user_id = auth.uid() or public.is_admin());

-- ═══════════════════════════════════════════════════════════
-- 4. REALTIME (rispetta RLS per gli utenti autenticati)
--    Se rieseguito dà errore "already member of publication": ignorabile.
-- ═══════════════════════════════════════════════════════════
alter publication supabase_realtime add table
  public.profiles, public.clients, public.projects, public.activities,
  public.entries, public.rates, public.project_finance, public.entry_costs;

-- ═══════════════════════════════════════════════════════════
-- 5. VERIFICA
-- ═══════════════════════════════════════════════════════════
select tablename, rowsecurity from pg_tables
where schemaname = 'public'
  and tablename in ('profiles','clients','projects','project_finance',
                    'activities','rates','entries','entry_costs','app_settings');
