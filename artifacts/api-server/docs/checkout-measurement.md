# Plan de mesure du parcours d’achat Aura Stream

Le suivi du parcours repose sur la mesure interne facultative déjà disponible. Les pages de connexion, de compte, de récupération, d’administration et de l’espace partenaire ne créent aucun événement de parcours. Le point qui représente la connexion se mesure au moment où le panier présente son écran de connexion requise.

## Cartographie et chiffres disponibles

| Étape | Déclencheur | Chiffre interprétable |
|---|---|---|
| Fiche produit | Une fiche est affichée | Parcours mesurés qui voient une fiche et part de ces parcours qui ajoutent le service |
| Ajout au panier | Le service entre dans le panier | Parcours mesurés qui ajoutent le service et part qui ouvre le panier ensuite |
| Panier | Le panier contenant le service est affiché | Parcours mesurés qui ouvrent le panier et part qui voit ensuite l’écran de connexion requise ou les coordonnées |
| Connexion requise | Le panier confirme qu’une connexion est nécessaire | Part des parcours arrivés à cet écran qui atteint les coordonnées |
| Coordonnées | Le formulaire du panier est affiché à un client connecté | Part qui atteint le récapitulatif |
| Récapitulatif | Les coordonnées sont validées et le récapitulatif est affiché | Part qui atteint la préparation du paiement |
| Paiement préparé | Une facture SlickPay définitive est enregistrée ou le portefeuille confirme la commande | Part qui aboutit à un achat confirmé |
| Achat confirmé | La base enregistre une confirmation par l’API SlickPay ou le portefeuille | Nombre de commandes confirmées et nombre de ces commandes associées à un parcours mesuré |

Les étapes sont dédupliquées par parcours, service et étape. La mesure d’un parcours couvre 24 heures à partir de sa première étape. Le tableau de bord affiche les 30 journées closes en heure d’Alger pour lesquelles ces 24 heures se sont écoulées. Les taux utilisent le nombre de parcours réellement arrivés à l’étape comme dénominateur. Un parcours multiservice peut figurer dans plusieurs lignes. Une commande confirmée compte une seule fois dans le total, y compris si le client revient plusieurs fois, qu’un webhook est rejoué ou qu’un paiement confirmé est remboursé plus tard.

## Résultats avant et après

| Scénario | Avant | Après |
|---|---|---|
| Revenir aux coordonnées et rouvrir le récapitulatif | **2** événements `InitiateCheckout` mis en file, avec **0** facture demandée | **1** récapitulatif mesuré. La préparation et l’achat sont comptés séparément à partir de la base |
| Première vue produit en erreur HTTP 503 | La vue était perdue au changement d’écran | La même vue est rejouée après rechargement avec son heure d’origine. Le serveur déduplique les répétitions |
| Paramètre de campagne contenant un faux e-mail | La valeur fictive figurait dans **4** événements mis en file par le Pixel. L’ancien serveur envoyait aussi un e-mail haché à Meta | **0** appel de mesure externe sur les parcours testés. Aucun paramètre de campagne, e-mail, téléphone, mot de passe ou identifiant de compte dans les événements du navigateur |
| Confirmation SlickPay reçue par plusieurs chemins | La base dédupliquait déjà le paiement. L’envoi Meta pouvait être perdu après un échec réseau | La préparation laisse le compteur d’achats à **0**. Le retour client et le webhook concurrents, suivis d’un rejeu, donnent **1** achat confirmé. Le double clic portefeuille donne **1** commande et **1** débit |
| Consultation des écrans privés | L’exclusion dépendait de l’état du Pixel et des redirections du navigateur | **0** événement produit à l’ouverture des écrans privés testés, même à partir d’un panier rempli avec un ancien consentement Meta |

Les essais utilisent un navigateur et une base PostgreSQL locale avec des comptes, réponses et paiements fictifs. Les anciens consentements Meta ne se substituent pas à l’accord de mesure interne. Une révocation arrête la collecte et annule les envois en attente dans le navigateur. Les événements déjà acceptés sont retirés par la purge à 45 jours. La liaison avec une commande réside dans une table privée et le panneau admin ne renvoie que des agrégats.

Les chiffres de parcours couvrent les visiteurs consentants. Les changements de définition de la connexion requise et de la préparation du paiement rendent les séries antérieures difficilement comparables. L’attribution par campagne et le ROAS Meta seront indisponibles avec cette version. Le total de commandes confirmées est un volume brut, distinct du chiffre d’affaires net ou des remboursements.

La publication nécessite l’accord de l’exploitant. L’ordre est d’appliquer la migration Supabase, puis de publier l’API et enfin le frontend.
