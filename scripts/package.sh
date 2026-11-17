#!/bin/sh
# Fabrique le paquet de l'extension (Chrome Web Store, Edge, Firefox) dans dist/.
set -e
cd "$(dirname "$0")/.."
VERSION=$(sed -n 's/.*"version": "\(.*\)".*/\1/p' manifest.json)
OUT="dist/traducteur-bulles-$VERSION.zip"
mkdir -p dist
rm -f "$OUT"
zip -qr "$OUT" manifest.json background.js content.js offscreen.html offscreen.js popup.html popup.js \
  welcome.html i18n.js engine/ocr.js engine/translate.js lib icons _locales fonts \
  -x '*.DS_Store'
echo "$OUT ($(du -h "$OUT" | cut -f1))"
