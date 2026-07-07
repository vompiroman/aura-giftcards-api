// Direct Supabase diagnostic - tests connection and RLS independently from the API
// Usage: SUPABASE_URL=xxx SUPABASE_KEY=yyy node diag-supabase.mjs

import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_KEY;

if (!url || !key) {
  console.error("Set SUPABASE_URL and SUPABASE_KEY env vars");
  process.exit(1);
}

// Decode JWT to check role
function decodeJWT(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
    return payload;
  } catch { return null; }
}

const payload = decodeJWT(key);
console.log("=== JWT Payload ===");
console.log("Role:", payload?.role ?? "UNKNOWN");
console.log("Issuer:", payload?.iss ?? "UNKNOWN");
console.log();

if (payload?.role === "anon") {
  console.warn("⚠️  WARNING: You are using the ANON key! Server-side code should use the SERVICE_ROLE key.");
  console.warn("⚠️  With the anon key, RLS policies WILL be enforced and may silently block inserts/reads.");
  console.log();
}

if (payload?.role === "service_role") {
  console.log("✅ Using SERVICE_ROLE key - RLS will be bypassed.");
  console.log();
}

const supabase = createClient(url, key);

console.log("=== Test 1: List tables (check connection) ===");
const { data: tables, error: tablesErr } = await supabase.rpc("pg_tables_check").catch(() => ({ data: null, error: "rpc not available" }));

console.log("=== Test 2: Read orders table ===");
const { data: orders, error: readErr, count } = await supabase
  .from("orders")
  .select("order_id, assigned_email, status, amount", { count: "exact" })
  .limit(5);

console.log("Read error:", readErr ? JSON.stringify(readErr) : "none");
console.log("Orders count:", count ?? orders?.length ?? 0);
console.log("Orders sample:", JSON.stringify(orders?.slice(0, 3)));
console.log();

console.log("=== Test 3: Insert a test order ===");
const testOrderId = "DIAG-" + Date.now();
const { data: inserted, error: insertErr } = await supabase
  .from("orders")
  .insert({
    order_id: testOrderId,
    assigned_email: "diag@test.com",
    items: [{ name: "Netflix 1 mois", quantity: 1 }],
    amount: 600,
    status: "pending",
  })
  .select("order_id");

console.log("Insert error:", insertErr ? JSON.stringify(insertErr) : "none");
console.log("Inserted rows:", inserted?.length ?? 0);
console.log("Inserted data:", JSON.stringify(inserted));
console.log();

if (!insertErr && (!inserted || inserted.length === 0)) {
  console.error("❌ INSERT RETURNED 0 ROWS! This confirms RLS is silently blocking the insert.");
  console.error("   FIX: Use the service_role key instead of the anon key in SUPABASE_KEY.");
}

console.log("=== Test 4: Re-read the test order ===");
const { data: reread, error: rereadErr } = await supabase
  .from("orders")
  .select("order_id, assigned_email, status")
  .eq("order_id", testOrderId)
  .single();

console.log("Re-read error:", rereadErr ? JSON.stringify(rereadErr) : "none");
console.log("Re-read data:", JSON.stringify(reread));
console.log();

if (rereadErr || !reread) {
  console.error("❌ Could not re-read the order that was just 'inserted'. RLS SELECT policy is blocking reads.");
} else {
  console.log("✅ Order was successfully inserted and read back.");
}

// Cleanup
await supabase.from("orders").delete().eq("order_id", testOrderId);
console.log("Cleanup done (deleted test order).");
