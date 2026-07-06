import { createClient } from "@supabase/supabase-js";

const STOCK_LOCK_MARKER = "E2E-STOCK-LOCK";

async function releaseResidualLock(): Promise<void> {
  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    console.warn("[globalTeardown] Variables Supabase absentes : nettoyage ignoré.");
    return;
  }
  const admin = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data, error } = await admin
    .from("inventory")
    .update({ assigned_order_id: null, assigned_at: null })
    .eq("assigned_order_id", STOCK_LOCK_MARKER)
    .select("id");
  if (error) {
    console.error(`[globalTeardown] Échec libération verrou : ${error.message}`);
    return;
  }
  const released = data?.length ?? 0;
  console.log(
    released > 0
      ? `[globalTeardown] ${released} compte(s) résiduel(s) libéré(s). ✔`
      : "[globalTeardown] Aucun verrou résiduel. Base propre. ✔"
  );
}

// Contrat globalSetup : la fonction retournée est appelée en teardown final,
// après l'exécution de TOUS les fichiers de test (succès comme échec).
export default function () {
  return async () => {
    await releaseResidualLock();
  };
}
