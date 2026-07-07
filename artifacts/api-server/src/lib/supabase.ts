import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env["SUPABASE_URL"];
const supabaseKey = process.env["SUPABASE_SERVICE_ROLE_KEY"] || process.env["SUPABASE_KEY"];

if (!supabaseUrl || !supabaseKey) {
  throw new Error("SUPABASE_URL and SUPABASE_KEY environment variables are required.");
}

// Vérification de sécurité et de diagnostic au démarrage (Boot Check)
try {
  const parts = supabaseKey.split(".");
  if (parts.length === 3) {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString());
    if (payload.role === "anon") {
      console.warn("⚠️ [BOOT AUDIT] SUPABASE_KEY contient la clé 'anon'. Les requêtes serveur sont soumises à RLS ! Si les commandes sont invisibles, remplacez par la clé 'service_role' sur Render.");
    } else if (payload.role === "service_role") {
      console.log("✅ [BOOT AUDIT] SUPABASE_KEY est bien la clé 'service_role' (BYPASSRLS actif, mode serveur sécurisé).");
    }
  }
} catch {
  // Ignorer si la clé n'est pas un JWT standard
}

// Client AUTH : utilisé UNIQUEMENT pour les appels d'authentification (.auth.signUp, .auth.signIn, .auth.getUser)
export const supabaseAuth = createClient(supabaseUrl, supabaseKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
});

// Client ADMIN / DB : utilisé pour toutes les requêtes base de données (.from, .rpc)
// En ne l'utilisant JAMAIS pour .auth.*, son header Authorization n'est JAMAIS pollué par le token d'un utilisateur !
export const supabaseAdmin = createClient(supabaseUrl, supabaseKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
});

// Alias par défaut pointant sur supabaseAdmin pour que tous les appels .from() existants contournent RLS
export const supabase = supabaseAdmin;
