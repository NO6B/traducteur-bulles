// Moteur OCR PaddleOCR (PP-OCRv5, modèles officiels ONNX) exécuté localement avec ONNX Runtime Web.
// 1) détection des lignes de texte (DB), 2) lecture de chaque ligne (CTC), 3) regroupement en bulles.
// Expose globalThis.TBPaddle = { configure, run }. Nécessite engine/ocr.js (TBOcrUtil) et lib/ort.
/* global ort, TBOcrUtil */
(() => {
const { groupLines, joinLines, plausible, sampleBackground, loadBitmap, median, letterCount } = TBOcrUtil;

// Modèles officiels PaddlePaddle (licence Apache 2.0) hébergés sur Hugging Face.
const REPOS = {
  det: 'PP-OCRv5_mobile_det_onnx',
  ch: 'PP-OCRv5_mobile_rec_onnx', // chinois simplifié et traditionnel, japonais, anglais
  en: 'en_PP-OCRv5_mobile_rec_onnx',
  latin: 'latin_PP-OCRv5_mobile_rec_onnx',
  korean: 'korean_PP-OCRv5_mobile_rec_onnx',
  eslav: 'eslav_PP-OCRv5_mobile_rec_onnx',
};
const REC_FOR = {
  eng: 'en', fra: 'latin', spa: 'latin', deu: 'latin', ita: 'latin', por: 'latin',
  rus: 'eslav', kor: 'korean', jpn: 'ch', jpn_vert: 'ch', chi_sim: 'ch', chi_tra: 'ch',
};

let config = {
  wasmPaths: 'lib/ort/',
  dictBase: 'models/',
  modelBase: 'https://huggingface.co/PaddlePaddle/',
  cacheName: 'tb-paddle-v5',
};
const sessions = {};
const dicts = {};
let queue = Promise.resolve();

function setupOrt() {
  ort.env.wasm.wasmPaths = config.wasmPaths;
  ort.env.wasm.numThreads = 1; // pas de SharedArrayBuffer dans une extension ni sur GitHub Pages
  ort.env.wasm.proxy = false;
  ort.env.logLevel = 'error';
}

// Téléchargement unique des modèles, gardés ensuite dans le cache du navigateur.
async function fetchCached(url) {
  if (globalThis.caches) {
    const cache = await caches.open(config.cacheName);
    const hit = await cache.match(url);
    if (hit) return new Uint8Array(await hit.arrayBuffer());
    const res = await fetch(url);
    if (!res.ok) throw new Error(`E_MODEL ${res.status}`);
    const buf = new Uint8Array(await res.clone().arrayBuffer());
    await cache.put(url, res).catch(() => {});
    return buf;
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`E_MODEL ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

async function getSession(name) {
  if (!sessions[name]) {
    sessions[name] = (async () => {
      setupOrt();
      const bytes = await fetchCached(`${config.modelBase}${REPOS[name]}/resolve/main/inference.onnx`);
      return ort.InferenceSession.create(bytes, { executionProviders: ['wasm'], graphOptimizationLevel: 'all', logSeverityLevel: 3 });
    })();
    sessions[name].catch(() => { delete sessions[name]; });
  }
  return sessions[name];
}

async function getDict(name) {
  if (!dicts[name]) {
    dicts[name] = fetch(`${config.dictBase}${name}.txt`).then((r) => r.text()).then((t) => t.split('\n'));
    dicts[name].catch(() => { delete dicts[name]; });
  }
  return dicts[name];
}

// ---------- Détection (DB) ----------

const DET_MEAN = [0.485, 0.456, 0.406];
const DET_STD = [0.229, 0.224, 0.225];

// Pixels RGBA -> tenseur NCHW dans l'ordre BGR (convention PaddleOCR).
function toTensor(data, w, h, mean, std) {
  const out = new Float32Array(3 * w * h);
  const plane = w * h;
  for (let p = 0, i = 0; p < plane; p++, i += 4) {
    out[p] = (data[i + 2] / 255 - mean[0]) / std[0];
    out[plane + p] = (data[i + 1] / 255 - mean[1]) / std[1];
    out[2 * plane + p] = (data[i] / 255 - mean[2]) / std[2];
  }
  return out;
}

// Carte de probabilité -> rectangles de lignes (composantes connexes, puis élargissement « unclip »).
function boxesFromMap(prob, w, h, thresh = 0.3, boxThresh = 0.55, unclip = 1.6) {
  const seen = new Uint8Array(w * h);
  const boxes = [];
  const stack = new Int32Array(w * h);
  for (let start = 0; start < w * h; start++) {
    if (seen[start] || prob[start] <= thresh) continue;
    let top = 0;
    stack[top++] = start;
    seen[start] = 1;
    let x0 = w, y0 = h, x1 = 0, y1 = 0, sum = 0, n = 0;
    while (top) {
      const p = stack[--top];
      const x = p % w, y = (p - x) / w;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      sum += prob[p];
      n++;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const q = yy * w + xx;
          if (!seen[q] && prob[q] > thresh) { seen[q] = 1; stack[top++] = q; }
        }
      }
    }
    const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
    if (Math.min(bw, bh) < 3 || sum / n < boxThresh) continue;
    const d = (bw * bh * unclip) / (2 * (bw + bh));
    boxes.push({ x0: x0 - d, y0: y0 - d, x1: x1 + 1 + d, y1: y1 + 1 + d, score: sum / n });
  }
  return boxes;
}

async function detect(bitmap, sx, sy, sw, sh, precise) {
  const det = await getSession('det');
  // Échelle : le texte de BD fait 12 à 40 px ; on vise une largeur de travail de 960 à 1600 px.
  const maxW = precise ? 1600 : 1100;
  const s = sw > maxW ? maxW / sw : Math.min(2, Math.max(1, 900 / sw));
  const W = Math.max(32, Math.round((sw * s) / 32) * 32);
  const fullH = sh * s;
  const TILE = 1280, OVER = 160;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const lines = [];
  for (let top = 0; top < fullH; top += TILE - OVER) {
    const tileH = Math.min(TILE, fullH - top);
    const H = Math.max(32, Math.round(tileH / 32) * 32);
    canvas.width = W;
    canvas.height = H;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, W, H);
    ctx.drawImage(bitmap, sx, sy + top / s, sw, tileH / s, 0, 0, W, H);
    const { data } = ctx.getImageData(0, 0, W, H);
    const input = new ort.Tensor('float32', toTensor(data, W, H, DET_MEAN, DET_STD), [1, 3, H, W]);
    const out = await det.run({ [det.inputNames[0]]: input });
    const prob = out[det.outputNames[0]].data;
    const fx = sw / W, fy = tileH / s / H; // pixels de la carte -> pixels source
    const first = top === 0, last = top + tileH >= fullH;
    for (const b of boxesFromMap(prob, W, H)) {
      const cy = (b.y0 + b.y1) / 2;
      if (!first && cy < OVER / 2) continue; // doublons des zones de recouvrement
      if (!last && cy > H - OVER / 2) continue;
      lines.push({
        x0: Math.max(0, sx + b.x0 * fx), x1: Math.min(sx + sw, sx + b.x1 * fx),
        y0: Math.max(0, sy + top / s + b.y0 * fy), y1: Math.min(sy + sh, sy + top / s + b.y1 * fy),
      });
    }
    if (last) break;
  }
  return lines;
}

// ---------- Lecture (CTC) ----------

async function recognize(bitmap, box, recName) {
  const [rec, dict] = await Promise.all([getSession(recName), getDict(recName)]);
  const bw = box.x1 - box.x0, bh = box.y1 - box.y0;
  const vertical = bh / bw >= 1.5; // colonne de japonais : on la couche pour la lire
  const H = 48;
  const ratio = vertical ? bh / bw : bw / bh;
  const W = Math.min(1600, Math.max(16, Math.ceil(H * ratio)));
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, W, H);
  ctx.imageSmoothingQuality = 'high';
  if (vertical) {
    // Rotation de 90° dans le sens antihoraire : le haut de la colonne passe à gauche.
    ctx.translate(0, H);
    ctx.rotate(-Math.PI / 2);
    ctx.drawImage(bitmap, box.x0, box.y0, bw, bh, 0, 0, H, W);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  } else {
    ctx.drawImage(bitmap, box.x0, box.y0, bw, bh, 0, 0, W, H);
  }
  const { data } = ctx.getImageData(0, 0, W, H);
  const input = new ort.Tensor('float32', toTensor(data, W, H, [0.5, 0.5, 0.5], [0.5, 0.5, 0.5]), [1, 3, H, W]);
  const out = await rec.run({ [rec.inputNames[0]]: input });
  const t = out[rec.outputNames[0]];
  const [, T, C] = t.dims;
  const probs = t.data;
  let text = '';
  let last = -1, sum = 0, n = 0;
  for (let i = 0; i < T; i++) {
    let best = 0, bestP = -1;
    const off = i * C;
    for (let c = 0; c < C; c++) if (probs[off + c] > bestP) { bestP = probs[off + c]; best = c; }
    if (best !== 0 && best !== last) {
      text += best - 1 < dict.length ? dict[best - 1] : ' '; // dernière classe = espace
      sum += bestP;
      n++;
    }
    last = best;
  }
  return { text: text.trim(), score: n ? sum / n : 0, vertical };
}

// ---------- Pipeline complet ----------

async function ocr({ source, crop, lang, precise = true }) {
  const recName = REC_FOR[lang] || 'en';
  const bitmap = await loadBitmap(source);
  try {
    const sx = crop ? crop.x : 0, sy = crop ? crop.y : 0;
    const sw = crop ? Math.min(crop.w, bitmap.width - sx) : bitmap.width;
    const sh = crop ? Math.min(crop.h, bitmap.height - sy) : bitmap.height;
    if (sw < 10 || sh < 10) throw new Error('E_SMALL');

    const boxes = await detect(bitmap, sx, sy, sw, sh, precise);
    const lines = [];
    for (const box of boxes) {
      const r = await recognize(bitmap, box, recName);
      if (!r.text || r.score < 0.6) continue;
      const letters = letterCount(r.text);
      if (!letters) continue;
      // Une lettre isolée (« L ») dans une langue à alphabet : presque toujours un trait du dessin.
      if (letters < 2 && !/^(jpn|jpn_vert|chi_sim|chi_tra|kor)$/.test(lang)) continue;
      lines.push({ ...box, text: r.text, conf: r.score * 100, meanConf: r.score * 100, vert: r.vertical });
    }

    const vertical = lines.filter((l) => l.vert).length > lines.length / 2;
    const groups = groupLines(lines, vertical).filter((g) => plausible(g, lang));
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const bubbles = [];
    for (const g of groups) {
      const x0 = Math.min(...g.map((l) => l.x0)), y0 = Math.min(...g.map((l) => l.y0));
      const x1 = Math.max(...g.map((l) => l.x1)), y1 = Math.max(...g.map((l) => l.y1));
      const textSize = median(g.map((l) => (l.vert ? l.x1 - l.x0 : l.y1 - l.y0))) * 0.75;
      const text = joinLines(g, lang, vertical);
      if (!text.trim()) continue;
      // Couleur de fond : autour du texte.
      const pad = Math.max(4, 0.6 * textSize);
      const cx0 = Math.max(0, Math.floor(x0 - pad)), cy0 = Math.max(0, Math.floor(y0 - pad));
      const cw = Math.max(1, Math.min(bitmap.width, Math.ceil(x1 + pad)) - cx0);
      const ch = Math.max(1, Math.min(bitmap.height, Math.ceil(y1 + pad)) - cy0);
      canvas.width = cw;
      canvas.height = ch;
      ctx.drawImage(bitmap, cx0, cy0, cw, ch, 0, 0, cw, ch);
      const bg = sampleBackground(ctx, cw, ch, { x0: x0 - cx0, y0: y0 - cy0, x1: x1 - cx0, y1: y1 - cy0 }) || [255, 255, 255];
      const nx0 = (x0 - sx) / sw, ny0 = (y0 - sy) / sh;
      bubbles.push({
        text,
        x: nx0, y: ny0, w: (x1 - sx) / sw - nx0, h: (y1 - sy) / sh - ny0,
        pad: (0.2 * textSize) / sw,
        bg: `rgb(${bg.join(',')})`,
        dark: (bg[0] * 299 + bg[1] * 587 + bg[2] * 114) / 1000 < 128,
      });
    }
    bubbles.sort((a, b) => {
      if (Math.abs(a.y - b.y) > 0.5 * Math.min(a.h, b.h)) return a.y - b.y;
      return vertical ? b.x - a.x : a.x - b.x;
    });
    return { bubbles };
  } finally {
    bitmap.close();
  }
}

function run(msg) {
  const p = queue.then(() => ocr(msg));
  queue = p.catch(() => {});
  return p;
}

globalThis.TBPaddle = {
  configure(opts) { config = { ...config, ...opts }; },
  run,
  // Précharge les modèles d'une langue (pour ne pas attendre à la première image).
  warmup: (lang) => Promise.all([getSession('det'), getSession(REC_FOR[lang] || 'en'), getDict(REC_FOR[lang] || 'en')]),
};
})();
