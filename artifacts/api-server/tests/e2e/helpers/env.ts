// Lecture et validation centralisée des variables d'environnement E2E.
// On échoue immédiatement si une variable critique manque : mieux vaut
// un test qui refuse de démarrer qu'un test qui passe pour de mauvaises raisons.

function required(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) {
    throw new Error(
      `[E2E] Variable d'environnement manquante : ${name}. ` +
        `Configure ton .env.test (voir tests/README).`
    );
  }
  return v.trim();
}

function optional(name: string, fallback: string): string {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : fallback;
}

export const env = {
  API_BASE: optional("API_BASE", "http://localhost:3000"),
  SUPABASE_URL: required("SUPABASE_URL"),
  SUPABASE_ANON_KEY: required("SUPABASE_ANON_KEY"),
  // service_role : UNIQUEMENT en test/CI, JAMAIS exposé au front.
  SUPABASE_SERVICE_ROLE_KEY: required("SUPABASE_SERVICE_ROLE_KEY"),
  WEBHOOK_SECRET: required("WEBHOOK_SECRET"),
  TEST_EMAIL: required("TEST_EMAIL"),
  TEST_PASSWORD: required("TEST_PASSWORD"),
  ITEM_NAME: optional("ITEM_NAME", "Netflix 1 mois"),
  // Service déduit du nom d'article, pour les requêtes d'inventaire.
  ITEM_SERVICE: optional("ITEM_SERVICE", "Netflix"),
} as const;
