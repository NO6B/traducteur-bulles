# Publication dans les boutiques

Paquet : `./scripts/package.sh` crée `dist/traducteur-bulles-<version>.zip` (le même fichier sert partout).

| Boutique | Coût | Lien |
|---|---|---|
| Chrome Web Store (Chrome, Brave, Opera) | 5 $ une fois | https://chrome.google.com/webstore/devconsole |
| Microsoft Edge Add-ons | gratuit | https://partner.microsoft.com/dashboard/microsoftedge |
| Firefox Add-ons (ordinateur et Android) | gratuit | https://addons.mozilla.org/developers/ |

Pour Firefox, cocher « Firefox pour Android » lors de l'envoi : l'extension sera alors installable sur téléphone.

## Fiche (français)

**Nom :** Traducteur de bulles

**Résumé (132 caractères max) :**
Traduis les bulles de BD, manga et webtoons directement sur la page. Gratuit, sans compte, lecture du texte en local.

**Description :**
Traducteur de bulles lit le texte des bulles dans les images et affiche la traduction par-dessus, à la couleur de la bulle.

- Clic droit sur une image : « Traduire les bulles de cette image ».
- Tout un chapitre en un clic (ou Alt+T) : les images sont traduites en avance pendant que tu lis.
- Traduction automatique sur les sites de ton choix.
- 12 langues d'origine (anglais, japonais, coréen, chinois, français, espagnol…) et 13 langues de traduction.
- Clique sur une bulle pour revoir l'original.
- Respect de la vie privée : les images sont lues sur ton appareil ; seul le texte des bulles est envoyé au service de traduction (Google Traduction ou MyMemory). Aucune donnée collectée, aucune pub.

**Catégorie :** Outils / Productivité. **Langue :** français (+ anglais).
**Politique de confidentialité :** https://no6b.github.io/traducteur-bulles/privacy.html

## Listing (English)

**Summary:** Translate speech bubbles in comics, manga and webtoons right on the page. Free, no account, text recognition runs locally.

**Description:** Bubble Translator reads the text in speech bubbles and overlays the translation, matching the bubble colour.
Right-click an image, or translate a whole chapter with one click (Alt+T); upcoming images are translated while you read.
Optional automatic mode per site. 12 source languages, 13 target languages. Images are read on your device; only bubble
text is sent to the translation service (Google Translate or MyMemory). No data collection, no ads.

## Justification des autorisations (Chrome Web Store)

- **Objectif unique :** traduire le texte présent dans les images des pages web.
- **contextMenus :** ajouter « Traduire les bulles de cette image » au clic droit.
- **activeTab / scripting :** afficher les traductions sur la page quand l'utilisateur le demande.
- **host_permissions (tous les sites) :** télécharger les images de la page pour les lire (beaucoup de sites
  hébergent leurs images sur un autre domaine), contacter le service de traduction, et traduire automatiquement
  les sites que l'utilisateur a choisis.
- **offscreen :** exécuter la reconnaissance de texte (PaddleOCR via ONNX Runtime, Tesseract, WebAssembly) hors de la page.
- **storage :** enregistrer les réglages et le cache des traductions.
- **declarativeNetRequestWithHostAccess :** ajouter l'en-tête Referer aux seules requêtes de l'extension
  (images refusées sans lui), jamais à la navigation de l'utilisateur.
- **Code distant :** aucun. Tout le code (dont ONNX Runtime et Tesseract) est dans le paquet. Les seuls fichiers
  téléchargés sont des modèles de reconnaissance (poids ONNX officiels de PaddlePaddle sur huggingface.co, données
  Tesseract sur cdn.jsdelivr.net) : des données, pas du code exécutable.
- **Données :** « contenu de site web » (texte des bulles envoyé au traducteur). Ni vente, ni usage sans rapport avec la fonction.

## Captures conseillées (1280×800)

1. Une page de webtoon avec les bulles traduites.
2. La fenêtre de l'extension (réglages).
3. Avant / après (`assets/demo-avant.jpg`, `assets/demo-apres.jpg`).
