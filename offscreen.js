// Document offscreen : héberge le Web Worker Tesseract (OCR 100 % local).
/* global Tesseract */

const CJK_LANGS = new Set(['jpn', 'jpn_vert', 'chi_sim', 'chi_tra', 'kor']);
const TILE_H = 3000;      // hauteur max d'une tuile (px après mise à l'échelle)
const TILE_OVERLAP = 300; // recouvrement entre tuiles (webtoons très hauts)
const TARGET_TEXT_PX = 36; // hauteur de lettre visée pour la seconde lecture

let worker = null;
let workerLang = null;
let queue = Promise.resolve();

async function getWorker(lang) {
  if (worker && workerLang === lang) return worker;
  await resetWorker();
  // Les données de langue sont téléchargées une seule fois puis gardées en cache (IndexedDB).
  worker = await Tesseract.createWorker(lang, 1, {
    workerPath: chrome.runtime.getURL('lib/worker.min.js'),
    corePath: chrome.runtime.getURL('lib/core/'),
    workerBlobURL: false,
  });
  await worker.setParameters({ preserve_interword_spaces: CJK_LANGS.has(lang) ? '1' : '0' });
  workerLang = lang;
  return worker;
}

async function resetWorker() {
  const w = worker;
  worker = null;
  workerLang = null;
  if (w) await w.terminate().catch(() => {});
}

async function recognize(w, canvas, psm) {
  await w.setParameters({ tessedit_pageseg_mode: psm });
  const { data } = await w.recognize(canvas, {}, { blocks: true, text: false });
  return data;
}

async function loadBitmap(source) {
  let blob;
  if (source.dataUrl) {
    blob = await (await fetch(source.dataUrl)).blob();
  } else {
    const res = await fetch(source.url, { credentials: 'include' });
    if (!res.ok) throw new Error(`téléchargement refusé (HTTP ${res.status})`);
    blob = await res.blob();
  }
  return createImageBitmap(blob);
}

const letterCount = (s) => (s.match(/\p{L}/gu) || []).length;
const median = (arr) => {
  const s = [...arr].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
};

// Extrait les lignes d'un résultat Tesseract (mots sous le seuil de confiance ignorés).
function extractLines(data, lang, minConf, weak = []) {
  const cjk = CJK_LANGS.has(lang);
  const lines = [];
  for (const block of data.blocks || []) {
    for (const para of block.paragraphs || []) {
      for (const line of para.lines || []) {
        for (const w of line.words || []) {
          if (w.confidence < minConf && letterCount(w.text) >= 1) weak.push(w.bbox);
        }
        const words = (line.words || []).filter((w) => w.confidence >= minConf && w.text.trim());
        if (!words.length) continue;
        const text = words.map((w) => w.text.trim()).join(cjk ? '' : ' ');
        const letters = letterCount(text);
        if (letters < (cjk ? 1 : 2)) continue;
        if (letters / text.replace(/\s/g, '').length < 0.5) continue; // surtout des symboles : bruit
        lines.push({
          text,
          x0: Math.min(...words.map((w) => w.bbox.x0)),
          y0: Math.min(...words.map((w) => w.bbox.y0)),
          x1: Math.max(...words.map((w) => w.bbox.x1)),
          y1: Math.max(...words.map((w) => w.bbox.y1)),
          conf: Math.min(...words.map((w) => w.confidence)),
          meanConf: words.reduce((s, w) => s + w.confidence, 0) / words.length,
        });
      }
    }
  }
  return lines;
}

// Regroupe les lignes proches en bulles (union-find sur rectangles élargis).
function groupLines(lines, vertical) {
  const size = (l) => (vertical ? l.x1 - l.x0 : l.y1 - l.y0);
  const parent = lines.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < lines.length; i++) {
    for (let j = i + 1; j < lines.length; j++) {
      const a = lines[i], b = lines[j];
      const sa = size(a), sb = size(b);
      if (Math.max(sa, sb) / Math.max(1, Math.min(sa, sb)) > 2) continue; // tailles trop différentes
      // Interligne d'une bulle : jusqu'à ~1,2 hauteur de lettre ; dans le sens de lecture : ~1 espace large.
      const s = Math.min(sa, sb);
      const mx = vertical ? 1.2 * s : 0.9 * s;
      const my = vertical ? 0.9 * s : 1.2 * s;
      const overlap = a.x0 - mx < b.x1 && b.x0 - mx < a.x1 && a.y0 - my < b.y1 && b.y0 - my < a.y1;
      if (overlap) parent[find(i)] = find(j);
    }
  }
  const groups = new Map();
  lines.forEach((l, i) => {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(l);
  });
  return [...groups.values()];
}

// Les textes de BD sont souvent EN MAJUSCULES : on les remet en casse normale pour mieux traduire.
function normalizeCase(text) {
  const letters = text.match(/\p{L}/gu) || [];
  const upper = letters.filter((c) => c === c.toUpperCase() && c !== c.toLowerCase()).length;
  if (letters.length < 4 || upper / letters.length < 0.8) return text;
  // Confusions OCR fréquentes dans les mots en capitales : « Y0U », « 5TOP »…
  const LOOKALIKE = { 0: 'O', 1: 'I', 5: 'S', 6: 'G', 8: 'B' };
  text = text.replace(/\S+/g, (tok) =>
    /\p{L}/u.test(tok) && /[01568]/.test(tok) && !/[2-47-9]/.test(tok)
      ? tok.replace(/[01568]/g, (d) => LOOKALIKE[d])
      : tok);
  return text
    .toLowerCase()
    .replace(/(^[^\p{L}]*|[.!?…]\s+[^\p{L}\s]?)(\p{L})/gu, (_, p, c) => p + c.toUpperCase())
    .replace(/\bi\b/g, 'I')
    .replace(/\bi(['’])/g, 'I$1');
}

// Nettoyage typographique courant après OCR.
function tidy(text) {
  text = text.replace(/[|]/g, 'I');
  // Symboles isolés captés sur le contour de la bulle ou le dessin.
  text = text.split(/\s+/).filter((t) => /[\p{L}\p{N}]/u.test(t) || /^[!?.…]+$/.test(t)).join(' ');
  if ((text.match(/"/g) || []).length % 2) text = text.replace(/"/g, '');
  text = text.replace(/^[_~=*^`'"-]+(?=\p{L})/u, '').replace(/[_~=*^`]+$/, '');
  return text
    .replace(/[|]/g, 'I')
    .replace(/\s+([,.!?…])/g, '$1')
    .replace(/([!?])\s*(?=[!?])/g, '$1')
    .replace(/\.{4,}/g, '...')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function joinLines(lines, lang, vertical) {
  const cjk = CJK_LANGS.has(lang);
  const sorted = [...lines].sort((a, b) => (vertical ? b.x0 - a.x0 : a.y0 - b.y0));
  let text = '';
  for (const l of sorted) {
    const t = cjk ? l.text.replace(/\s+/g, '') : l.text;
    if (!text) text = t;
    else if (cjk) text += t;
    else if (/\p{L}-$/u.test(text) && /^\p{Ll}/u.test(t)) text = text.slice(0, -1) + t; // césure
    else text += ' ' + t;
  }
  return cjk ? text : tidy(normalizeCase(tidy(text)));
}

// Un texte très court (« yd ») trouvé dans le dessin est souvent du bruit : on exige alors une forte confiance.
function plausible(group, lang) {
  const letters = group.reduce((n, l) => n + letterCount(l.text), 0);
  if (letters >= (CJK_LANGS.has(lang) ? 2 : 4)) return true;
  return Math.min(...group.map((l) => l.conf)) >= 85;
}

// Couleur de fond de la bulle : médiane des pixels autour du texte.
function sampleBackground(ctx, w, h, inner) {
  const { data } = ctx.getImageData(0, 0, w, h);
  const rs = [], gs = [], bs = [];
  const step = Math.max(1, Math.floor(Math.sqrt((w * h) / 4000)));
  for (let y = 0; y < h; y += step) {
    for (let x = 0; x < w; x += step) {
      if (x >= inner.x0 && x <= inner.x1 && y >= inner.y0 && y <= inner.y1) continue;
      const i = (y * w + x) * 4;
      rs.push(data[i]); gs.push(data[i + 1]); bs.push(data[i + 2]);
    }
  }
  if (!rs.length) return null;
  return [median(rs), median(gs), median(bs)];
}

// Niveaux de gris + étirement du contraste ; inversion si texte clair sur fond sombre.
function enhance(ctx, w, h, bg) {
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const lum = new Uint8ClampedArray(w * h);
  const hist = new Uint32Array(256);
  for (let i = 0, p = 0; p < lum.length; i += 4, p++) {
    const v = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000;
    lum[p] = v;
    hist[lum[p]]++;
  }
  const pct = (q) => {
    let acc = 0;
    for (let v = 0; v < 256; v++) if ((acc += hist[v]) >= q * lum.length) return v;
    return 255;
  };
  const lo = pct(0.02), hi = Math.max(lo + 1, pct(0.98));
  const invert = bg && (bg[0] * 299 + bg[1] * 587 + bg[2] * 114) / 1000 < 110;
  for (let i = 0, p = 0; p < lum.length; i += 4, p++) {
    let v = ((lum[p] - lo) * 255) / (hi - lo);
    if (invert) v = 255 - v;
    d[i] = d[i + 1] = d[i + 2] = v;
  }
  ctx.putImageData(img, 0, 0);
}

// Seconde lecture d'une bulle isolée, agrandie et contrastée : plus précise que la lecture globale.
async function refine(w, bitmap, box, textSize, lang, vertical, precise) {
  // Marge plus large dans le sens de lecture pour rattraper les mots oubliés par la 1re passe.
  const padX = Math.max(4, (vertical ? 1.8 : 2.2) * textSize);
  const padY = Math.max(4, (vertical ? 2.2 : 1.8) * textSize);
  const x0 = Math.max(0, Math.floor(box.x0 - padX)), y0 = Math.max(0, Math.floor(box.y0 - padY));
  const x1 = Math.min(bitmap.width, Math.ceil(box.x1 + padX)), y1 = Math.min(bitmap.height, Math.ceil(box.y1 + padY));
  const cw = x1 - x0, ch = y1 - y0;
  let s = Math.min(4, Math.max(1, TARGET_TEXT_PX / Math.max(1, textSize)));
  s = Math.min(s, 1800 / Math.max(cw, ch));
  const W = Math.max(1, Math.round(cw * s)), H = Math.max(1, Math.round(ch * s));
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, x0, y0, cw, ch, 0, 0, W, H);
  const inner = {
    x0: (box.x0 - x0) * s - 2, y0: (box.y0 - y0) * s - 2,
    x1: (box.x1 - x0) * s + 2, y1: (box.y1 - y0) * s + 2,
  };
  const bg = sampleBackground(ctx, W, H, inner);
  if (!precise) return { bg };

  enhance(ctx, W, H, bg);
  const data = await recognize(w, canvas, vertical ? '5' : '6');
  // Lignes de même taille que le texte de la bulle (pas le décor), en coordonnées source.
  const candidates = extractLines(data, lang, 30)
    .map((l) => ({ ...l, sx0: x0 + l.x0 / s, sy0: y0 + l.y0 / s, sx1: x0 + l.x1 / s, sy1: y0 + l.y1 / s }))
    .filter((l) => {
      const size = vertical ? l.sx1 - l.sx0 : l.sy1 - l.sy0;
      return size > 0.5 * textSize && size < 1.8 * textSize;
    });
  // On part de la zone de la 1re passe et on ajoute de proche en proche les lignes collées
  // (ligne oubliée juste au-dessus, mot manquant) sans déborder sur une bulle voisine.
  const mx = (vertical ? 1.3 : 0.9) * textSize, my = (vertical ? 0.9 : 1.3) * textSize;
  const zone = { ...box };
  const lines = [];
  let grew = true;
  while (grew) {
    grew = false;
    for (const l of candidates) {
      if (lines.includes(l)) continue;
      const touches = l.sx0 < zone.x1 + mx && l.sx1 > zone.x0 - mx && l.sy0 < zone.y1 + my && l.sy1 > zone.y0 - my;
      if (!touches) continue;
      lines.push(l);
      zone.x0 = Math.min(zone.x0, l.sx0); zone.y0 = Math.min(zone.y0, l.sy0);
      zone.x1 = Math.max(zone.x1, l.sx1); zone.y1 = Math.max(zone.y1, l.sy1);
      grew = true;
    }
  }
  if (!lines.length) return { bg };
  const words = lines.reduce((n, l) => n + l.text.split(/\s+/).length, 0);
  const conf = lines.reduce((s2, l) => s2 + l.meanConf * l.text.split(/\s+/).length, 0) / words;
  const found = {
    x0: Math.min(...lines.map((l) => l.sx0)), y0: Math.min(...lines.map((l) => l.sy0)),
    x1: Math.max(...lines.map((l) => l.sx1)), y1: Math.max(...lines.map((l) => l.sy1)),
  };
  return { bg, text: joinLines(lines, lang, vertical), conf, found };
}

async function ocr({ source, crop, lang, precise = true }) {
  const bitmap = await loadBitmap(source);
  try {
    const sx = crop ? crop.x : 0;
    const sy = crop ? crop.y : 0;
    const sw = crop ? Math.min(crop.w, bitmap.width - sx) : bitmap.width;
    const sh = crop ? Math.min(crop.h, bitmap.height - sy) : bitmap.height;
    if (sw < 10 || sh < 10) throw new Error('image trop petite');

    // Agrandir les petites images améliore nettement la détection.
    let scale = Math.min(3, Math.max(1, 1600 / sw));
    if (sw * scale > 4000) scale = 4000 / sw;

    const w = await getWorker(lang);
    const vertical = lang.endsWith('_vert');
    const all = [];
    const weak = []; // mots douteux de la 1re passe : la bulle qui les contient sera relue
    const fullH = Math.round(sh * scale);
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(sw * scale);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    // 1re passe : repérer les bulles sur toute l'image (découpée en tuiles si très haute).
    for (let top = 0; top < fullH; top += TILE_H - TILE_OVERLAP) {
      const tileH = Math.min(TILE_H, fullH - top);
      canvas.height = tileH;
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, tileH);
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(bitmap, sx, sy + top / scale, sw, tileH / scale, 0, 0, canvas.width, tileH);
      const data = await recognize(w, canvas, '11'); // texte épars : bulles dispersées
      const first = top === 0;
      const last = top + tileH >= fullH;
      const keepFrom = first ? -Infinity : TILE_OVERLAP / 2;
      const keepTo = last ? Infinity : tileH - TILE_OVERLAP / 2;
      const tileWeak = [];
      for (const l of extractLines(data, lang, 55, tileWeak)) {
        const cy = (l.y0 + l.y1) / 2;
        if (cy < keepFrom || cy >= keepTo) continue; // évite les doublons dans les zones de recouvrement
        all.push({ ...l, y0: l.y0 + top, y1: l.y1 + top });
      }
      for (const b of tileWeak) weak.push({ x0: b.x0, x1: b.x1, y0: b.y0 + top, y1: b.y1 + top });
      if (last) break;
    }

    // 2e passe : relire chaque bulle seule, en plus grand.
    const bubbles = [];
    for (const g of groupLines(all, vertical).filter((gr) => plausible(gr, lang))) {
      const gx0 = Math.min(...g.map((l) => l.x0)), gy0 = Math.min(...g.map((l) => l.y0));
      const gx1 = Math.max(...g.map((l) => l.x1)), gy1 = Math.max(...g.map((l) => l.y1));
      const textSize = median(g.map((l) => (vertical ? l.x1 - l.x0 : l.y1 - l.y0)));
      let text = joinLines(g, lang, vertical);
      const firstConf = g.reduce((s, l) => s + l.meanConf, 0) / g.length;
      // Coordonnées dans l'image source.
      let box = { x0: sx + gx0 / scale, y0: sy + gy0 / scale, x1: sx + gx1 / scale, y1: sy + gy1 / scale };
      // Mode précis : chaque bulle est relue. Mode rapide : seulement celles où la 1re passe a un doute.
      const mx = (vertical ? 0.7 : 2.2) * textSize, my = (vertical ? 2.2 : 0.7) * textSize;
      const doubtful = weak.some((b) => {
        const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
        return cx > gx0 - mx && cx < gx1 + mx && cy > gy0 - my && cy < gy1 + my;
      });
      const sure = !doubtful && Math.min(...g.map((l) => l.conf)) >= 85;
      const ref = await refine(w, bitmap, box, textSize / scale, lang, vertical, precise || !sure);
      if (ref.text) {
        // On garde la 2e lecture si elle trouve au moins autant de texte, ou si elle est nettement plus sûre.
        const a = letterCount(ref.text), b = letterCount(text);
        const better = (a > 1.1 * b && ref.conf >= 60) // trouve nettement plus de texte
          || (a >= 0.9 * b && ref.conf >= firstConf - 12)
          || (a >= 0.7 * b && ref.conf >= firstConf + 10); // nettement plus sûre
        if (better) {
          text = ref.text;
          box = {
            x0: Math.min(box.x0, ref.found.x0), y0: Math.min(box.y0, ref.found.y0),
            x1: Math.max(box.x1, ref.found.x1), y1: Math.max(box.y1, ref.found.y1),
          };
        }
      }
      if (!text.trim()) continue;
      const bg = ref.bg || [255, 255, 255];
      // Coordonnées normalisées (0..1) dans la zone analysée.
      const nx0 = (box.x0 - sx) / sw, ny0 = (box.y0 - sy) / sh;
      bubbles.push({
        text,
        x: nx0, y: ny0, w: (box.x1 - sx) / sw - nx0, h: (box.y1 - sy) / sh - ny0,
        pad: (0.35 * textSize) / (sw * scale),
        bg: `rgb(${bg.join(',')})`,
        dark: (bg[0] * 299 + bg[1] * 587 + bg[2] * 114) / 1000 < 128,
      });
    }
    // Deux zones relues qui se recouvrent largement = la même bulle : on garde la plus complète.
    const area = (b) => b.w * b.h;
    const inter = (a, b) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x))
      * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
    for (let i = bubbles.length - 1; i >= 0; i--) {
      for (let j = 0; j < bubbles.length; j++) {
        if (i === j || !bubbles[i] || !bubbles[j]) continue;
        if (inter(bubbles[i], bubbles[j]) > 0.5 * Math.min(area(bubbles[i]), area(bubbles[j]))
          && letterCount(bubbles[i].text) <= letterCount(bubbles[j].text)) {
          bubbles[i] = null;
          break;
        }
      }
    }
    for (let i = bubbles.length - 1; i >= 0; i--) if (!bubbles[i]) bubbles.splice(i, 1);
    // Ordre de lecture (haut en bas, puis gauche à droite ; droite à gauche pour le manga vertical).
    bubbles.sort((a, b) => {
      if (Math.abs(a.y - b.y) > 0.5 * Math.min(a.h, b.h)) return a.y - b.y;
      return vertical ? b.x - a.x : a.x - b.x;
    });
    return { bubbles };
  } finally {
    bitmap.close();
  }
}

async function ocrWithRecovery(msg) {
  try {
    return await ocr(msg);
  } catch (e) {
    if (/téléchargement|trop petite/.test(String(e?.message))) throw e;
    // Le worker a pu planter (mémoire, données corrompues) : on le recrée et on réessaie une fois.
    await resetWorker();
    return ocr(msg);
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'offscreen' || msg.type !== 'ocr') return;
  // Une seule reconnaissance à la fois (un seul worker).
  queue = queue
    .then(() => ocrWithRecovery(msg))
    .then((r) => sendResponse({ ok: true, ...r }))
    .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
  return true;
});
