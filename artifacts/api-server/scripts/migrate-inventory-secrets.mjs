import crypto from "node:crypto";

const PREFIX = "enc:v1:";

if (process.env.MIGRATE_INVENTORY_SECRETS !== "true" || process.env.MIGRATION_CONFIRM !== "ENCRYPT_EXISTING_CREDENTIALS") {
  console.error("Refus: définissez MIGRATE_INVENTORY_SECRETS=true et MIGRATION_CONFIRM=ENCRYPT_EXISTING_CREDENTIALS pour lancer cette migration.");
  process.exitCode = 2;
  process.exit();
}

const supabaseUrl = String(process.env.SUPABASE_URL || "").replace(/\/$/, "");
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_KEY || "";
const credentialSecret = process.env.INVENTORY_CREDENTIALS_KEY || process.env.CLIENT_CREDENTIALS_KEY || "";

function decodeRole(key) {
  try {
    const payload = JSON.parse(Buffer.from(key.split(".")[1], "base64url").toString("utf8"));
    return payload.role;
  } catch {
    return null;
  }
}

if (!supabaseUrl || !serviceKey || !credentialSecret || credentialSecret.length < 32) {
  throw new Error("SUPABASE_URL, une clé Supabase privilégiée et une clé de chiffrement de 32 caractères sont requises.");
}
if (decodeRole(serviceKey) !== "service_role" && !serviceKey.startsWith("sb_secret_")) {
  throw new Error("La clé Supabase fournie n'est pas une clé service_role/sb_secret privilégiée.");
}

const key = crypto.createHash("sha256").update(`aura-inventory:${credentialSecret}`, "utf8").digest();

function encrypt(value) {
  if (typeof value !== "string" || value.length === 0 || value.startsWith(PREFIX)) return value ?? null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return `${PREFIX}${JSON.stringify({
    iv: iv.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
  })}`;
}

async function supabaseRequest(path, options = {}) {
  const response = await fetch(`${supabaseUrl}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      Accept: "application/json",
      ...(options.headers || {}),
    },
  });
  if (!response.ok) {
    const error = new Error(`Supabase request failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return response;
}

async function migrateTable(table, select, fields) {
  let rows;
  try {
    rows = await (await supabaseRequest(`${table}?select=${encodeURIComponent(select)}&limit=1000`)).json();
  } catch (error) {
    if (error.status === 404) return { table, skipped: true, migrated: 0 };
    throw error;
  }

  let migrated = 0;
  for (const row of Array.isArray(rows) ? rows : []) {
    const updates = {};
    for (const field of fields) {
      const encrypted = encrypt(row[field]);
      if (encrypted !== row[field]) updates[field] = encrypted;
    }
    if (!Object.keys(updates).length) continue;
    await supabaseRequest(`${table}?id=eq.${encodeURIComponent(row.id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify(updates),
    });
    migrated += 1;
  }
  return { table, skipped: false, migrated };
}

const results = await Promise.all([
  migrateTable("inventory", "id,account_password,imap_password", ["account_password", "imap_password"]),
  migrateTable("email_accounts", "id,imap_password", ["imap_password"]),
]);
console.log(JSON.stringify({ completed: true, results }));
