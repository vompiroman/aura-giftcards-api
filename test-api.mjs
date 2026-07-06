// Quick test script to verify the deployed API endpoints
const BASE = "https://aura-giftcards-api.onrender.com/api";

async function test(label, url, opts = {}) {
  console.log(`\n=== ${label} ===`);
  console.log(`${opts.method || 'GET'} ${url}`);
  try {
    const res = await fetch(url, opts);
    const ct = res.headers.get("content-type") || "";
    const body = ct.includes("json") ? await res.json() : await res.text();
    console.log(`Status: ${res.status}`);
    console.log(`CORS: ${res.headers.get("access-control-allow-origin") ?? "(none)"}`);
    console.log(`Body:`, typeof body === "string" ? body.slice(0, 300) : JSON.stringify(body, null, 2));
  } catch (e) {
    console.error(`FETCH ERROR: ${e.message}`);
  }
}

async function main() {
  // 1. Test health / basic connectivity
  await test("Gift Cards (GET)", `${BASE}/gift-cards`);

  // 2. Test CORS preflight
  await test("CORS Preflight (OPTIONS /login)", `${BASE}/login`, {
    method: "OPTIONS",
    headers: {
      "Origin": "https://aura-stream.vercel.app",
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "content-type,authorization",
    },
  });

  // 3. Test login with bad creds (should return JSON error, not HTML)
  await test("Login (POST, bad creds)", `${BASE}/login`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Origin": "https://aura-stream.vercel.app",
    },
    body: JSON.stringify({ email: "test@example.com", password: "badpassword123" }),
  });

  // 4. Test create-invoice without auth (should return 401 JSON)
  await test("Create Invoice (POST, no auth)", `${BASE}/create-invoice`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Origin": "https://aura-stream.vercel.app",
    },
    body: JSON.stringify({ order_id: "test-order-123" }),
  });

  // 5. Test create-order without auth
  await test("Create Order (POST, no auth)", `${BASE}/create-order`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Origin": "https://aura-stream.vercel.app",
    },
    body: JSON.stringify({ items: [{ name: "Netflix 1 mois", quantity: 1 }] }),
  });
}

main();
