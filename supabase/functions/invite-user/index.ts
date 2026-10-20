// ============================================================
//  Edge Function "invite-user" — creazione utenti dall'app.
//
//  Gira sul server Supabase con la service_role (mai nel browser).
//  Solo un admin attivo può chiamarla. Non invia email: restituisce
//  il link di invito/recovery, che l'app mostra da copiare.
//
//  Due regole la tengono stretta (le stesse di Bomtrack):
//   - il ruolo NON passa dai metadata dell'utente Auth (che chiunque
//     si registri può scrivere): il profilo nasce operator sospeso dal
//     trigger handle_new_user, e ruolo, username, colore e stato li
//     scrive poi l'admin CON IL SUO TOKEN, sotto le stesse policy e la
//     stessa guardia di ogni altra modifica dall'app;
//   - il link di reimpostazione si genera per id, con l'email presa da
//     auth.users (è quella che decide chi entra), e mai per un altro
//     admin: con il suo link si entrerebbe al suo posto.
//
//  Deploy (una volta, e a ogni nuova versione di questo file):
//  Dashboard → Edge Functions → Deploy a new function →
//  nome "invite-user" → incollare questo file → Deploy.
//  SUPABASE_URL, SUPABASE_ANON_KEY e SUPABASE_SERVICE_ROLE_KEY le
//  fornisce Supabase da sé.
//
//  Richieste (POST, JSON, con il token dell'admin):
//   { action: 'invite', email, name, username, role, redirect } → { link, id }
//   { action: 'recovery', id, redirect }                        → { link }
//  `redirect` è l'indirizzo dell'app: deve stare fra i Redirect URLs
//  del progetto, altrimenti Supabase usa il Site URL.
// ============================================================
import { createClient } from "jsr:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, x-client-info, apikey",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json(405, { error: "Metodo non consentito" });

  const url = Deno.env.get("SUPABASE_URL")!;
  const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // ── Chi chiama? Deve essere un admin attivo ──
  const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!jwt) return json(401, { error: "Non autenticato" });
  const { data: userData, error: userErr } = await admin.auth.getUser(jwt);
  if (userErr || !userData?.user) return json(401, { error: "Sessione non valida" });

  const { data: profile } = await admin
    .from("profiles")
    .select("id, role, active")
    .eq("id", userData.user.id)
    .maybeSingle();
  if (!profile || profile.role !== "admin" || !profile.active) {
    return json(403, { error: "Operazione riservata agli amministratori" });
  }
  // Le scritture sui profili passano come l'admin: policy e guardia
  // valgono anche qui.
  const asAdmin = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: "Bearer " + jwt } },
  });

  // ── Input ──
  let body: Record<string, string>;
  try {
    body = await req.json();
  } catch {
    return json(400, { error: "Body JSON mancante" });
  }
  const action = body.action || "invite";
  const redirectTo = typeof body.redirect === "string" && /^https?:\/\//.test(body.redirect)
    ? body.redirect
    : undefined;

  if (action === "recovery") {
    // Link "reimposta password" per un utente esistente
    const id = String(body.id || "");
    const { data: target } = await admin
      .from("profiles")
      .select("id, role")
      .eq("id", id)
      .maybeSingle();
    if (!target) return json(404, { error: "Utente non trovato" });
    if (target.role === "admin" && target.id !== profile.id) {
      return json(403, {
        error: "La password di un altro amministratore non si reimposta da qui: usi «Password dimenticata» dalla schermata di accesso",
      });
    }
    const { data: au, error: auErr } = await admin.auth.admin.getUserById(id);
    if (auErr || !au?.user?.email) return json(404, { error: "Utente non trovato" });
    const { data, error } = await admin.auth.admin.generateLink({
      type: "recovery",
      email: au.user.email,
      options: { redirectTo },
    });
    if (error) return json(400, { error: error.message });
    return json(200, { link: data.properties.action_link });
  }

  if (action === "invite") {
    const email = (body.email || "").trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return json(400, { error: "Email non valida" });
    }
    const name = (body.name || "").trim();
    const username = (body.username || "").trim();
    const role = body.role === "admin" ? "admin" : body.role === "operator" ? "operator" : null;
    if (!name || !username) return json(400, { error: "Nome e username sono obbligatori" });
    if (!role) return json(400, { error: "Ruolo non valido" });

    // Nei metadata solo il nome: il ruolo non passa mai di qui.
    const { data, error } = await admin.auth.admin.generateLink({
      type: "invite",
      email,
      options: { data: { name }, redirectTo },
    });
    if (error || !data?.user) {
      if (error && /already.*registered|already exists/i.test(error.message)) {
        return json(409, { error: "Email già registrata: usa il bottone 🔑 per un link di reimpostazione" });
      }
      return json(400, { error: error ? error.message : "Invito non riuscito" });
    }
    const color = "#" + Math.floor(Math.random() * 16777215).toString(16).padStart(6, "0");
    const { error: profErr } = await asAdmin
      .from("profiles")
      .update({ name, username, role, color, active: true })
      .eq("id", data.user.id);
    if (profErr) {
      return json(400, {
        error: "Utente creato, ma il profilo non è stato completato: " + profErr.message +
          ". Assegna ruolo e riattivalo da Gestione → Utenti",
      });
    }
    return json(200, { link: data.properties.action_link, id: data.user.id });
  }

  return json(400, { error: "Azione sconosciuta" });
});
