# Traducteur de bulles (extension Chrome)

Traduit le texte des bulles dans les images (BD, manga, webtoons). Gratuit, sans clé d'API.

- OCR : Tesseract.js, exécuté localement dans le navigateur.
- Traduction : point d'accès gratuit de Google Traduction (sans clé), avec MyMemory en secours.

## Installation

1. Ouvrir `chrome://extensions`
2. Activer le « Mode développeur » (en haut à droite)
3. « Charger l'extension non empaquetée » et choisir ce dossier

## Utilisation

- Une image : clic droit dessus, puis « Traduire les bulles de cette image ».
- Toute la page : icône de l'extension, puis « Traduire toutes les images de la page », ou Alt+T.
  Les images chargées pendant le défilement sont traduites au fur et à mesure.
- Cliquer sur une bulle traduite affiche ou masque l'original. Le bouton « Original » le fait pour toute l'image.
- Dans la fenêtre de l'extension, choisir la langue du texte de l'image : c'est elle qui détermine l'OCR.

## Limites

- Qualité de l'OCR : très bonne sur du texte imprimé net (scans anglais, webtoons), moyenne sur le
  japonais vertical et les polices manuscrites ou stylisées.
- Le premier usage d'une langue télécharge ses données OCR (de 2 à 15 Mo) depuis jsDelivr. Elles restent ensuite en cache.
- Le texte des bulles est envoyé au service de traduction choisi (Google ou MyMemory).
- Si un site bloque complètement le téléchargement de ses images, l'extension lit à la place une capture de
  la partie visible de l'écran, puis complète la lecture quand on fait défiler la page.
