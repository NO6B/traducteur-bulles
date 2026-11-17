// Service worker : menus, coordination OCR (offscreen) et traduction gratuite.

const DEFAULTS = { ocrLang: 'eng', targetLang: 'fr', engine: 'google' };

// Langue OCR Tesseract -> code de langue pour la traduction.
const OCR_TO_ISO = {
  eng: 'en', jpn: 'ja', jpn_vert: 'ja', kor: 'ko', chi_sim: 'zh-CN', chi_tra: 'zh-TW',
  fra: 'fr', spa: 'es', deu: 'de', ita: 'it', por: 'pt', rus: 'ru',
};

const getSettings = () => chrome.storage.sync.get(DEFAULTS);

// ---------- Menus et raccourci ----------

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

async function runOcr(source, crop, lang) {
  await ensureOffscreen();
  const res = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'ocr', source, crop, lang });
  if (!res?.ok) throw new Error(res?.error || 'OCR impossible');
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

async function translateGoogle(text, sl, tl) {
  const url = 'https://translate.googleapis.com/translate_a/single?client=gtx&dt=t'
    + `&sl=${encodeURIComponent(sl)}&tl=${encodeURIComponent(tl)}&q=${encodeURIComponent(text)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Google HTTP ${res.status}`);
  const data = await res.json();
  return (data[0] || []).map((s) => s[0]).join('');
}

async function translateMyMemory(text, sl, tl) {
  const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}`
    + `&langpair=${encodeURIComponent(sl)}|${encodeURIComponent(tl)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`MyMemory HTTP ${res.status}`);
  const data = await res.json();
  if (data.responseStatus !== 200) throw new Error(`MyMemory : ${data.responseDetails}`);
  return data.responseData.translatedText;
}

async function translate(text, settings) {
  const sl = OCR_TO_ISO[settings.ocrLang] || 'auto';
  const tl = settings.targetLang;
  const order = settings.engine === 'mymemory'
    ? [() => translateMyMemory(text, sl, tl), () => translateGoogle(text, 'auto', tl)]
    : [() => translateGoogle(text, 'auto', tl), () => translateMyMemory(text, sl, tl)];
  let lastError;
  for (const attempt of order) {
    try {
      return await attempt();
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError;
}

async function translateAll(bubbles, settings) {
  const out = new Array(bubbles.length);
  let next = 0;
  const workerCount = Math.min(4, bubbles.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (next < bubbles.length) {
      const i = next++;
      try {
        out[i] = { ...bubbles[i], translation: await translate(bubbles[i].text, settings) };
      } catch (e) {
        out[i] = { ...bubbles[i], translation: null, error: String(e.message || e) };
      }
    }
  }));
  return out;
}

// ---------- Messages venant du script de contenu ----------

async function process(msg, sender) {
  const settings = await getSettings();
  let bubbles;
  if (msg.type === 'process') {
    if (msg.source.url) await setReferer(msg.source.url, sender.tab?.url);
    bubbles = await runOcr(msg.source, null, settings.ocrLang);
  } else if (msg.type === 'process-capture') {
    // Dernier recours : capture de l'onglet visible puis découpe de l'image.
    const dataUrl = await chrome.tabs.captureVisibleTab(sender.tab.windowId, { format: 'png' });
    const { rect, dpr } = msg;
    const crop = {
      x: Math.round(rect.x * dpr), y: Math.round(rect.y * dpr),
      w: Math.round(rect.w * dpr), h: Math.round(rect.h * dpr),
    };
    bubbles = await runOcr({ dataUrl }, crop, settings.ocrLang);
  } else {
    throw new Error('Message inconnu');
  }
  const translated = await translateAll(bubbles, settings);
  // Bruit résiduel : texte court que le traducteur renvoie tel quel (mot inexistant).
  return translated.filter((b) => !(b.text.length <= 3 && b.translation
    && b.translation.trim().toLowerCase() === b.text.trim().toLowerCase()));
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.target !== 'background') return;
  if (msg.type === 'popup-command') {
    sendToTab(msg.tabId, 0, { type: msg.command })
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
    return true;
  }
  process(msg, sender)
    .then((bubbles) => sendResponse({ ok: true, bubbles }))
    .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
  return true;
});
