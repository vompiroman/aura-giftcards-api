-- ============================================================
--  MIGRATION Aura Stream — clôture audit sécurité
--  À exécuter sur Supabase (SQL Editor). Tout ou rien (transaction).
-- ============================================================
BEGIN;

-- ------------------------------------------------------------
-- 1. Supprimer l'index unique mal ciblé (order_id, service)
--    -> cassait les commandes multi-profils Netflix.
-- ------------------------------------------------------------
DROP INDEX IF EXISTS idx_inventory_unique_order_service;

-- ------------------------------------------------------------
-- 2. Nouvelles colonnes (idempotent via IF NOT EXISTS)
-- ------------------------------------------------------------
ALTER TABLE inventory
  ADD COLUMN IF NOT EXISTS assigned_user_id text,
  ADD COLUMN IF NOT EXISTS assigned_at      timestamptz;

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS activated_at     timestamptz;

-- Index de lecture pour my-credentials (filtre par propriétaire).
CREATE INDEX IF NOT EXISTS idx_inventory_assigned_user
  ON inventory (assigned_user_id)
  WHERE assigned_user_id IS NOT NULL;

-- ------------------------------------------------------------
-- 3. Backfill des lignes déjà assignées
-- ------------------------------------------------------------
UPDATE inventory i
   SET assigned_user_id = o.assigned_email,
       assigned_at      = COALESCE(o.activated_at, o.created_at)
  FROM orders o
 WHERE i.assigned_order_id = o.order_id
   AND i.assigned_user_id IS NULL;

-- ------------------------------------------------------------
-- 4. Régularisation des lignes incohérentes AVANT le CHECK
--    (sinon ADD CONSTRAINT échoue sur l'existant)
-- ------------------------------------------------------------
-- 4a. Ligne marquée utilisée mais sans commande -> on la libère.
UPDATE inventory
   SET is_used = false,
       assigned_user_id = NULL,
       assigned_at = NULL
 WHERE is_used = true
   AND assigned_order_id IS NULL;

-- 4b. Ligne rattachée à une commande mais non marquée utilisée -> on la marque.
UPDATE inventory
   SET is_used = true
 WHERE is_used = false
   AND assigned_order_id IS NOT NULL;

-- ------------------------------------------------------------
-- 5. Contrainte de cohérence (la vraie ceinture-bretelles)
-- ------------------------------------------------------------
ALTER TABLE inventory
  DROP CONSTRAINT IF EXISTS chk_assignment_coherent;

ALTER TABLE inventory
  ADD CONSTRAINT chk_assignment_coherent
  CHECK (
    (is_used = true  AND assigned_order_id IS NOT NULL) OR
    (is_used = false AND assigned_order_id IS NULL)
  );

-- ------------------------------------------------------------
-- 6. Fonction d'assignation atomique + idempotente
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION assign_inventory_for_order(
  p_order_id    text,
  p_expires_at  timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order        orders%rowtype;
  v_service      text;
  v_needed       int;
  v_assigned_ids bigint[];
  v_result       jsonb := '[]'::jsonb;
BEGIN
  -- 1. Verrou sur la commande : sérialise deux webhooks concurrents.
  SELECT * INTO v_order
  FROM orders
  WHERE order_id = p_order_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ORDER_NOT_FOUND: %', p_order_id USING errcode = 'P0002';
  END IF;

  -- 2. Idempotence : rejeu du webhook = no-op qui réussit.
  IF v_order.status = 'active' THEN
    RETURN jsonb_build_object(
      'status', 'already_active',
      'order_id', p_order_id,
      'assigned', COALESCE(
        (SELECT jsonb_agg(jsonb_build_object('service', i.service, 'inventory_id', i.id))
           FROM inventory i
          WHERE i.assigned_order_id = p_order_id), '[]'::jsonb)
    );
  END IF;

  IF v_order.status = 'cancelled' THEN
    RAISE EXCEPTION 'ORDER_CANCELLED: %', p_order_id USING errcode = 'P0001';
  END IF;

  -- 3. Réserver le stock, agrégé par service.
  FOR v_service, v_needed IN
    SELECT
      lower(regexp_replace(elem->>'name', '\s.*$', '')) AS service,
      COALESCE(sum((elem->>'quantity')::int), 1)
    FROM jsonb_array_elements(v_order.items) AS elem
    GROUP BY 1
  LOOP
    v_assigned_ids := array(
      SELECT id
      FROM inventory
      WHERE service = v_service
        AND is_used = false
      ORDER BY id
      FOR UPDATE SKIP LOCKED
      LIMIT v_needed
    );

    IF array_length(v_assigned_ids, 1) IS DISTINCT FROM v_needed THEN
      RAISE EXCEPTION 'OUT_OF_STOCK: service=% besoin=% dispo=%',
        v_service, v_needed, COALESCE(array_length(v_assigned_ids, 1), 0)
        USING errcode = 'P0003';
    END IF;

    UPDATE inventory
       SET is_used           = true,
           assigned_order_id = p_order_id,
           assigned_user_id  = v_order.assigned_email,
           assigned_at       = now()
     WHERE id = ANY(v_assigned_ids);

    v_result := v_result || jsonb_build_object(
      'service', v_service,
      'count', v_needed,
      'inventory_ids', to_jsonb(v_assigned_ids)
    );
  END LOOP;

  -- 4. Activer la commande dans la même transaction.
  UPDATE orders
     SET status       = 'active',
         expires_at   = p_expires_at,
         activated_at = now()
   WHERE order_id = p_order_id;

  RETURN jsonb_build_object(
    'status', 'assigned',
    'order_id', p_order_id,
    'assigned', v_result
  );
END;
$$;

COMMIT;
