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

## Configuration SlickPay

La création d'une facture utilise `SLICKPAY_PUBLIC_KEY`, `SLICKPAY_WEBHOOK_URL`,
`WEBHOOK_SECRET` et `FRONTEND_URL`. Configure aussi `SLICKPAY_ACCOUNT_UUID` avec
l'UUID du compte bénéficiaire SlickPay. Ce dernier est indispensable lorsqu'aucun
compte bénéficiaire par défaut n'est défini dans SlickPay.

## Suivi Meta et alertes de stock

Le webhook de paiement peut envoyer l'événement `Purchase` à la Conversion API Meta. Configure `META_CAPI_ACCESS_TOKEN` et, si nécessaire, `META_PIXEL_ID` et `META_GRAPH_API_VERSION`. L'adresse email est normalisée puis hachée en SHA-256 avant l'envoi ; aucun identifiant de compte streaming n'est transmis.

Le workflow `stock-alerts.yml` appelle chaque jour la route protégée `/api/cron/stock-alerts`. Configure les secrets GitHub `PRODUCTION_API_ORIGIN` et `CRON_SECRET`, ainsi que `DISCORD_ADMIN_WEBHOOK_URL`, `LOW_STOCK_THRESHOLD` et `LOW_STOCK_SERVICES` sur le serveur.

## E-mails transactionnels et factures

Après le passage d'une commande à `paid`, le serveur envoie un e-mail de confirmation dédupliqué avec une facture PDF jointe. Les anciennes commandes déjà payées ne sont pas renvoyées. Configure les variables suivantes sur Render :

| Variable | Description |
|---|---|
| `RESEND_API_KEY` | Clé API Resend du domaine vérifié (secret, optionnelle si SMTP est configuré) |
| `SMTP_HOST` | Serveur SMTP, par exemple `smtp.hostinger.com` |
| `SMTP_PORT` | `465` pour SSL ou `587` pour STARTTLS |
| `SMTP_USER` | Adresse complète de la boîte mail professionnelle |
| `SMTP_PASSWORD` | Mot de passe de la boîte mail (secret). Les anciens secrets `IMAP_ADMIN_PASS` et `OUTLOOK_PASSWORD` restent acceptés comme alias de migration. |
| `TRANSACTIONAL_FROM_EMAIL` | Adresse professionnelle expéditrice, par exemple `admin@aura-stream.com` |
| `TRANSACTIONAL_FROM_NAME` | Nom affiché, par défaut `Aura Stream` |
| `TRANSACTIONAL_REPLY_TO` | Adresse professionnelle qui reçoit les réponses (optionnelle) |

Resend est prioritaire lorsqu'une clé est présente ; sinon le serveur utilise SMTP. Le même transport envoie les confirmations d'achat et les liens de récupération générés côté serveur par Supabase Admin. Les identifiants d'activation Spotify/Crunchyroll ne sont jamais inclus dans l'e-mail ni dans la facture.

Le modèle `supabase/templates/recovery.html` reste versionné comme solution de repli si l'envoi est un jour redirigé vers le SMTP natif de Supabase.
