# Application mobile (iOS et Android)

L'application affiche l'espace client du site hébergé, dans une coquille native publiable sur l'App Store et le Google Play Store (Capacitor).

## Prérequis (à la charge de l'établissement)

| Élément | Pourquoi |
|---|---|
| Le site hébergé en HTTPS (par ex. sur Render) | L'application charge l'espace client depuis cette adresse |
| Compte Apple Developer (99 $/an) | Obligatoire pour publier sur l'App Store |
| Un Mac avec Xcode | Apple n'autorise la compilation iOS que sur Mac |
| Compte Google Play Console (25 $, une fois) | Obligatoire pour publier sur le Play Store |
| Android Studio | Compilation de l'application Android |
| Statut réglementaire de l'établissement | Apple et Google demandent, pour une application financière, que l'éditeur soit l'établissement agréé (ou son partenaire) |

## Étapes

1. Remplacer `REMPLACER-PAR-L-ADRESSE-DU-SITE` dans `capacitor.config.json` par l'adresse du site.
2. `npm install`
3. `npm run add:android` et/ou `npm run add:ios`, puis `npm run sync`.
4. Icône : `icon-512.png` (à décliner aux formats demandés, par ex. avec `@capacitor/assets`).
5. `npm run open:android` (Android Studio) ou `npm run open:ios` (Xcode), signer et générer la version de publication.
6. Soumettre dans la Play Console et App Store Connect : fiche, captures d'écran, politique de confidentialité, compte de démonstration pour les testeurs.

En attendant, l'espace client s'installe déjà sur l'écran d'accueil depuis le navigateur (Partager → « Sur l'écran d'accueil » sur iPhone, « Installer l'application » sur Android).
