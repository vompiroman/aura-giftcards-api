// Staging-only diagnostic. Set API_BASE explicitly for a non-local environment.
const API_BASE = (process.env.API_BASE || "http://127.0.0.1:3000/api").replace(/\/$/, "");
const TEST_EMAIL = process.env.TEST_EMAIL;
const TEST_PASSWORD = process.env.TEST_PASSWORD;
const isLocal = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//i.test(`${API_BASE}/`);
if (!isLocal && process.env.ALLOW_PRODUCTION_TESTS !== "true") {
  throw new Error("Refusing non-local payment tests. Set ALLOW_PRODUCTION_TESTS=true only for an approved staging target.");
}
if (!TEST_EMAIL || !TEST_PASSWORD) {
  throw new Error("Set TEST_EMAIL and TEST_PASSWORD through the environment; no credentials are embedded in this script.");
}

async function fullPaymentTest() {
  console.log("=== STEP 1: Login ===");
  
  if (process.env.REGISTER_TEST_ACCOUNT === "true") {
    const regRes = await fetch(API_BASE + "/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: TEST_EMAIL, password: TEST_PASSWORD }),
    });
    console.log("Register status:", regRes.status);
  }

  // Login
  const loginRes = await fetch(API_BASE + "/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: TEST_EMAIL, password: TEST_PASSWORD }),
  });
  console.log("\nLogin status:", loginRes.status);
  const loginText = await loginRes.text();
  console.log("Login body:", loginText.slice(0, 300));
  
  let token;
  try {
    const loginData = JSON.parse(loginText);
    token = loginData?.session?.access_token;
    console.log("Token obtained:", token ? "YES (" + token.slice(0, 20) + "...)" : "NO");
    if (!token) {
      console.log("Cannot proceed without token. Login data:", JSON.stringify(loginData, null, 2));
      return;
    }
  } catch (e) {
    console.error("Failed to parse login response as JSON:", e.message);
    return;
  }

  console.log("\n=== STEP 2: /me endpoint ===");
  const meRes = await fetch(API_BASE + "/me", {
    headers: { "Authorization": `Bearer ${token}` },
  });
  console.log("GET /me status:", meRes.status);
  const meText = await meRes.text();
  console.log("GET /me body:", meText.slice(0, 200));

  console.log("\n=== STEP 3: Create Order ===");
  const itemsPayload = [{ name: "Netflix 1 mois", quantity: 1 }];
  const orderRes = await fetch(API_BASE + "/create-order", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`,
    },
    body: JSON.stringify({ items: itemsPayload }),
  });
  console.log("Create Order status:", orderRes.status);
  const orderText = await orderRes.text();
  console.log("Create Order body:", orderText.slice(0, 300));
  
  let orderId;
  try {
    const orderData = JSON.parse(orderText);
    orderId = orderData?.order_id;
    console.log("Order ID:", orderId || "NOT FOUND");
    if (!orderId) {
      console.log("Cannot proceed without order_id");
      return;
    }
  } catch (e) {
    console.error("Failed to parse order response:", e.message);
    return;
  }

  console.log("\n=== STEP 4: Create Invoice ===");
  const invoiceRes = await fetch(API_BASE + "/create-invoice", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`,
    },
    body: JSON.stringify({ order_id: orderId }),
  });
  console.log("Create Invoice status:", invoiceRes.status);
  const invoiceText = await invoiceRes.text();
  console.log("Create Invoice body:", invoiceText.slice(0, 500));

  try {
    const invoiceData = JSON.parse(invoiceText);
    console.log("\nPayment URL:", invoiceData?.payment_url || invoiceData?.url || "NOT FOUND");
    console.log("Error:", invoiceData?.error || "none");
  } catch (e) {
    console.error("Failed to parse invoice response:", e.message);
  }
}

fullPaymentTest().catch(console.error);
