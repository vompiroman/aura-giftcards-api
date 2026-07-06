# Aura Stream API

## Tests

[![Tests](https://github.com/vompiroman/aura-giftcards-api/actions/workflows/tests.yml/badge.svg?branch=main)](https://github.com/vompiroman/aura-giftcards-api/actions/workflows/tests.yml)

Le projet possède deux niveaux de tests complémentaires :

| Suite | Ce qu'elle couvre | Réseau / base réelle | Secrets requis |
|---|---|---|---|
| **Intégration** | Handlers Express isolés (`/create-order`, `/webhook`) avec Supabase et `notifyAdmin` mockés | Non | Aucun |
| **E2E** | Chaîne de paiement complète jusqu'à PostgreSQL (login → commande → facture → webhook) | Oui (staging) | Oui |

### Lancer les tests d'intégration (rapides, sans configuration)

Aucun secret ni base de données n'est nécessaire : tout est mocké.

```bash
npm ci
npm run test:integration
```

### Lancer les tests E2E en local

Les tests E2E s'exécutent contre une **base Supabase de staging dédiée** (jamais la production : ils écrivent, assignent de l'inventaire et suppriment des commandes de test).

1. Copie le fichier d'exemple et remplis-le avec tes valeurs de **staging** :

   ```bash
   cp .env.test.example .env.test
   ```

2. Renseigne les variables dans `.env.test` :

   | Variable | Description |
   |---|---|
   | `API_BASE` | URL de l'API à tester (ex. `http://localhost:3000`) |
   | `SUPABASE_URL` | URL du projet Supabase de **staging** |
   | `SUPABASE_ANON_KEY` | Clé anonyme (login de l'utilisateur de test) |
   | `SUPABASE_SERVICE_ROLE_KEY` | Clé `service_role` de **staging uniquement** (assertions + nettoyage) |
   | `WEBHOOK_SECRET` | Même valeur que `SLICKPAY_WEBHOOK_SECRET` côté serveur |
   | `TEST_EMAIL` / `TEST_PASSWORD` | Compte de test **non-admin** |
   | `ITEM_NAME` / `ITEM_SERVICE` | Article et service de test (ex. `Netflix 1 mois` / `Netflix`) |

3. Lance la suite :

   ```bash
   npm run test:e2e
   ```

> ⚠️ **Sécurité** : `.env.test` est ignoré par Git (voir `.gitignore`) et ne doit **jamais** être commité. La clé `service_role` contourne la RLS — ne l'utilise que sur une base de staging, jamais en production.

### Lancer les deux suites d'affilée

```bash
npm run test:all
```
