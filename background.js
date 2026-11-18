// Arrière-plan : menus, coordination OCR, traduction gratuite, cache.
// Chrome : service worker (OCR dans un document offscreen).
// Firefox : page d'arrière-plan (OCR directement ici, scripts chargés par le manifeste).
/* global TBTranslate, TBOcrRouter */
if (typeof importScripts === 'function') importScripts('engine/translate.js');
const { translateTexts, resolveOcrLang } = TBTranslate;

const DEFAULTS = { ocrLang: 'auto', targetLang: 'fr', engine: 'google', ocrEngine: 'paddle', precise: true, autoSites: [] };

const getSettings = () => chrome.storage.sync.get(DEFAULTS);
const t = (key, subs) => chrome.i18n.getMessage(key, subs) || key;
const IS_CHROME = !!chrome.offscreen; // Firefox : pas d'offscreen, l'OCR tourne dans cette page

// ---------- Menus, raccourci, sites automatiques ----------

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  // Langue cible par défaut : celle du navigateur (si elle est proposée).
  if (reason === 'install') {
    const ui = chrome.i18n.getUILanguage().split('-')[0];
    const supported = ['fr', 'en', 'es', 'de', 'it', 'pt', 'ar', 'ru', 'tr', 'id', 'vi', 'ja', 'ko'];
    await chrome.storage.sync.set({ targetLang: supported.includes(ui) ? ui : 'en' });
    chrome.tabs.create({ url: chrome.runtime.getURL('welcome.html') });
  }
  if (!chrome.contextMenus) return; // Firefox Android : pas de menu contextuel
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'translate-image', title: t('menuTranslateImage'), contexts: ['image'] });
    chrome.contextMenus.create({ id: 'translate-page', title: t('menuTranslatePage'), contexts: ['page'] });
    chrome.contextMenus.create({ id: 'clear', title: t('menuClear'), contexts: ['page', 'image'] });
  });
});

async function sendToTab(tabId, frameId, message) {
  const target = { tabId, frameIds: [frameId ?? 0] };
  await chrome.scripting.executeScript({ target, files: ['content.js'] });
  await chrome.tabs.sendMessage(tabId, message, { frameId: frameId ?? 0 });
}

chrome.contextMenus?.onClicked.addListener((info, tab) => {
  if (!tab?.id) return;
  const msg = info.menuItemId === 'translate-image'
    ? { type: 'translate-image', srcUrl: info.srcUrl }
    : { type: info.menuItemId };
  sendToTab(tab.id, info.frameId, msg).catch((e) => console.warn('Injection impossible :', e));
});

chrome.commands?.onCommand.addListener(async (command, tab) => {
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

async function runOcr(source, crop, lang, precise, engine) {
  if (!IS_CHROME) {
    TBOcrRouter.configureFor(chrome.runtime.getURL(''));
    return (await TBOcrRouter.run({ source, crop, lang, precise, engine })).bubbles;
  }
  await ensureOffscreen();
  const res = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'ocr', source, crop, lang, precise, engine });
  if (!res?.ok) throw new Error(res?.error || 'E_OCR');
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
  TBTranslate.clearMemo();
}

// ---------- Messages venant du script de contenu ----------

async function process(msg, sender) {
  const settings = await getSettings();
  const lang = resolveOcrLang(settings.ocrLang, msg.pageLang);
  const cacheKey = msg.type === 'process' && msg.key
    ? [lang, settings.targetLang, settings.ocrEngine, settings.precise ? 'p' : 'r', msg.key].join('|')
    : null;
  if (cacheKey) {
    const hit = await cacheGet(cacheKey);
    if (hit) return { bubbles: hit, cached: true };
  }

  let bubbles;
  if (msg.type === 'process') {
    if (msg.source.url) await setReferer(msg.source.url, sender.tab?.url);
    bubbles = await runOcr(msg.source, null, lang, settings.precise, settings.ocrEngine);
  } else if (msg.type === 'process-capture') {
    // Dernier recours : capture de l'onglet visible puis découpe de l'image.
    const dataUrl = await chrome.tabs.captureVisibleTab(sender.tab.windowId, { format: 'png' });
    const { rect, dpr } = msg;
    const crop = {
      x: Math.round(rect.x * dpr), y: Math.round(rect.y * dpr),
      w: Math.round(rect.w * dpr), h: Math.round(rect.h * dpr),
    };
    bubbles = await runOcr({ dataUrl }, crop, lang, settings.precise, settings.ocrEngine);
  } else {
    throw new Error('E_UNKNOWN');
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
