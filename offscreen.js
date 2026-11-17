// Document offscreen : héberge le Web Worker Tesseract (OCR 100 % local).
/* global Tesseract */

const CJK_LANGS = new Set(['jpn', 'jpn_vert', 'chi_sim', 'chi_tra', 'kor']);
const TILE_H = 3000;      // hauteur max d'une tuile (px après mise à l'échelle)
const TILE_OVERLAP = 300; // recouvrement entre tuiles (webtoons très hauts)

let worker = null;
let workerLang = null;
let queue = Promise.resolve();

async function getWorker(lang) {
  if (worker && workerLang === lang) return worker;
  if (worker) await worker.terminate();
  worker = await Tesseract.createWorker(lang, 1, {
    workerPath: chrome.runtime.getURL('lib/worker.min.js'),
    corePath: chrome.runtime.getURL('lib/core/'),
    workerBlobURL: false,
    // Les données de langue sont téléchargées une seule fois puis gardées en cache (IndexedDB).
  });
  await worker.setParameters({
    tessedit_pageseg_mode: '11', // texte épars : adapté aux bulles dispersées
    preserve_interword_spaces: CJK_LANGS.has(lang) ? '1' : '0',
  });
  workerLang = lang;
  return worker;
}

async function loadBitmap(source) {
  let blob;
  if (source.dataUrl) {
    blob = await (await fetch(source.dataUrl)).blob();
  } else {
    const res = await fetch(source.url, { credentials: 'include' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    blob = await res.blob();
  }
  return createImageBitmap(blob);
}

function letterCount(s) {
  return (s.match(/\p{L}/gu) || []).length;
}

// Extrait les lignes fiables d'un résultat Tesseract.
function extractLines(data, lang) {
  const cjk = CJK_LANGS.has(lang);
  const lines = [];
  for (const block of data.blocks || []) {
    for (const para of block.paragraphs || []) {
      for (const line of para.lines || []) {
        const words = (line.words || []).filter((w) => w.confidence >= 55 && w.text.trim());
        if (!words.length) continue;
        let text = words.map((w) => w.text.trim()).join(cjk ? '' : ' ');
        const letters = letterCount(text);
        if (letters < (cjk ? 1 : 2)) continue;
        if (letters / text.replace(/\s/g, '').length < 0.5) continue; // surtout des symboles : bruit
        const x0 = Math.min(...words.map((w) => w.bbox.x0));
        const y0 = Math.min(...words.map((w) => w.bbox.y0));
        const x1 = Math.max(...words.map((w) => w.bbox.x1));
        const y1 = Math.max(...words.map((w) => w.bbox.y1));
        const conf = Math.min(...words.map((w) => w.confidence));
        lines.push({ text, x0, y0, x1, y1, conf });
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
      const m = 0.7 * Math.min(sa, sb);
      const overlap = a.x0 - m < b.x1 && b.x0 - m < a.x1 && a.y0 - m < b.y1 && b.y0 - m < a.y1;
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
    .replace(/(^|[.!?…]\s+)(\p{L})/gu, (_, p, c) => p + c.toUpperCase())
    .replace(/\bi\b/g, 'I');
}

function joinGroup(group, lang, vertical) {
  const cjk = CJK_LANGS.has(lang);
  const sorted = [...group].sort((a, b) => (vertical ? b.x0 - a.x0 : a.y0 - b.y0));
  let text = '';
  for (const l of sorted) {
    const t = cjk ? l.text.replace(/\s+/g, '') : l.text;
    if (!text) text = t;
    else if (cjk) text += t;
    else if (/\p{L}-$/u.test(text) && /^\p{Ll}/u.test(t)) text = text.slice(0, -1) + t; // césure
    else text += ' ' + t;
  }
  return cjk ? text : normalizeCase(text);
}

async function ocr({ source, crop, lang }) {
  const bitmap = await loadBitmap(source);
  const sx = crop ? crop.x : 0;
  const sy = crop ? crop.y : 0;
  const sw = crop ? Math.min(crop.w, bitmap.width - sx) : bitmap.width;
  const sh = crop ? Math.min(crop.h, bitmap.height - sy) : bitmap.height;
  if (sw < 10 || sh < 10) throw new Error('Image trop petite');

  // Agrandir les petites images améliore nettement la reconnaissance.
  let scale = Math.min(3, Math.max(1, 1600 / sw));
  if (sw * scale > 4000) scale = 4000 / sw;

  const w = await getWorker(lang);
  const vertical = lang.endsWith('_vert');
  const all = [];
  const fullH = Math.round(sh * scale);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(sw * scale);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  for (let top = 0; top < fullH; top += TILE_H - TILE_OVERLAP) {
    const tileH = Math.min(TILE_H, fullH - top);
    canvas.height = tileH;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, tileH);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, sx, sy + top / scale, sw, tileH / scale, 0, 0, canvas.width, tileH);
    const { data } = await w.recognize(canvas, {}, { blocks: true, text: false });
    const first = top === 0;
    const last = top + tileH >= fullH;
    const keepFrom = first ? -Infinity : TILE_OVERLAP / 2;
    const keepTo = last ? Infinity : tileH - TILE_OVERLAP / 2;
    for (const l of extractLines(data, lang)) {
      const cy = (l.y0 + l.y1) / 2;
      if (cy < keepFrom || cy >= keepTo) continue; // évite les doublons dans les zones de recouvrement
      all.push({ ...l, y0: l.y0 + top, y1: l.y1 + top });
    }
    if (last) break;
  }
  bitmap.close();

  const W = sw * scale, H = sh * scale;
  const bubbles = groupLines(all, vertical).filter((g) => plausible(g, lang)).map((g) => {
    const x0 = Math.min(...g.map((l) => l.x0)), y0 = Math.min(...g.map((l) => l.y0));
    const x1 = Math.max(...g.map((l) => l.x1)), y1 = Math.max(...g.map((l) => l.y1));
    const sizes = g.map((l) => (vertical ? l.x1 - l.x0 : l.y1 - l.y0)).sort((a, b) => a - b);
    const textSize = sizes[Math.floor(sizes.length / 2)];
    // Coordonnées normalisées (0..1) dans la zone analysée.
    return {
      text: joinGroup(g, lang, vertical),
      x: x0 / W, y: y0 / H, w: (x1 - x0) / W, h: (y1 - y0) / H,
      pad: (0.35 * textSize) / W,
    };
  });
  return { bubbles: bubbles.filter((b) => b.text.trim()) };
}

// Un texte très court (« yd ») trouvé dans le dessin est souvent du bruit : on exige alors une forte confiance.
function plausible(group, lang) {
  const letters = group.reduce((n, l) => n + letterCount(l.text), 0);
  if (letters >= (CJK_LANGS.has(lang) ? 2 : 4)) return true;
  return Math.min(...group.map((l) => l.conf)) >= 85;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'offscreen' || msg.type !== 'ocr') return;
  // Une seule reconnaissance à la fois (un seul worker).
  queue = queue
    .then(() => ocr(msg))
    .then((r) => sendResponse({ ok: true, ...r }))
    .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
  return true;
});
