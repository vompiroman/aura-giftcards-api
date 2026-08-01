import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env["SUPABASE_URL"];
const supabaseKey = process.env["SUPABASE_SERVICE_ROLE_KEY"]
  || process.env["SUPABASE_SECRET_KEY"]
  || process.env["SUPABASE_KEY"];

// Refuse an anon key for privileged database access. Do not swallow this check.
function decodeRole(key: string | undefined): string | null {
  if (!key) return null;
  try {
    const parts = key.split(".");
  if (parts.length === 3) {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString());
      return typeof payload.role === "string" ? payload.role : null;
  }
  } catch {}
  return null;
}

function isPrivilegedDatabaseKey(key: string | undefined): boolean {
  return decodeRole(key) === "service_role" || Boolean(key?.startsWith("sb_secret_"));
}

if (!isPrivilegedDatabaseKey(supabaseKey)) {
  throw new Error("A SUPABASE_SERVICE_ROLE_KEY (or sb_secret_ key) is required for privileged database access.");
}

const configuredAuthKey = process.env["SUPABASE_ANON_KEY"] || process.env["SUPABASE_PUBLISHABLE_KEY"] || process.env["SUPABASE_KEY"];
const authRole = decodeRole(configuredAuthKey);
const isUsableAuthKey = authRole === "anon" || configuredAuthKey?.startsWith("sb_publishable_");
const supabaseAuthKey = configuredAuthKey && !isPrivilegedDatabaseKey(configuredAuthKey) && isUsableAuthKey
  ? configuredAuthKey
  : undefined;

if (!supabaseUrl || !supabaseKey || !supabaseAuthKey) {
  throw new Error("SUPABASE_URL, a service_role database key and a non-privileged SUPABASE_ANON_KEY are required.");
}

// Client AUTH : utilisé UNIQUEMENT pour les appels d'authentification (.auth.signUp, .auth.signIn, .auth.getUser)
export const supabaseAuth = createClient(supabaseUrl, supabaseAuthKey, {
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
