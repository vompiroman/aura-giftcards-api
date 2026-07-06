// Simulates the EXACT flow the frontend does: login -> add to cart -> create-order -> create-invoice
const API_BASE = "https://aura-giftcards-api.onrender.com/api";

async function fullPaymentTest() {
  console.log("=== STEP 1: Login ===");
  
  // First, register a test account (may already exist)
  const regRes = await fetch(API_BASE + "/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "testpayment@test.com", password: "Test1234!" }),
  });
  console.log("Register status:", regRes.status);
  const regBody = await regRes.text();
  console.log("Register body:", regBody.slice(0, 200));

  // Login
  const loginRes = await fetch(API_BASE + "/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "testpayment@test.com", password: "Test1234!" }),
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
