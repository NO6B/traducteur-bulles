// Moteur de traduction commun (extension et application web) : services gratuits, sans clé.
// Expose globalThis.TBTranslate = { translateTexts, resolveOcrLang, clearMemo }.
(() => {
// Langue OCR Tesseract -> code de langue pour la traduction.
const OCR_TO_ISO = {
  eng: 'en', jpn: 'ja', jpn_vert: 'ja', kor: 'ko', chi_sim: 'zh-CN', chi_tra: 'zh-TW',
  fra: 'fr', spa: 'es', deu: 'de', ita: 'it', por: 'pt', rus: 'ru',
};

// « Automatique » : la langue des images est déduite de la langue déclarée par la page.
function resolveOcrLang(setting, pageLang) {
  if (setting && setting !== 'auto') return setting;
  const l = (pageLang || '').toLowerCase();
  if (l.startsWith('ja')) return 'jpn_vert';
  if (l.startsWith('ko')) return 'kor';
  if (l.startsWith('zh')) return /tw|hk|mo|hant/.test(l) ? 'chi_tra' : 'chi_sim';
  const map = { fr: 'fra', es: 'spa', de: 'deu', it: 'ita', pt: 'por', ru: 'rus' };
  return map[l.slice(0, 2)] || 'eng';
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Requête avec nouvelles tentatives en cas de limitation (429) ou d'erreur serveur.
async function fetchRetry(url, options, label) {
  let lastError;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(url, options);
      if (res.ok) return res;
      lastError = new Error(`${label} HTTP ${res.status}`);
      if (res.status !== 429 && res.status < 500) break;
    } catch (e) {
      lastError = e;
    }
    await sleep(700 * 2 ** attempt);
  }
  throw lastError;
}

// Google : toutes les bulles d'une image en une requête (une ligne par bulle),
// ce qui donne du contexte au traducteur (tutoiement, genre, noms) et limite les requêtes.
async function googleOne(text, tl) {
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&dt=t&sl=auto&tl=${encodeURIComponent(tl)}`;
  const res = await fetchRetry(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
    body: new URLSearchParams({ q: text }),
  }, 'Google');
  const data = await res.json();
  return (data[0] || []).map((s) => s[0]).join('');
}

async function translateGoogle(texts, tl) {
  const out = new Array(texts.length);
  const chunks = [];
  let cur = [];
  let len = 0;
  texts.forEach((t, i) => {
    if (cur.length && len + t.length > 4000) { chunks.push(cur); cur = []; len = 0; }
    cur.push(i);
    len += t.length + 1;
  });
  if (cur.length) chunks.push(cur);
  for (const idx of chunks) {
    const joined = idx.map((i) => texts[i]).join('\n');
    const parts = (await googleOne(joined, tl)).split('\n').map((s) => s.trim());
    if (parts.length === idx.length && parts.every(Boolean)) {
      idx.forEach((i, k) => { out[i] = parts[k]; });
    } else {
      for (const i of idx) out[i] = await googleOne(texts[i], tl); // découpage incertain : une par une
    }
  }
  return out;
}

async function translateMyMemory(texts, sl, tl) {
  const out = [];
  for (const text of texts) {
    const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}`
      + `&langpair=${encodeURIComponent(sl)}|${encodeURIComponent(tl)}`;
    const data = await (await fetchRetry(url, {}, 'MyMemory')).json();
    if (data.responseStatus !== 200) throw new Error(`MyMemory : ${data.responseDetails}`);
    out.push(data.responseData.translatedText);
  }
  return out;
}

const memo = new Map(); // `${langue}|${texte}` -> traduction (durée de vie du service worker)

async function translateTexts(texts, settings, ocrLang) {
  const sl = OCR_TO_ISO[ocrLang] || 'en';
  const tl = settings.targetLang;
  const out = texts.map((t) => memo.get(`${tl}|${t}`) ?? null);
  const todo = texts.map((t, i) => i).filter((i) => out[i] == null);
  if (!todo.length) return { out };
  const pending = todo.map((i) => texts[i]);
  const engines = settings.engine === 'mymemory'
    ? [() => translateMyMemory(pending, sl, tl), () => translateGoogle(pending, tl)]
    : [() => translateGoogle(pending, tl), () => translateMyMemory(pending, sl, tl)];
  let lastError;
  for (const run of engines) {
    try {
      const res = await run();
      todo.forEach((i, k) => {
        out[i] = res[k];
        memo.set(`${tl}|${texts[i]}`, res[k]);
      });
      return { out };
    } catch (e) {
      lastError = e;
    }
  }
  return { out, error: String(lastError?.message || lastError) };
}

globalThis.TBTranslate = { translateTexts, resolveOcrLang, clearMemo: () => memo.clear(), OCR_TO_ISO };
})();
