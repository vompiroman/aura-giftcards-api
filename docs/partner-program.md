# Programme partenaire Aura Stream

## Architecture
- Supabase Auth reste la source d’identité. Les comptes partenaires sont une extension 1:1 de `auth.users`, sans données financières dans les métadonnées utilisateur.
- Si Supabase demande de confirmer l’e-mail, le questionnaire est conservé côté serveur et soumis à la première connexion, même depuis un autre appareil.
- L’API Express garde les prix catalogue, contrôles administrateur et sessions existants. Le navigateur ne propose qu’un montant attendu : il ne peut fixer ni solde, ni taux, ni total facturé.
- Le registre DZD utilise des montants décimaux exacts. Une écriture par opération, un verrou par compte et des clés de rejeu empêchent deux confirmations ou deux débits de produire deux mouvements.
- Les seuils et taux sont centralisés dans `partner_tiers`. Un dépôt confirmé en une seule fois de 3 000 DA débloque définitivement les paliers. Seules les commandes partenaire payées augmentent le cumul, qu’elles soient réglées par SlickPay ou par portefeuille.
- Les remises partenaire, fidélité et promo ne se cumulent pas : la meilleure s’applique. Le prix est établi avant paiement ; atteindre un seuil ne modifie pas la commande qui l’a déclenché. Un changement entre affichage et validation demande une nouvelle validation au client.
- Les recharges ne sont pas des commandes et n’envoient ni accès ni e-mail de livraison. Le retour client, les webhooks et le rattrapage vérifient tous la facture auprès de SlickPay. Les paiements portefeuille reprennent la livraison et les e-mails existants.
- Une annulation administrative d’un achat portefeuille payé, en attente et sans profil attribué recrédite le portefeuille et retire la dépense du cumul. Les commandes déjà livrées ne sont pas remboursées automatiquement. Les recharges ne sont pas retirables depuis le site.

## Mise en service
1. Appliquer `supabase/migrations/20261114193941_partner_program.sql` sur la base de test puis sur la cible. Vérifier les tables, contraintes et permissions (rôle serveur uniquement). Aucun changement n’est nécessaire chez SlickPay : le service réemploie les variables API, URL de retour et webhook existantes.
2. En préproduction uniquement, utiliser `SLICKPAY_SANDBOX=true` avec un compte et des clés de test SlickPay, une base isolée et les URL de retour et de webhook de préproduction. Vérifier au moins une recharge et un achat (y compris le callback).
3. Déployer l’API et le site. Tant que `PARTNER_PROGRAM_ENABLED` est absent, le site ne présente pas le programme et l’API n’interroge pas le nouveau schéma. Configurer `AUTO_APPROVE_PARTNERS=false` (validation admin par défaut) ou `true` (acceptation immédiate après questionnaire), puis `PARTNER_PROGRAM_ENABLED=true` sur Render une fois le parcours de test validé.
4. Pour suspendre les nouvelles opérations après déploiement, utiliser `PARTNER_PROGRAM_ENABLED=false` : les factures déjà créées et les remboursements restent traitables. Ne pas supprimer le schéma ni retirer la variable si des soldes ou factures existent.

Ne pas exposer de clé de rôle serveur ou SlickPay côté site. Vérifier les règles de remboursement et la configuration du compte commerçant avant l’ouverture publique des recharges.

## Vérification
`pnpm --filter @workspace/api-server test:integration`, vérification TypeScript et build API, `npm run check` côté site. CI installe une version fixe de PGlite dans un répertoire temporaire et exécute `scripts/test-partner-database.mjs` sur une base PostgreSQL jetable. Le test applique la migration réelle, ainsi que la fonction d’observation SlickPay existante, à une structure de test sans données client. Il vérifie les droits, le traitement des candidatures, les montants de recharge, les doublons, le débit, les paliers et le remboursement. Le test navigateur utilise des réponses fictives, sans facturation réelle.

