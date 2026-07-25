import crypto from "crypto";

const DEFAULT_PIXEL_ID = "1048802778090797";

interface MetaPurchaseInput {
  orderId: string;
  amount: number;
  email: string;
  items: unknown;
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function safeContents(items: unknown): Array<{ id: string; quantity: number }> {
  if (!Array.isArray(items)) return [];
  return items.slice(0, 20).flatMap((item: any) => {
    const id = String(item?.name || "").trim().slice(0, 120);
    const quantity = Number(item?.quantity || 1);
    if (!id) return [];
    return [{ id, quantity: Number.isFinite(quantity) && quantity > 0 ? Math.min(quantity, 20) : 1 }];
  });
}

export async function sendMetaPurchase(input: MetaPurchaseInput): Promise<boolean> {
  const accessToken = process.env.META_CAPI_ACCESS_TOKEN || "";
  const pixelId = process.env.META_PIXEL_ID || DEFAULT_PIXEL_ID;
  if (!accessToken || !pixelId) return false;

  const amount = Number(input.amount);
  const email = String(input.email || "").trim().toLowerCase();
  if (!/^ORD-[A-Za-z0-9-]{6,40}$/.test(input.orderId) || !Number.isFinite(amount) || amount <= 0 || !email) {
    return false;
  }

  const event = {
    event_name: "Purchase",
    event_time: Math.floor(Date.now() / 1000),
    event_id: `purchase_${input.orderId}`,
    action_source: "website",
    event_source_url: (process.env.FRONTEND_URL || "https://aura-stream.netlify.app").replace(/\/+$/, ""),
    user_data: { em: [sha256(email)] },
    custom_data: {
      currency: "DZD",
      value: amount,
      order_id: input.orderId,
      content_type: "product",
      contents: safeContents(input.items),
    },
  };

  const body: Record<string, unknown> = { data: [event], access_token: accessToken };
  if (process.env.META_TEST_EVENT_CODE) body.test_event_code = process.env.META_TEST_EVENT_CODE;

  const apiVersion = (process.env.META_GRAPH_API_VERSION || "v23.0").replace(/[^v0-9.]/g, "");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(
      `https://graph.facebook.com/${apiVersion}/${encodeURIComponent(pixelId)}/events`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      },
    );
    if (!response.ok) {
      console.error(`[meta] Conversions API returned ${response.status}`);
      return false;
    }
    return true;
  } catch {
    console.error("[meta] Conversions API request failed");
    return false;
  } finally {
    clearTimeout(timer);
  }
}
