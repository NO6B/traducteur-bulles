# Traducteur de bulles (extension Chrome)

Traduit le texte des bulles dans les images (BD, manga, webtoons). Gratuit, sans clé d'API.

- OCR : Tesseract.js, exécuté localement dans le navigateur.
- Traduction : point d'accès gratuit de Google Traduction (sans clé), avec MyMemory en secours.
- Fonctionne aussi sur Brave, Edge, Opera et les autres navigateurs basés sur Chromium.

## Installation

1. Ouvrir `chrome://extensions`
2. Activer le « Mode développeur » (en haut à droite)
3. « Charger l'extension non empaquetée » et choisir ce dossier

## Utilisation

- Une image : clic droit dessus, puis « Traduire les bulles de cette image ».
- Toute la page : icône de l'extension, puis « Traduire toutes les images de la page », ou Alt+T.
  Les images sont traduites à l'avance pendant le défilement ; le nombre restant s'affiche sur l'icône.
- Automatique : dans la fenêtre de l'extension, cocher « Traduire automatiquement sur ce site ».
  Chaque page de ce site sera ensuite traduite dès son ouverture.
- Cliquer sur une bulle traduite affiche ou masque l'original. Le bouton « Original » le fait pour toute l'image.
- En cas d'échec, le bouton « Réessayer » relance la lecture de l'image.

## Réglages

- Langue du texte dans l'image : « Automatique » la déduit de la langue de la page (anglais par défaut).
  La choisir à la main si le résultat est mauvais (manga japonais, webtoon coréen…).
- Précision : « Précise » relit chaque bulle seule, agrandie et contrastée (plus lent, nettement plus juste).
  « Rapide » ne relit que les bulles douteuses.
- Les pages déjà traduites sont gardées en cache et se réaffichent instantanément (« Vider le cache » pour repartir de zéro).

## Fonctionnement

- 1re lecture de toute l'image pour repérer les bulles, puis 2e lecture de chaque bulle isolée.
- Nettoyage du texte : majuscules de BD remises en casse normale, symboles parasites retirés, césures recollées.
- Toutes les bulles d'une image sont traduites ensemble : le traducteur a le contexte de la scène.
- Nouvelles tentatives automatiques si le service de traduction est momentanément saturé, puis bascule
  sur le second service.
- Le fond de chaque bulle traduite reprend la couleur de la bulle d'origine.

## Limites

- Qualité de l'OCR : très bonne sur du texte imprimé net (scans anglais, webtoons), moyenne sur le
  japonais vertical et les polices manuscrites ou très stylisées. Des confusions restent possibles (« GO » lu « 60 »).
- Le premier usage d'une langue télécharge ses données OCR (de 2 à 15 Mo) depuis jsDelivr. Elles restent ensuite en cache.
- Le texte des bulles est envoyé au service de traduction choisi (Google ou MyMemory).
- Non pris en charge : images dessinées dans un `<canvas>`, images de fond CSS, pages internes du navigateur.
- Si un site bloque complètement le téléchargement de ses images, l'extension lit à la place une capture de
  la partie visible de l'écran, puis complète la lecture quand on fait défiler la page.
