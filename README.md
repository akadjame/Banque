# Banque d'épargne en ligne

Site public, espace client et back-office pour une offre de livrets d'épargne en ligne : taux boosté, prime de bienvenue, parrainage.

Stack : Node.js ≥ 22.13 (SQLite intégré `node:sqlite`), Express 5, EJS. Pas de dépendance native.

## Démarrage

```bash
npm install
npm run create-admin -- admin@votre-domaine.fr "MotDePasseSolide1" Prénom Nom
npm start            # http://localhost:3000
```

Données de démonstration (base vide uniquement) : `npm run seed-demo`
→ `admin@demo.local`, `client@demo.local`, `filleul@demo.local`, mot de passe `Demo12345!`.

Tests : `npm test`

## Personnalisation (variables d'environnement)

| Variable | Rôle |
|---|---|
| `BANK_NAME`, `BANK_SUBTITLE`, `BANK_LEGAL_NAME` | Nom et marque affichés |
| `BANK_SUPPORT_EMAIL`, `BANK_SUPPORT_PHONE` | Contact |
| `BANK_CODE`, `BRANCH_CODE` | Codes banque/guichet utilisés pour générer les IBAN des livrets |
| `PORT`, `DB_PATH`, `NODE_ENV=production` | Serveur (cookies `Secure` en production, à placer derrière HTTPS) |

Le logo se trouve dans `public/img/logo.svg`, les couleurs en tête de `public/css/style.css`.
Les taux, primes et la date de fin d'offre se règlent dans l'admin (**Offres & taux**).

## Fonctionnement

**Site public** : accueil avec l'offre du moment, nos livrets, simulateur de gains, parrainage, FAQ, ouverture de livret en ligne (identité, compte de référence, code parrain).

**Espace client** (`/espace`) :
- synthèse : épargne totale, intérêts acquis en temps réel, dernières opérations
- détail de chaque livret : historique filtrable, relevés mensuels imprimables, RIB
- alimenter : IBAN du livret à créditer par virement depuis le compte de référence
- retrait : demande de virement **uniquement vers le compte de référence**, annulable tant qu'elle n'est pas traitée
- ouverture d'un livret supplémentaire, parrainage (code et lien), messagerie sécurisée, profil (changer le compte de référence nécessite le mot de passe)

**Administration** (`/admin`) :
- tableau de bord : encours, intérêts acquis, éléments à traiter
- clients : recherche, validation des dossiers, blocage, création manuelle, réinitialisation du mot de passe
- par livret : **créditer** (versement reçu, prime) ou débiter (régularisation), avec un libellé visible par le client ; verser les intérêts ; bloquer ou clôturer
- primes de bienvenue et de parrainage en un clic (une seule fois par client)
- retraits : l'établissement émet le virement vers l'IBAN de référence, puis clique sur « Virement effectué », ce qui débite le livret
- versement des intérêts sur tous les livrets
- messagerie, journal de toutes les actions admin

**Intérêts** : calculés au jour le jour sur le solde de fin de journée. Pendant la période de boost, le taux boosté s'applique jusqu'au plafond et le taux de base au-delà. Ils s'affichent en temps réel et sont versés par l'admin.

## Avant une mise en production

- Collecter des dépôts du public exige un agrément (ACPR) ou un partenariat avec un établissement agréé (Banking-as-a-Service). Il faut aussi des procédures KYC/LCB-FT et une garantie des dépôts.
- Compléter les mentions légales, les CGU et la politique RGPD (`views/mentions.ejs`).
- HTTPS obligatoire, sauvegardes de `data/banque.db`, envoi d'e-mails (confirmation, mot de passe oublié), double authentification.
