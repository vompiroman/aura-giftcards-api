// Usage: node check-key.mjs "eyJhbGci..."
// This ONLY decodes the JWT header to check the role - it does NOT make any API calls

const key = process.argv[2];
if (!key) {
  console.log("Usage: node check-key.mjs <your-supabase-key>");
  console.log("Paste the value of SUPABASE_KEY from your Render environment variables.");
  process.exit(1);
}

try {
  const parts = key.split(".");
  if (parts.length !== 3) {
    console.error("❌ This doesn't look like a valid JWT (expected 3 parts separated by dots).");
    process.exit(1);
  }
  
  const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString());
  
  console.log("=== Supabase Key Analysis ===");
  console.log("Role:    ", payload.role);
  console.log("Issuer:  ", payload.iss);
  console.log("Ref:     ", payload.ref);
  console.log();
  
  if (payload.role === "anon") {
    console.log("❌ C'est la clé ANON !");
    console.log("   → Les opérations INSERT/SELECT sur la table 'orders' sont soumises à RLS.");
    console.log("   → Si aucune RLS policy n'autorise l'insert/read, les commandes ne sont pas enregistrées.");
    console.log("");
    console.log("🔧 SOLUTION: Remplace SUPABASE_KEY dans Render par la clé 'service_role'.");
    console.log("   Tu la trouves dans Supabase → Settings → API → service_role (secret).");
  } else if (payload.role === "service_role") {
    console.log("✅ C'est la clé SERVICE_ROLE.");
    console.log("   RLS est contournée côté serveur — ce n'est pas la clé le problème.");
    console.log("   Le problème est peut-être dans la structure de la table 'orders'.");
  } else {
    console.log("⚠️  Rôle inconnu:", payload.role);
  }
} catch (e) {
  console.error("Erreur lors du décodage:", e.message);
}
