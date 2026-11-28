# Test du bouton de connexion au panier Aura Stream

Le contrôle affiche « Se connecter ». La variante affiche « Se connecter et reprendre mon panier ». L’écran, le prix et la destination du bouton sont identiques. Les deux versions sont disponibles en français, anglais et arabe.

## Étude mobile locale

Depuis le dépôt frontend, construis une version d’étude avec une date de début locale passée depuis moins de 28 jours. Dans PowerShell, ces valeurs restent dans la session locale.

```powershell
$env:VITE_CHECKOUT_GUEST_LOGIN_AB_START = (Get-Date).ToUniversalTime().AddHours(-1).ToString('yyyy-MM-ddTHH:mm:ssZ')
npm run build
node scripts/test-guest-login-ab.mjs --study fr A
```

Le même script ouvre Chrome avec un panier et un compte fictifs. Passe la langue (`fr`, `en`, `ar`) et le groupe (`A` ou `B`), puis ferme la fenêtre entre deux essais. Toutes les requêtes de l’étude sont servies localement ou simulées.

Recrute six participants, deux par langue. Pour chaque langue, montre d’abord A à une personne et B à l’autre. Donne la même tâche dans les deux versions. « Tu as déjà un compte et un panier. Poursuis jusqu’à l’écran où tu peux vérifier tes coordonnées. » Donne les identifiants fictifs quand l’écran les demande. Après le premier clic, demande ce que la personne pensait retrouver à la fin de la connexion.

| Code | Langue | Version montrée en premier | Premier clic et hésitation | Retour au panier attendu avant de le voir | Coordonnées atteintes | Compréhension de l’autre version |
| --- | --- | --- | --- | --- | --- | --- |
| P1 | FR | A | | | | |
| P2 | FR | B | | | | |
| P3 | EN | A | | | | |
| P4 | EN | B | | | | |
| P5 | AR | A | | | | |
| P6 | AR | B | | | | |

Relève aussi les retours à la ligne du bouton, particulièrement en arabe. Utilise le premier passage pour décrire les réactions spontanées et le second pour comparer la clarté perçue. Les observations peuvent confirmer que le retour au panier est compris et identifier des problèmes d’interface. Avec six participants, elles ne chiffrent pas un effet sur la conversion.

## Conditions de lancement

- Vérifie sur un environnement de test que l’exposition consentie et l’étape `customer_info` remontent sur le même parcours. Vérifie le rapprochement entre exposition, paiement confirmé et remboursement. Les remboursements portefeuille proviennent du registre. Pour SlickPay, vérifie les remboursements exécutés par référence de commande et date de remboursement.
- Attends au moins 120 parcours invités mesurés par jour en moyenne sur 14 jours locaux complets dont la fenêtre de 24 h est échue. Dédoublonne par `journey_id` sur `login_view`, tous services confondus. Une visite sans consentement reste hors de la mesure.
- Préenregistre une date UTC de début à minuit heure d’Alger, les 28 jours de recrutement, l’objectif de 1 600 parcours dans chaque groupe et le calendrier de lecture. La migration SQL et l’API doivent être en place avant le frontend. Après accord de lancement, utilise la même date pour `CHECKOUT_GUEST_LOGIN_AB_START` sur l’API et `VITE_CHECKOUT_GUEST_LOGIN_AB_START` lors du build frontend. Les dates absentes laissent l’expérience désactivée. Vérifie l’accord des deux configurations en préproduction.
- Les visites éligibles sont réparties par le premier chiffre hexadécimal de l’UUID aléatoire existant. Une exposition est inscrite par parcours, indépendamment du nombre de services. Le groupe reste stable pendant la durée du parcours. Les événements concernent une exposition, un échec de connexion soumis ou un échec d’enregistrement des coordonnées ou de préparation de commande. La collecte utilise le consentement existant et conserve les événements 45 jours.
- Durant le recrutement, regarde la répartition et les garde-fous. Un blocage reproductible de connexion ou un montant erroné déclenche un arrêt. Le script signale un déséquilibre d’assignation à partir de 200 expositions si le test du khi carré donne p < 0,001. Pour arrêter la variante, redéploie le build frontend avec la date retirée. En cas d’incident de collecte, retire aussi la date côté API. Conserve les agrégats de l’incident et ne mélange pas une relance à cette cohorte.

Compter les parcours des 14 jours complets en lecture seule. Le seuil correspond à 1 680 parcours.

```sql
with limits as (
  select date_trunc('day', now() at time zone 'Africa/Algiers') - interval '1 day' as stop_local
), gates as (
  select e.journey_id, min(e.recorded_at) as first_gate
  from public.checkout_funnel_events e cross join limits
  where e.stage = 'login_view'
    and e.recorded_at >= ((stop_local - interval '15 days') at time zone 'Africa/Algiers')
    and e.recorded_at < (stop_local at time zone 'Africa/Algiers')
  group by e.journey_id
)
select count(*) as eligible, count(*) / 14.0 as daily_average
from gates cross join limits
where first_gate >= ((stop_local - interval '14 days') at time zone 'Africa/Algiers');
```

## Lecture des résultats

Renseigne la date dans `checkout-guest-login-ab-report.sql` et exécute le SELECT avec un rôle habilité. Les indicateurs de progression et de paiement sont masqués jusqu’à 24 h après la fin du recrutement. Une commande confirmée doit être liée au parcours et être payée dans sa fenêtre. Pour le rapport de remboursement, ajoute les références SlickPay réconciliées au CTE `card_refunds` et mets `card_refunds_complete` à vrai après rapprochement complet. Un remboursement compté doit avoir eu lieu dans les 14 jours après paiement. Exporte les deux lignes agrégées en JSON. Fais l’export final dès que cette fenêtre est fermée pour tout le monde, au jour 43 après le début, avant la purge à 45 jours.

```sh
node checkout-guest-login-ab-analysis.mjs rapport-agrege.json
```

Le critère principal est la différence B − A du taux d’arrivée aux coordonnées parmi les parcours exposés. Le rapport utilise un intervalle de confiance à 95 % de Newcombe. Il conclut à un candidat B à partir de +5 points avec une borne basse positive, un échantillon complet et des garde-fous exploitables. Pour chaque garde-fou, la borne haute de la hausse doit être au plus +2 points. L’absence de données de remboursement reste visible et bloque la recommandation. [Méthode statistique](https://pubmed.ncbi.nlm.nih.gov/9595617/)
