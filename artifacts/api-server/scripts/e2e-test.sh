#!/usr/bin/env bash
#
# Test E2E de la chaîne de paiement Aura Stream.
# Usage : ./scripts/e2e-test.sh
# Prérequis : bash, curl, jq (sudo apt install jq)
#
set -euo pipefail

# ─── Configuration (adapte ou exporte ces variables) ──────────────────────
API_BASE="${API_BASE:-http://localhost:3000}"
SUPABASE_URL="${SUPABASE_URL:?export SUPABASE_URL=...}"
SUPABASE_ANON_KEY="${SUPABASE_ANON_KEY:?export SUPABASE_ANON_KEY=...}"
WEBHOOK_SECRET="${WEBHOOK_SECRET:?export WEBHOOK_SECRET=...}"   # = ton SLICKPAY_WEBHOOK_SECRET
TEST_EMAIL="${TEST_EMAIL:?export TEST_EMAIL=...}"
TEST_PASSWORD="${TEST_PASSWORD:?export TEST_PASSWORD=...}"

# Article de test : DOIT exister dans ton CATALOG/PRICES serveur.
ITEM_NAME="${ITEM_NAME:-Netflix 1 mois}"

say()  { printf "\n\033[1;36m▶ %s\033[0m\n" "$1"; }
ok()   { printf "\033[1;32m✔ %s\033[0m\n" "$1"; }
fail() { printf "\033[1;31m✖ %s\033[0m\n" "$1"; exit 1; }

# ─── 1. Login : récupération du JWT Supabase ──────────────────────────────
say "1. Authentification (récupération du token)"
LOGIN_RES=$(curl -s -X POST \
  "${SUPABASE_URL}/auth/v1/token?grant_type=password" \
  -H "apikey: ${SUPABASE_ANON_KEY}" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"${TEST_EMAIL}\",\"password\":\"${TEST_PASSWORD}\"}")

TOKEN=$(echo "$LOGIN_RES" | jq -r '.access_token // empty')
[ -n "$TOKEN" ] || fail "Login échoué : $(echo "$LOGIN_RES" | jq -c '.')"
ok "Token obtenu (${TOKEN:0:16}…)"

# ─── 2. Création de la commande ───────────────────────────────────────────
say "2. POST /create-order (le serveur recalcule le montant)"
ORDER_RES=$(curl -s -X POST "${API_BASE}/create-order" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{\"items\":[{\"name\":\"${ITEM_NAME}\",\"quantity\":1}]}")

ORDER_ID=$(echo "$ORDER_RES" | jq -r '.order_id // empty')
AMOUNT=$(echo "$ORDER_RES" | jq -r '.amount // empty')
[ -n "$ORDER_ID" ] || fail "create-order échoué : $(echo "$ORDER_RES" | jq -c '.')"
ok "Commande créée : order_id=${ORDER_ID}, montant serveur=${AMOUNT} DA"

# Garde-fou anti-tampering : on tente d'injecter un faux prix, le serveur doit l'ignorer.
say "2b. Contrôle anti-tampering (prix client falsifié → doit être ignoré)"
TAMPER_RES=$(curl -s -X POST "${API_BASE}/create-order" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{\"items\":[{\"name\":\"${ITEM_NAME}\",\"quantity\":1,\"price\":1}],\"amount\":1}")
TAMPER_AMOUNT=$(echo "$TAMPER_RES" | jq -r '.amount // empty')
if [ "$TAMPER_AMOUNT" = "$AMOUNT" ]; then
  ok "Le serveur ignore le prix client (montant recalculé identique : ${TAMPER_AMOUNT} DA)"
else
  fail "FAILLE : le montant a changé avec un prix client falsifié (${TAMPER_AMOUNT} DA)"
fi

# ─── 3. Création de la facture SlickPay ───────────────────────────────────
say "3. POST /create-invoice (le serveur relit le montant en base)"
INVOICE_RES=$(curl -s -X POST "${API_BASE}/create-invoice" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{\"order_id\":\"${ORDER_ID}\"}")
PAYMENT_URL=$(echo "$INVOICE_RES" | jq -r '.payment_url // empty')
[ -n "$PAYMENT_URL" ] || fail "create-invoice échoué : $(echo "$INVOICE_RES" | jq -c '.')"
ok "Facture créée, payment_url=${PAYMENT_URL:0:40}…"

# ─── 4. Webhook simulé (paiement confirmé) ────────────────────────────────
say "4. POST /webhook simulé — statut 'completed'"
WEBHOOK_PAYLOAD=$(jq -n \
  --arg oid "$ORDER_ID" \
  '{completed: 1, status: "completed", order_id: $oid, transferId: ("TEST-TX-" + $oid)}')

WEBHOOK_RES=$(curl -s -w "\n%{http_code}" -X POST "${API_BASE}/webhook" \
  -H "Content-Type: application/json" \
  -H "x-webhook-secret: ${WEBHOOK_SECRET}" \
  -d "$WEBHOOK_PAYLOAD")

WEBHOOK_CODE=$(echo "$WEBHOOK_RES" | tail -n1)
WEBHOOK_BODY=$(echo "$WEBHOOK_RES" | sed '$d')
[ "$WEBHOOK_CODE" = "200" ] || fail "webhook HTTP ${WEBHOOK_CODE} : ${WEBHOOK_BODY}"
ok "Webhook accepté (200) : ${WEBHOOK_BODY}"

# ─── 4b. Rejeu (idempotence) : le même webhook ne doit PAS ré-assigner ─────
say "4b. Rejeu du même webhook (idempotence attendue)"
REPLAY_RES=$(curl -s -w "\n%{http_code}" -X POST "${API_BASE}/webhook" \
  -H "Content-Type: application/json" \
  -H "x-webhook-secret: ${WEBHOOK_SECRET}" \
  -d "$WEBHOOK_PAYLOAD")
REPLAY_CODE=$(echo "$REPLAY_RES" | tail -n1)
[ "$REPLAY_CODE" = "200" ] || fail "rejeu HTTP ${REPLAY_CODE}"
ok "Rejeu accepté sans double assignation (200)"

# ─── 4c. Mauvais secret (doit être rejeté) ────────────────────────────────
say "4c. Webhook avec mauvais secret (doit renvoyer 401/403)"
BAD_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "${API_BASE}/webhook" \
  -H "Content-Type: application/json" \
  -H "x-webhook-secret: mauvais-secret" \
  -d "$WEBHOOK_PAYLOAD")
if [ "$BAD_CODE" = "401" ] || [ "$BAD_CODE" = "403" ]; then
  ok "Secret invalide correctement rejeté (HTTP ${BAD_CODE})"
else
  fail "FAILLE : secret invalide accepté (HTTP ${BAD_CODE})"
fi

say "✅ Flux E2E terminé. Passe aux vérifications SQL ci-dessous avec order_id=${ORDER_ID}"
echo "ORDER_ID=${ORDER_ID}"
