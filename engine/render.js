// Rendu « comme un scan traduit » : efface le texte d'origine de chaque bulle
// et y écrit la traduction, centrée, à la plus grande taille qui tient.
// Expose globalThis.TBRender = { loadFont, draw }.
(() => {
const FONT_STACK = '"TB Comic", "Comic Neue", "Comic Sans MS", "Chalkboard SE", "Segoe Print", sans-serif';

async function loadFont(url) {
  try {
    const face = new FontFace('TB Comic', `url(${url})`, { weight: '700' });
    await face.load();
    document.fonts.add(face);
  } catch {
    // Police indisponible : les polices du système prennent le relais.
  }
}

// Coupe le texte en lignes de largeur maxW (par mot, ou par caractère pour le japonais et le chinois).
function wrap(ctx, text, maxW, byChar) {
  const units = byChar ? [...text] : text.split(/\s+/);
  const sep = byChar ? '' : ' ';
  const lines = [];
  let cur = '';
  for (const u of units) {
    const next = cur ? cur + sep + u : u;
    if (ctx.measureText(next).width <= maxW || !cur) {
      cur = next;
    } else {
      lines.push(cur);
      cur = u;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

function fits(ctx, text, size, w, h, byChar) {
  ctx.font = `700 ${size}px ${FONT_STACK}`;
  const lines = wrap(ctx, text, w, byChar);
  const widest = Math.max(...lines.map((l) => ctx.measureText(l).width));
  return { ok: widest <= w && lines.length * size * 1.15 <= h, lines };
}

function layout(ctx, text, w, h, byChar) {
  let lo = 6, hi = Math.max(8, Math.min(h, 90));
  for (let i = 0; i < 9; i++) {
    const mid = (lo + hi) / 2;
    if (fits(ctx, text, mid, w, h, byChar).ok) lo = mid; else hi = mid;
  }
  return { size: lo, lines: fits(ctx, text, lo, w, h, byChar).lines };
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// source : ImageBitmap, <img> ou <canvas>. bubbles : coordonnées normalisées (0..1) sur l'image entière.
function draw(source, bubbles, { targetLang = 'fr' } = {}) {
  const W = source.width, H = source.height;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(source, 0, 0);
  const byChar = /^(ja|zh)/.test(targetLang);
  const minReadable = Math.max(11, W / 70);

  for (const b of bubbles) {
    const text = b.translation;
    if (!text) continue;
    const pad = b.pad * W;
    let x = b.x * W - pad, y = b.y * H - pad, w = b.w * W + 2 * pad, h = b.h * H + 2 * pad;
    // Effacement du texte d'origine (zone d'origine seulement : on ne touche pas au contour de la bulle).
    ctx.fillStyle = b.bg || '#fff';
    roundRect(ctx, x, y, w, h, Math.min(w, h) * 0.3);
    ctx.fill();
    let lay = layout(ctx, text, w * 0.94, h * 0.94, byChar);
    // Texte trop petit : on agrandit un peu la zone (elle reste en général dans la bulle).
    for (const grow of [1.2, 1.4]) {
      if (lay.size >= minReadable) break;
      const nw = Math.min(W, w * grow), nh = Math.min(H, h * (1 + (grow - 1) * 0.6));
      x = Math.max(0, Math.min(W - nw, x - (nw - w) / 2));
      y = Math.max(0, Math.min(H - nh, y - (nh - h) / 2));
      w = nw;
      h = nh;
      lay = layout(ctx, text, w * 0.94, h * 0.94, byChar);
    }
    // Écriture de la traduction.
    ctx.fillStyle = b.dark ? '#fff' : '#111';
    ctx.font = `700 ${lay.size}px ${FONT_STACK}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const lh = lay.size * 1.15;
    const top = y + h / 2 - (lay.lines.length * lh) / 2 + lh / 2;
    lay.lines.forEach((line, i) => ctx.fillText(line, x + w / 2, top + i * lh));
  }
  return canvas;
}

globalThis.TBRender = { loadFont, draw };
})();
