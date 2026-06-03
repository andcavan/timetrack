-- ============================================================
--  TimeTrack — Supabase Row Level Security
--  Esegui questo script nel SQL Editor del tuo progetto Supabase:
--  Dashboard → SQL Editor → New query → Incolla → Run
-- ============================================================

-- 1. Abilita RLS sulla tabella
ALTER TABLE timetrack_data ENABLE ROW LEVEL SECURITY;

-- 2. Rimuovi eventuali policy vecchie prima di ricrearle
DROP POLICY IF EXISTS "allow_anon_single_row" ON timetrack_data;

-- 3. Policy: la chiave anonima può leggere/scrivere SOLO la riga id=1
--    Impedisce inserimento di righe extra o lettura di dati altrui
CREATE POLICY "allow_anon_single_row" ON timetrack_data
  FOR ALL
  TO anon
  USING (id = 1)
  WITH CHECK (id = 1);

-- ============================================================
--  SPIEGAZIONE
-- ============================================================
-- Senza RLS chiunque conosca la tua SUPABASE_KEY (visibile nel
-- codice sorgente del browser) potrebbe leggere o sovrascrivere
-- i dati. Con questa policy:
--
--  - SELECT: restituisce solo la riga id=1 (i tuoi dati)
--  - INSERT: bloccato se id != 1
--  - UPDATE: bloccato se id != 1
--  - DELETE: bloccato se id != 1
--
--  Il rischio residuo è che qualcuno con la chiave anon possa
--  comunque sovrascrivere la riga id=1. Per eliminare anche
--  questo rischio servirebbe Supabase Auth, che richiederebbe
--  un refactoring più ampio dell'app.
-- ============================================================

-- 4. (Opzionale) Verifica che RLS sia abilitato
SELECT tablename, rowsecurity
FROM pg_tables
WHERE schemaname = 'public' AND tablename = 'timetrack_data';
