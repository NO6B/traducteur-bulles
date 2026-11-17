// Service worker : menus, coordination OCR (offscreen), traduction gratuite, cache.

const DEFAULTS = { ocrLang: 'auto', targetLang: 'fr', engine: 'google', precise: true, autoSites: [] };

// Langue OCR Tesseract -> code de langue pour la traduction.
const OCR_TO_ISO = {
  eng: 'en', jpn: 'ja', jpn_vert: 'ja', kor: 'ko', chi_sim: 'zh-CN', chi_tra: 'zh-TW',
  fra: 'fr', spa: 'es', deu: 'de', ita: 'it', por: 'pt', rus: 'ru',
};

const getSettings = () => chrome.storage.sync.get(DEFAULTS);

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

// ---------- Menus, raccourci, sites automatiques ----------

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'translate-image', title: 'Traduire les bulles de cette image', contexts: ['image'] });
    chrome.contextMenus.create({ id: 'translate-page', title: 'Traduire toutes les images de la page', contexts: ['page'] });
    chrome.contextMenus.create({ id: 'clear', title: 'Effacer les traductions', contexts: ['page', 'image'] });
  });
});

async function sendToTab(tabId, frameId, message) {
  const target = { tabId, frameIds: [frameId ?? 0] };
  await chrome.scripting.executeScript({ target, files: ['content.js'] });
  await chrome.tabs.sendMessage(tabId, message, { frameId: frameId ?? 0 });
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab?.id) return;
  const msg = info.menuItemId === 'translate-image'
    ? { type: 'translate-image', srcUrl: info.srcUrl }
    : { type: info.menuItemId };
  sendToTab(tab.id, info.frameId, msg).catch((e) => console.warn('Injection impossible :', e));
});

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== 'translate-page') return;
  tab = tab || (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  if (tab?.id) sendToTab(tab.id, 0, { type: 'translate-page' }).catch(() => {});
});

// Traduction automatique sur les sites choisis par l'utilisateur.
chrome.tabs.onUpdated.addListener(async (tabId, change, tab) => {
  if (change.status !== 'complete' || !/^https?:/.test(tab.url || '')) return;
  const { autoSites } = await getSettings();
  if (autoSites.includes(new URL(tab.url).hostname)) {
    sendToTab(tabId, 0, { type: 'translate-page' }).catch(() => {});
  }
});

// ---------- Document offscreen (OCR) ----------

let creatingOffscreen = null;
async function ensureOffscreen() {
  const url = chrome.runtime.getURL('offscreen.html');
  const existing = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [url] });
  if (existing.length) return;
  creatingOffscreen ||= chrome.offscreen
    .createDocument({ url: 'offscreen.html', reasons: ['WORKERS'], justification: 'OCR Tesseract dans un Web Worker' })
    .finally(() => { creatingOffscreen = null; });
  await creatingOffscreen;
}

async function runOcr(source, crop, lang, precise) {
  await ensureOffscreen();
  const res = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'ocr', source, crop, lang, precise });
  if (!res?.ok) throw new Error(res?.error || 'lecture du texte impossible');
  return res.bubbles;
}

// Certains sites refusent les images sans en-tête Referer : on l'ajoute
// uniquement pour les requêtes de l'extension (tabIds -1), jamais pour la navigation normale.
async function setReferer(imageUrl, pageUrl) {
  try {
    const host = new URL(imageUrl).hostname;
    if (!host || !pageUrl) return;
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [1],
      addRules: [{
        id: 1,
        priority: 1,
        action: {
          type: 'modifyHeaders',
          requestHeaders: [{ header: 'referer', operation: 'set', value: pageUrl }],
        },
        condition: { requestDomains: [host], tabIds: [chrome.tabs.TAB_ID_NONE] },
      }],
    });
  } catch (e) {
    console.warn('Règle Referer non appliquée :', e);
  }
}

// ---------- Traduction gratuite (sans clé) ----------

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

// ---------- Cache persistant des pages déjà traduites ----------

const CACHE_MAX = 400;
let cacheChain = Promise.resolve();

async function cacheGet(key) {
  const { [`c:${key}`]: hit } = await chrome.storage.local.get(`c:${key}`);
  return hit?.bubbles || null;
}

function cacheSet(key, bubbles) {
  cacheChain = cacheChain.then(async () => {
    const { cacheIndex = [] } = await chrome.storage.local.get('cacheIndex');
    const index = cacheIndex.filter((k) => k !== key);
    index.push(key);
    const evicted = index.splice(0, Math.max(0, index.length - CACHE_MAX));
    await chrome.storage.local.set({ [`c:${key}`]: { bubbles }, cacheIndex: index });
    if (evicted.length) await chrome.storage.local.remove(evicted.map((k) => `c:${k}`));
  }).catch(() => {});
}

async function clearCache() {
  const all = await chrome.storage.local.get(null);
  await chrome.storage.local.remove(Object.keys(all).filter((k) => k.startsWith('c:') || k === 'cacheIndex'));
  memo.clear();
}

// ---------- Messages venant du script de contenu ----------

async function process(msg, sender) {
  const settings = await getSettings();
  const lang = resolveOcrLang(settings.ocrLang, msg.pageLang);
  const cacheKey = msg.type === 'process' && msg.key
    ? [lang, settings.targetLang, settings.precise ? 'p' : 'r', msg.key].join('|')
    : null;
  if (cacheKey) {
    const hit = await cacheGet(cacheKey);
    if (hit) return { bubbles: hit, cached: true };
  }

  let bubbles;
  if (msg.type === 'process') {
    if (msg.source.url) await setReferer(msg.source.url, sender.tab?.url);
    bubbles = await runOcr(msg.source, null, lang, settings.precise);
  } else if (msg.type === 'process-capture') {
    // Dernier recours : capture de l'onglet visible puis découpe de l'image.
    const dataUrl = await chrome.tabs.captureVisibleTab(sender.tab.windowId, { format: 'png' });
    const { rect, dpr } = msg;
    const crop = {
      x: Math.round(rect.x * dpr), y: Math.round(rect.y * dpr),
      w: Math.round(rect.w * dpr), h: Math.round(rect.h * dpr),
    };
    bubbles = await runOcr({ dataUrl }, crop, lang, settings.precise);
  } else {
    throw new Error('message inconnu');
  }

  const { out, error } = await translateTexts(bubbles.map((b) => b.text), settings, lang);
  const translated = bubbles
    .map((b, i) => ({ ...b, translation: out[i] || null }))
    // Bruit résiduel : texte court que le traducteur renvoie tel quel (mot inexistant).
    .filter((b) => !(b.text.length <= 3 && b.translation
      && b.translation.trim().toLowerCase() === b.text.trim().toLowerCase()));
  if (cacheKey && !error && translated.every((b) => b.translation)) cacheSet(cacheKey, translated);
  return { bubbles: translated, error };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.target !== 'background') return;
  if (msg.type === 'popup-command') {
    sendToTab(msg.tabId, 0, { type: msg.command })
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
    return true;
  }
  if (msg.type === 'clear-cache') {
    clearCache().then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === 'progress') {
    const text = msg.pending > 0 ? String(msg.pending) : '';
    chrome.action.setBadgeBackgroundColor({ color: '#1a73e8', tabId: sender.tab?.id });
    chrome.action.setBadgeText({ text, tabId: sender.tab?.id });
    return;
  }
  process(msg, sender)
    .then((r) => sendResponse({ ok: true, ...r }))
    .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
  return true;
});
