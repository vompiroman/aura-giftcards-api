import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env["SUPABASE_URL"];
const supabaseKey = process.env["SUPABASE_SERVICE_ROLE_KEY"] || process.env["SUPABASE_KEY"];
const supabaseAuthKey = process.env["SUPABASE_ANON_KEY"] || supabaseKey;

if (!supabaseUrl || !supabaseKey || !supabaseAuthKey) {
  throw new Error("SUPABASE_URL and a server Supabase key are required.");
}

// Refuse an anon key for privileged database access. Do not swallow this check.
function decodeRole(key: string): string | null {
  try {
    const parts = key.split(".");
  if (parts.length === 3) {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString());
      return typeof payload.role === "string" ? payload.role : null;
  }
  } catch {}
  return null;
}

const databaseRole = decodeRole(supabaseKey);
if (databaseRole === "anon") {
  throw new Error("SUPABASE_SERVICE_ROLE_KEY must be a service_role key, never an anon key.");
}

// Client AUTH : utilisÃƒÂ© UNIQUEMENT pour les appels d'authentification (.auth.signUp, .auth.signIn, .auth.getUser)
export const supabaseAuth = createClient(supabaseUrl, supabaseAuthKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
});

// Client ADMIN / DB : utilisÃƒÂ© pour toutes les requÃƒÂªtes base de donnÃƒÂ©es (.from, .rpc)
// En ne l'utilisant JAMAIS pour .auth.*, son header Authorization n'est JAMAIS polluÃƒÂ© par le token d'un utilisateur !
export const supabaseAdmin = createClient(supabaseUrl, supabaseKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
});

// Alias par dÃƒÂ©faut pointant sur supabaseAdmin pour que tous les appels .from() existants contournent RLS
export const supabase = supabaseAdmin;
