// ============================================================
//  Edge Function "invite-user" — creazione utenti dall'app.
//
//  Gira sul server Supabase con la service_role (mai nel browser).
//  Solo un admin attivo può chiamarla. Non invia email: restituisce
//  il link di invito/recovery, che l'app mostra da copiare.
//
//  Deploy: Dashboard → Edge Functions → Deploy a new function →
//  nome "invite-user" → incollare questo file → Deploy.
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

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  // ── Chi chiama? Deve essere un admin attivo ──
  const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!jwt) return json(401, { error: "Non autenticato" });
  const { data: userData, error: userErr } = await admin.auth.getUser(jwt);
  if (userErr || !userData?.user) return json(401, { error: "Sessione non valida" });

  const { data: profile } = await admin
    .from("profiles")
    .select("role, active")
    .eq("id", userData.user.id)
    .single();
  if (!profile || profile.role !== "admin" || !profile.active) {
    return json(403, { error: "Operazione riservata agli amministratori" });
  }

  // ── Input ──
  let body: Record<string, string>;
  try {
    body = await req.json();
  } catch {
    return json(400, { error: "Body JSON mancante" });
  }
  const action = body.action || "invite";
  const email = (body.email || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return json(400, { error: "Email non valida" });
  }

  if (action === "recovery") {
    // Link "reimposta password" per un utente esistente
    const { data, error } = await admin.auth.admin.generateLink({ type: "recovery", email });
    if (error) return json(400, { error: error.message });
    return json(200, { link: data.properties.action_link });
  }

  if (action === "invite") {
    const name = (body.name || "").trim();
    const username = (body.username || "").trim();
    const role = body.role === "admin" ? "admin" : body.role === "operator" ? "operator" : null;
    if (!name || !username) return json(400, { error: "Nome e username sono obbligatori" });
    if (!role) return json(400, { error: "Ruolo non valido" });

    const color = "#" + Math.floor(Math.random() * 16777215).toString(16).padStart(6, "0");
    const { data, error } = await admin.auth.admin.generateLink({
      type: "invite",
      email,
      options: { data: { name, username, role, color } },
    });
    if (error) {
      if (/already.*registered|already exists/i.test(error.message)) {
        return json(409, { error: "Email già registrata: usa il bottone 🔑 per un link di reimpostazione" });
      }
      return json(400, { error: error.message });
    }
    return json(200, { link: data.properties.action_link });
  }

  return json(400, { error: "Azione sconosciuta" });
});
