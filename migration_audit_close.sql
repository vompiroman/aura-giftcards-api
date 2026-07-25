-- ============================================================
--  MIGRATION Aura Stream Ã¢â‚¬â€ clÃƒÂ´ture audit sÃƒÂ©curitÃƒÂ©
--  Ãƒâ‚¬ exÃƒÂ©cuter sur Supabase (SQL Editor). Tout ou rien (transaction).
-- ============================================================
BEGIN;

-- ------------------------------------------------------------
-- 1. Supprimer l'index unique mal ciblÃƒÂ© (order_id, service)
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

-- CompatibilitÃƒÂ© du catalogue API avec le statut source de vÃƒÂ©ritÃƒÂ©.
ALTER TABLE gift_cards
  ADD COLUMN IF NOT EXISTS available boolean
  GENERATED ALWAYS AS (status = 'available') STORED;

-- Index de lecture pour my-credentials (filtre par propriÃƒÂ©taire).
CREATE INDEX IF NOT EXISTS idx_inventory_assigned_user
  ON inventory (assigned_user_id)
  WHERE assigned_user_id IS NOT NULL;

-- ------------------------------------------------------------
-- 3. Backfill des lignes dÃƒÂ©jÃƒÂ  assignÃƒÂ©es
-- ------------------------------------------------------------
UPDATE inventory i
   SET assigned_user_id = o.assigned_email,
       assigned_at      = COALESCE(o.activated_at, o.created_at)
  FROM orders o
 WHERE i.assigned_order_id = o.order_id
   AND i.assigned_user_id IS NULL;

-- ------------------------------------------------------------
-- 4. RÃƒÂ©gularisation des lignes incohÃƒÂ©rentes AVANT le CHECK
--    (sinon ADD CONSTRAINT ÃƒÂ©choue sur l'existant)
-- ------------------------------------------------------------
-- 4a. Ligne marquÃƒÂ©e utilisÃƒÂ©e mais sans commande -> on la libÃƒÂ¨re.
UPDATE inventory
   SET is_used = false,
       assigned_user_id = NULL,
       assigned_at = NULL
 WHERE is_used = true
   AND assigned_order_id IS NULL;

-- 4b. Ligne rattachÃƒÂ©e ÃƒÂ  une commande mais non marquÃƒÂ©e utilisÃƒÂ©e -> on la marque.
UPDATE inventory
   SET is_used = true
 WHERE is_used = false
   AND assigned_order_id IS NOT NULL;

-- ------------------------------------------------------------
-- 5. Contrainte de cohÃƒÂ©rence (la vraie ceinture-bretelles)
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
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_order        orders%rowtype;
  v_service      text;
  v_needed       int;
  v_assigned_ids uuid[];
  v_result       jsonb := '[]'::jsonb;
BEGIN
  -- 1. Verrou sur la commande : sÃƒÂ©rialise deux webhooks concurrents.
  SELECT * INTO v_order
  FROM public.orders
  WHERE order_id = p_order_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ORDER_NOT_FOUND: %', p_order_id USING errcode = 'P0002';
  END IF;

  -- 2. Idempotence : rejeu du webhook = no-op qui rÃƒÂ©ussit.
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

  IF v_order.payment_status <> 'paid' THEN
    RAISE EXCEPTION 'PAYMENT_NOT_CONFIRMED: %', p_order_id USING errcode = 'P0001';
  END IF;

  -- 3. RÃƒÂ©server le stock, agrÃƒÂ©gÃƒÂ© par service.
  FOR v_service, v_needed IN
    SELECT
      lower(regexp_replace(elem->>'name', '\s.*$', '')) AS service,
      COALESCE(sum((elem->>'quantity')::int), 1)
    FROM pg_catalog.jsonb_array_elements(v_order.items) AS elem
    GROUP BY 1
  LOOP
    v_assigned_ids := array(
      SELECT id
      FROM public.inventory
      WHERE lower(trim(service)) = v_service
        AND is_used = false
        AND assigned_order_id IS NULL
      ORDER BY id
      FOR UPDATE SKIP LOCKED
      LIMIT v_needed
    );

    IF array_length(v_assigned_ids, 1) IS DISTINCT FROM v_needed THEN
      RAISE EXCEPTION 'OUT_OF_STOCK: service=% besoin=% dispo=%',
        v_service, v_needed, COALESCE(array_length(v_assigned_ids, 1), 0)
        USING errcode = 'P0003';
    END IF;

    UPDATE public.inventory
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

  -- 4. Activer la commande dans la mÃƒÂªme transaction.
  UPDATE public.orders
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

-- The RPC is server-only. SECURITY DEFINER functions otherwise become public
-- API endpoints through PostgREST.
REVOKE ALL ON FUNCTION public.assign_inventory_for_order(text, timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.assign_inventory_for_order(text, timestamptz)
  TO service_role;

-- A paid invariant at the database layer prevents an API regression from
-- activating an unpaid order.
ALTER TABLE public.orders
  DROP CONSTRAINT IF EXISTS chk_paid_before_activation;
ALTER TABLE public.orders
  ADD CONSTRAINT chk_paid_before_activation
  CHECK (status NOT IN ('active', 'completed') OR payment_status = 'paid');

-- The browser does not query these tables directly. Keep them server-only and
-- let the service_role used by the API bypass RLS.
ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inventory ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.gift_cards ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.email_accounts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow authenticated insert orders" ON public.orders;
DROP POLICY IF EXISTS "Insertions autorisÃƒÂ©es" ON public.orders;
DROP POLICY IF EXISTS "Allow all access to inventory" ON public.inventory;
DROP POLICY IF EXISTS "Allow public read gift_cards" ON public.gift_cards;

REVOKE ALL ON TABLE public.orders, public.inventory, public.gift_cards,
  public.clients, public.customers, public.email_accounts
  FROM PUBLIC, anon, authenticated;

ALTER FUNCTION public.handle_user_update() SET search_path = pg_catalog, public;
REVOKE ALL ON FUNCTION public.handle_user_update() FROM PUBLIC, anon, authenticated;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL ON TABLES FROM PUBLIC, anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL ON SEQUENCES FROM PUBLIC, anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, anon, authenticated;

COMMIT;
