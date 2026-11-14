export const PARTNER_ENABLED = () => process.env.PARTNER_PROGRAM_ENABLED === "true";
// Once the schema is installed, "false" closes enrollment and checkout but
// must keep previously created invoices and wallet refunds serviceable.
export const PARTNER_SCHEMA_READY = () => ["true","false"].includes(process.env.PARTNER_PROGRAM_ENABLED || "");
export const AUTO_APPROVE_PARTNERS = () => process.env.AUTO_APPROVE_PARTNERS === "true";
export const MIN_UNLOCK_DEPOSIT = 3000; // Kept in sync with public.partner_min_unlock_deposit().
export const MAX_WALLET_DEPOSIT = 100_000;
export const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
