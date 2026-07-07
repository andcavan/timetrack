-- ============================================================
--  DEPRECATO — la vecchia policy "allow_anon_single_row" dava
--  lettura/scrittura dell'intero database a chiunque avesse la
--  anon key (che è pubblica nel sorgente del browser).
--
--  Il nuovo schema con Supabase Auth + RLS per utente/ruolo è in:
--    migrations/schema.sql   (tabelle, trigger, policy)
--    migrations/migrate.mjs  (migrazione dati dal blob)
--  Procedura completa nel README.
-- ============================================================

-- ── FASE 1 (freeze): rendi il vecchio blob READ-ONLY ──
-- Da eseguire all'inizio della finestra di migrazione: la vecchia app
-- continua a leggere ma ogni scrittura fallisce visibilmente.
--
-- DROP POLICY IF EXISTS "allow_anon_single_row" ON timetrack_data;
-- CREATE POLICY "anon_readonly_single_row" ON timetrack_data
--   FOR SELECT TO anon USING (id = 1);

-- ── FINE MIGRAZIONE: chiudi del tutto il vecchio blob ──
-- Dopo lo switch alla nuova app (la anon key non deve più vedere nulla):
--
-- DROP POLICY IF EXISTS "anon_readonly_single_row" ON timetrack_data;

-- ── ROLLBACK D'EMERGENZA: ripristina la vecchia app ──
-- Solo se serve tornare indietro (ripubblicare anche i vecchi file):
--
-- CREATE POLICY "allow_anon_single_row" ON timetrack_data
--   FOR ALL TO anon USING (id = 1) WITH CHECK (id = 1);

-- ── DOPO 2-4 SETTIMANE DI ESERCIZIO STABILE ──
-- Elimina il vecchio blob (prima: export di sicurezza!):
--
-- DROP TABLE timetrack_data;
