# TimeTrack — gestione commesse

App di registrazione ore con Supabase (Auth + Postgres + RLS).

**Versione corrente: 2.1.0** — mostrata in alto a destra del titolo "TimeTrack" (header e schermata di login).

---

# Revisioni

## Come si gestisce una revisione

La versione ha un'unica sorgente: la costante `APP_VERSION` in `app.js` (righe iniziali).
Il badge `v…` nell'header e nel login viene riempito da lì: **non va scritto a mano nell'HTML**.

Numerazione `MAJOR.MINOR.PATCH`:

| Cosa hai fatto | Cosa incrementi | Esempio |
|---|---|---|
| Correzione di un bug, ritocco grafico | PATCH | 2.1.0 → 2.1.1 |
| Nuova funzione, nuovo campo, nuova vista | MINOR | 2.1.1 → 2.2.0 |
| Cambio di schema/DB o di autenticazione che richiede una migrazione | MAJOR | 2.2.0 → 3.0.0 |

**Checklist a ogni modifica dell'app** (l'ordine conta):

1. Fai la modifica in `app.js` / `index.html` / `style.css` / `migrations/`.
2. Aggiorna `APP_VERSION` in `app.js`.
3. Aggiorna "Versione corrente" qui sopra.
4. Aggiungi una voce nel Changelog qui sotto (data + cosa cambia per l'utente, non solo per il codice).
5. Committa tutto insieme.

> Il commit viene **bloccato** da un hook di git se modifichi i file dell'app senza toccare il README (vedi sotto): è la rete di sicurezza contro le dimenticanze.

## Changelog

Formato: `## [versione] — AAAA-MM-GG`, voci raggruppate in *Aggiunto / Modificato / Corretto / Sicurezza*.

### [2.1.0] — 2026-07-21

**Aggiunto**
- Badge della revisione in alto a destra del titolo "TimeTrack" (header e schermata di login), alimentato dalla costante `APP_VERSION`.
- Sezione "Revisioni" nel README con procedura di versionamento e changelog.
- Hook git `pre-commit` che blocca i commit sui file dell'app privi di aggiornamento del README.

### [2.0.0] — 2026-07-08

**Sicurezza**
- Migrazione completa a **Supabase Auth**: accesso con email + password e sessione JWT al posto dello username sul singolo blob JSON.
- Dati normalizzati in tabelle (`profiles`, `clients`, `projects`, `activities`, `entries`, `rates`, …) protette da **Row Level Security**: l'operator vede solo le proprie ore e non riceve mai tariffe, costi o budget.
- Costo delle ore "fotografato" da un trigger server-side (`entry_costs`), non più calcolato nel browser.
- Script CDN pinnati con Subresource Integrity.
- Passaggio alla **publishable key** (`sb_publishable_…`) al posto della anon key legacy.

**Aggiunto**
- Creazione utenti tramite Edge Function `invite-user` con email di invito.
- Guida di migrazione passo passo (fasi 0–2 e rollback) in questo README.
- Messaggi di errore e di stato più espliciti nell'interfaccia.

### [1.x] — fino al 2026-07-07

Versione storica su blob JSON singolo (`timetrack_data`) con login lato client. Funzioni principali maturate in questo ciclo: inserimento rapido ore, gestione commesse/clienti/attività, tariffe separate, accoppiamento commesse–utenti, export report PDF ed Excel, filtri commessa, disattivazione utente, data/ora in header, estrazione di CSS e JS in file separati.

---

## Sicurezza (versione 2)

- **Login con Supabase Auth** (email + password verificate lato server, sessione JWT).
- **Dati normalizzati** in tabelle (`profiles`, `clients`, `projects`, `activities`, `entries`, `rates`, ...) protette da **Row Level Security**:
  - un *operator* vede e modifica **solo le proprie ore**; tariffe, costi e budget € non gli vengono mai inviati;
  - un *admin* vede tutto; il ruolo è protetto lato server (nessuna auto-promozione possibile);
  - la publishable key (pubblica per progettazione) **senza sessione non accede a nulla**.
- Le tariffe delle ore vengono "fotografate" da un trigger server-side (`entry_costs`), mai calcolate nel browser.
- Script CDN pinnati con Subresource Integrity.

---

# Guida alla migrazione passo passo

> **Tempo richiesto:** Fase 0 quando vuoi, senza fretta (la vecchia app continua a funzionare).
> Fase 1 in una finestra concordata di ~30 minuti in cui nessuno registra ore.
>
> **Prerequisiti sul tuo PC:** [Node.js](https://nodejs.org) installato (versione 18 o superiore — verifica con `node --version` in un terminale).

## FASE 0 — Preparazione (nessun impatto sugli utenti)

### 0.1 Inserisci le email degli utenti nella vecchia app

1. Apri la vecchia app (quella attualmente in produzione) e accedi come **admin**.
2. Vai in **Gestione → Utenti**.
3. Per ogni utente: clicca **✏ (Modifica)** e compila il campo **Email** con l'indirizzo email reale della persona, poi **Salva**.
4. Attendi che il badge in basso a destra dica **"✓ Sincronizzato"**.

> ⚠️ Ogni utente riceverà su quell'email il link di invito per impostare la nuova password. Un'email sbagliata = utente che non può accedere. Ricontrollale.

### 0.2 Avvisa gli utenti

Comunica a tutti, con qualche giorno di anticipo:
- il giorno e l'ora della migrazione (es. "venerdì dalle 13:00 alle 13:30 non registrate ore");
- che riceveranno **un'email di invito** con cui impostare la loro nuova password;
- che d'ora in poi si accede con **email + password** (non più con lo username);
- di aprire l'app **online** almeno una volta prima della migrazione (per scaricare eventuali ore rimaste solo in locale sul loro PC).

### 0.3 Crea le nuove tabelle nel database

1. Apri il [Dashboard Supabase](https://supabase.com/dashboard) → il tuo progetto.
2. Menu a sinistra → **SQL Editor** → **New query**.
3. Apri il file `migrations/schema.sql` in VS Code, seleziona tutto (`Ctrl+A`), copia (`Ctrl+C`).
4. Incolla nel SQL Editor (`Ctrl+V`) e premi **Run** (o `Ctrl+Invio`).
5. **Risultato atteso:** in fondo compare una tabella con 9 righe (`profiles`, `clients`, `projects`, `project_finance`, `activities`, `rates`, `entries`, `entry_costs`, `app_settings`) tutte con `rowsecurity = true`.

> Le nuove tabelle convivono con la vecchia `timetrack_data`: la vecchia app continua a funzionare come prima.
> Se rilanci lo script per errore, l'unico messaggio ignorabile è *"already member of publication"*; gli errori *"already exists"* indicano che le tabelle ci sono già (va bene così).

### 0.4 Configura l'autenticazione nel Dashboard

Nel Dashboard Supabase:

1. **Authentication → Sign In / Providers** (o "Sign In / Up"):
   - **disattiva** "Allow new users to sign up" → nessuno può auto-registrarsi; gli account si creano solo per invito;
   - in **Password**: imposta lunghezza minima **8** caratteri.
2. **Authentication → URL Configuration**:
   - **Site URL** = l'indirizzo esatto a cui è pubblicata l'app (es. `https://tuodominio.it/timetrack/`).
     È l'indirizzo su cui atterrano i link di invito e di reset password: se è sbagliato, gli inviti non funzionano.

### 0.5 Recupera le chiavi per lo script di migrazione

1. Dashboard → **Settings → API** (oppure "API Keys").
2. Copia:
   - **Project URL** (es. `https://latuujorgnaksdhxazfb.supabase.co`);
   - la chiave **service_role** (⚠️ è la chiave "padrona": non condividerla, non committarla su git, non metterla mai nell'app — si usa solo sul tuo PC per la migrazione).

### 0.6 Decidi come inviare le email di invito (IMPORTANTE)

Il servizio email **integrato** di Supabase è solo per i test: manda **~2 email l'ora** ("email rate limit exceeded" oltre quella soglia). Con più utenti da invitare non basta. Due strade:

**Opzione A — Link di invito a mano (più semplice, zero configurazione)**
Esegui la migrazione con l'opzione `--print-links`: lo script **non invia email** ma stampa a video un link di invito per ogni utente, da girare tu stesso via WhatsApp/Teams/email personale. I link scadono in ~24 ore, quindi distribuiscili subito dopo la migrazione.
Nota: anche il bottone 🔑 (reset password) della nuova app usa le email, quindi con questa opzione i reset futuri saranno limitati a ~2/ora — accettabile per un team piccolo.

**Opzione B — SMTP personalizzato (più lavoro, soluzione definitiva)**
Dashboard → **Project Settings → Authentication → SMTP Settings**: inserisci i dati SMTP di una casella aziendale (o un servizio gratuito come Brevo, ~300 email/giorno). Poi in **Authentication → Rate Limits** alza il limite email. Da quel momento inviti e reset password funzionano senza limiti pratici.

> Se hai già visto l'errore "email rate limit exceeded": il contatore si azzera dopo circa un'ora; non serve fare altro.

### 0.7 Prepara lo script sul tuo PC

Apri un terminale (PowerShell) nella cartella del progetto:

```powershell
cd "c:\Users\prog3\Desktop\APP MECCANICA\timetrack-supabase\migrations"
npm install @supabase/supabase-js
```

Poi imposta le variabili d'ambiente (valgono solo per quella finestra di terminale):

```powershell
$env:SUPABASE_URL = "https://latuujorgnaksdhxazfb.supabase.co"
$env:SUPABASE_SERVICE_ROLE_KEY = "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
```

### 0.8 Prova generale (senza scrivere nulla)

```powershell
node migrate.mjs --dry-run
```

Lo script legge i dati veri e stampa cosa farebbe: quanti utenti/clienti/commesse/ore, a chi manderebbe l'invito. **Non scrive nulla.**

- Se segnala **"Utenti senza email valida"**: torna al punto 0.1 e completa le email; in alternativa, per utenti senza email, si può usare `--fallback-domain=tuodominio.it` (crea account fittizi `username@tuodominio.it` con password temporanea da comunicare a voce — sconsigliato se puoi avere le email vere).
- Se segnala entry "scartate": sono registrazioni orfane di commesse/clienti cancellati in passato; verranno saltate (normale).

## FASE 1 — Migrazione (finestra di ~30 minuti)

Esegui questi passi **in ordine**, all'orario annunciato.

### 1.1 Backup di sicurezza

1. Nella vecchia app (admin): **Gestione → Backup → ⬇ Esporta JSON**. Salva il file in un posto sicuro.
2. (Extra, consigliato) SQL Editor → `select data from timetrack_data where id = 1;` → clic destro sul risultato → copia/scarica.

### 1.2 Congela la vecchia app (read-only)

SQL Editor → New query → incolla ed esegui:

```sql
DROP POLICY IF EXISTS "allow_anon_single_row" ON timetrack_data;
CREATE POLICY "anon_readonly_single_row" ON timetrack_data
  FOR SELECT TO anon USING (id = 1);
```

Da questo momento la vecchia app **legge ma non salva**: se qualcuno prova a registrare ore vedrà "✗ Errore sync" (per questo la finestra va annunciata).

### 1.3 Esegui la migrazione vera

Nel terminale di prima (con le variabili ancora impostate):

```powershell
node migrate.mjs
```

(oppure `node migrate.mjs --print-links` se al punto 0.6 hai scelto l'Opzione A: alla fine stampa i link di invito da distribuire a mano).

Lo script:
- crea gli account e **invia le email di invito** (o genera i link, con `--print-links`);
- travasa clienti, commesse, attività, tariffe, ore e costi storici;
- alla fine stampa una sezione **"Verifica"** con i conteggi.

✅ **Prosegui solo se tutti i conteggi hanno la spunta ✓** (incluse le "ore totali").
❌ Se qualcosa non torna: NON pubblicare la nuova app; la vecchia è ancora lì in sola lettura. Mandami l'output e lo sistemiamo (lo script si può rilanciare: riconosce gli utenti già creati e non duplica i dati).

> Se lo script stampa **"PASSWORD TEMPORANEE"** (solo con `--fallback-domain`): salvale e comunicale a voce agli interessati.

### 1.4 Pubblica la nuova app

Sostituisci sul tuo hosting i file con le versioni nuove:
- `index.html`
- `app.js`
- `style.css` (invariato, ma male non fa)

Il metodo dipende da dove è pubblicata l'app (FTP, cartella condivisa, ecc.): è una semplice copia di file.

### 1.5 Chiudi definitivamente il vecchio blob

SQL Editor:

```sql
DROP POLICY IF EXISTS "anon_readonly_single_row" ON timetrack_data;
```

Ora la anon key non può più leggere nulla del vecchio database. La tabella `timetrack_data` resta come archivio di emergenza.

### 1.6 Primo accesso e verifica

1. Apri la nuova app: deve comparire il login con **Email**.
2. Controlla la **tua** casella email: apri l'invito → si apre l'app con la schermata **"Imposta la tua password"** → scegli la password (min 8) → entri.
3. Verifica: le tue ore, le commesse, i clienti e (da admin) tariffe e budget devono esserci tutti.
4. Registra un'ora di prova e cancellala: deve funzionare.

## FASE 2 — Dopo la migrazione

### 2.1 Assistenza agli utenti (primo giorno)

- **"Non ho ricevuto l'invito"** → far controllare lo spam; se non c'è: Gestione → Utenti → **🔑** (invia email di reset password), che arriva sullo stesso indirizzo.
- **"Ho sbagliato a scrivere la password due volte"** → di nuovo il bottone **🔑** in Gestione → Utenti.
- **"Link di invito scaduto"** → idem, il bottone **🔑** genera un nuovo link valido.

### 2.2 Creare nuovi utenti (d'ora in poi)

**Metodo principale — direttamente dall'app** (richiede la Edge Function, vedi 2.2.1):

1. Accedi come admin → **Gestione → Utenti → + Nuovo utente**.
2. Compila nome, email, username e ruolo → **Crea e genera link**.
3. L'app mostra il **link di invito** con bottone 📋 Copia: invialo alla persona (WhatsApp, Teams, ...). Cliccandolo imposta la password ed entra. Il link scade in ~24 ore.

Analogamente, il bottone **🔑** accanto a un utente genera un link di **reimpostazione password** da girare a mano (niente email, nessun rate limit).

#### 2.2.1 Deploy della Edge Function `invite-user` (una volta sola)

La creazione account richiede la service_role key, che non può stare nel browser: gira in una **Edge Function** sul server Supabase, che verifica che il chiamante sia un admin attivo.

1. Dashboard Supabase → **Edge Functions** → **Deploy a new function** (editor nel browser, "via Editor").
2. Nome funzione: `invite-user` (esattamente questo).
3. Cancella il codice di esempio e incolla tutto il contenuto di `supabase/functions/invite-user/index.ts`.
4. **Deploy**. **Disattiva la verifica JWT** ("Verify JWT with legacy secret" OFF, sia nel dialogo di deploy sia nella scheda Settings della funzione): il progetto usa le nuove API keys e la verifica legacy del gateway rifiuterebbe ogni chiamata con `401 INVALID_CREDENTIALS`. La sicurezza non ne risente: la funzione verifica da sola che il chiamante sia un admin attivo.
5. Attenzione a incollare **tutto** il contenuto del file: se resta il codice di esempio, la funzione risponde `"Hello ..."` e l'app mostra "Generazione non riuscita".

**Fallback senza Edge Function** — gli script locali continuano a funzionare:

```powershell
cd "c:\Users\prog3\Desktop\APP MECCANICA\timetrack-supabase\migrations"
$env:SUPABASE_URL = "https://latuujorgnaksdhxazfb.supabase.co"
$env:SUPABASE_SERVICE_ROLE_KEY = "(la service_role dal Dashboard → Settings → API)"
node new-user.mjs mario.rossi@azienda.it "Mario Rossi" mario     # nuovo utente (+ "admin" opzionale)
node gen-links.mjs email@persona.it                              # nuovo link per utente esistente
```

Per sospendere qualcuno: **Gestione → Utenti → ⏸ Sospendi** (non serve cancellarlo).

### 2.3 Verifiche di sicurezza (consigliate, 5 minuti)

Loggato come **operator** (non admin), apri la console del browser (`F12` → Console) e incolla:

```js
(await supa.from('rates').select('*')).data          // atteso: []
(await supa.from('entry_costs').select('*')).data    // atteso: []
(await supa.from('project_finance').select('*')).data // atteso: []
(await supa.from('entries').select('*')).data        // atteso: SOLO le proprie righe
await supa.from('profiles').update({role:'admin'}).eq('id',(await supa.auth.getUser()).data.user.id)
// atteso: error "Campo protetto: modificabile solo da un amministratore"
```

Se tutti i risultati corrispondono, la RLS sta facendo il suo lavoro.

### 2.4 Dopo 2–4 settimane di esercizio stabile

Elimina il vecchio archivio (prima assicurati di avere l'export JSON del punto 1.1):

```sql
DROP TABLE timetrack_data;
```

## Rollback d'emergenza (solo se qualcosa va storto)

Finché `timetrack_data` esiste puoi tornare alla vecchia app in pochi minuti:

1. Ripubblica i **vecchi** `index.html` e `app.js` (recuperali da git: `git checkout <commit> -- index.html app.js`).
2. SQL Editor:
   ```sql
   CREATE POLICY "allow_anon_single_row" ON timetrack_data
     FOR ALL TO anon USING (id = 1) WITH CHECK (id = 1);
   ```
3. Le ore eventualmente registrate nella nuova app nel frattempo restano nelle nuove tabelle: si possono riesportare con una query e reinserire a mano.
