import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { env } from "./env";

// Client service_role : contourne la RLS pour LIRE l'état réel et NETTOYER.
// À n'utiliser QUE dans les tests. Ne jamais importer ce module côté app.
export const admin: SupabaseClient = createClient(
  env.SUPABASE_URL,
  env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

export interface OrderRow {
  order_id: string;
  status: string;
  amount: number;
  created_at: string;
}

export async function getOrder(orderId: string): Promise<OrderRow | null> {
  const { data, error } = await admin
    .from("orders")
    .select("order_id, status, amount, created_at")
    .eq("order_id", orderId)
    .maybeSingle();
  if (error) throw new Error(`getOrder(${orderId}) : ${error.message}`);
  return (data as OrderRow) ?? null;
}

// Nombre d'items d'inventaire assignés à une commande (clé de l'idempotence).
export async function countAssignedInventory(orderId: string): Promise<number> {
  const { count, error } = await admin
    .from("inventory")
    .select("id", { count: "exact", head: true })
    .eq("assigned_order_id", orderId);
  if (error) throw new Error(`countAssignedInventory(${orderId}) : ${error.message}`);
  return count ?? 0;
}

// Nettoyage après la suite : libère l'inventaire assigné et supprime la commande
// de test, pour que la base de staging reste propre et les runs répétables.
export async function cleanupOrder(orderId: string): Promise<void> {
  const { error: relErr } = await admin
    .from("inventory")
    .update({ assigned_order_id: null, assigned_at: null })
    .eq("assigned_order_id", orderId);
  if (relErr) throw new Error(`cleanup inventory(${orderId}) : ${relErr.message}`);

  const { error: delErr } = await admin
    .from("orders")
    .delete()
    .eq("order_id", orderId);
  if (delErr) throw new Error(`cleanup order(${orderId}) : ${delErr.message}`);
}

// Marqueur sentinelle : réserve temporairement le stock pour simuler une rupture.
// Choisi pour être impossible à confondre avec un vrai order_id ("ORD-<uuid>").
export const STOCK_LOCK_MARKER = "E2E-STOCK-LOCK";

// Réserve TOUT le stock disponible d'un service (assigned_order_id IS NULL).
// Renvoie le nombre d'items verrouillés, pour vérifier qu'il y avait bien du stock.
export async function lockAllStock(service: string): Promise<number> {
  const { data, error } = await admin
    .from("inventory")
    .update({ assigned_order_id: STOCK_LOCK_MARKER, assigned_at: new Date().toISOString() })
    .eq("service", service)
    .is("assigned_order_id", null)
    .select("id");
  if (error) throw new Error(`lockAllStock(${service}) : ${error.message}`);
  return data?.length ?? 0;
}

// Libère UNIQUEMENT le stock verrouillé par le marqueur sentinelle.
// Ciblage strict : ne libère jamais un compte réellement assigné à une commande.
export async function releaseLockedStock(service: string): Promise<void> {
  const { error } = await admin
    .from("inventory")
    .update({ assigned_order_id: null, assigned_at: null })
    .eq("service", service)
    .eq("assigned_order_id", STOCK_LOCK_MARKER);
  if (error) throw new Error(`releaseLockedStock(${service}) : ${error.message}`);
}

