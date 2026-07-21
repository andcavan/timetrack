# TimeTrack — istruzioni di progetto

## Regola obbligatoria: revisioni e changelog

Ogni volta che modifichi `app.js`, `index.html`, `style.css`, `migrations/` o `supabase/`,
**nella stessa sessione e prima di considerare il lavoro finito**:

1. incrementa `APP_VERSION` in `app.js` (MAJOR.MINOR.PATCH — vedi tabella nel README);
2. aggiorna la riga `**Versione corrente: X.Y.Z**` in cima al README;
3. aggiungi la voce nel Changelog del README (sezione "Revisioni"), con data e descrizione
   di cosa cambia **per l'utente**, raggruppata in Aggiunto / Modificato / Corretto / Sicurezza.

Il badge di versione mostrato in alto a destra del titolo "TimeTrack" si popola da `APP_VERSION`:
non scrivere mai il numero a mano nell'HTML.

Un hook git `pre-commit` (`.githooks/pre-commit`, attivo via `core.hooksPath`) blocca i commit
che violano questa regola o che lasciano `app.js` e README disallineati.
