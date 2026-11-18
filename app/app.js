// Application web : traduit des images (pages de BD, captures d'écran) sur ordinateur et téléphone.
/* global TBOcrRouter, TBTranslate, TBRender */

// ---------- Textes (français / anglais selon l'appareil) ----------

const I18N = {
  fr: {
    title: 'Traducteur de bulles', settings: 'Réglages',
    ocrLang: "Langue du texte dans l'image", target: 'Traduire en', precision: 'Précision de lecture',
    precPrecise: 'Précise (recommandé)', precFast: 'Rapide', engine: 'Service de traduction (gratuit)',
    langEng: 'Anglais', langJpnVert: 'Japonais (vertical, manga)', langJpn: 'Japonais (horizontal)',
    langKor: 'Coréen (webtoon)', langChiSim: 'Chinois simplifié (manhua)', langChiTra: 'Chinois traditionnel',
    langFra: 'Français', langSpa: 'Espagnol', langDeu: 'Allemand', langIta: 'Italien', langPor: 'Portugais', langRus: 'Russe',
    tgtFr: 'Français', tgtEn: 'Anglais', tgtEs: 'Espagnol', tgtDe: 'Allemand', tgtIt: 'Italien', tgtPt: 'Portugais',
    tgtAr: 'Arabe', tgtRu: 'Russe', tgtTr: 'Turc', tgtId: 'Indonésien', tgtVi: 'Vietnamien', tgtJa: 'Japonais', tgtKo: 'Coréen',
    dropTitle: "Choisis une page de BD, de manga ou une capture d'écran",
    pick: 'Choisir des images', pickMore: 'Ajouter des images',
    dropHint: 'Tu peux aussi glisser-déposer ou coller une image (Ctrl+V).',
    saveAll: 'Tout enregistrer', clearAll: 'Tout effacer',
    install: "Installer l'application",
    installAndroid: "Installe l'application : elle apparaîtra dans le menu « Partager » de tes captures d'écran.",
    installIos: "Pour l'installer sur iPhone : bouton Partager de Safari, puis « Sur l'écran d'accueil ».",
    privacy: "La lecture du texte se fait sur ton appareil ; seul le texte des bulles est envoyé au service de traduction.",
    privacyLink: 'Confidentialité', home: 'Extension pour ordinateur',
    waiting: 'En attente…', reading: 'Lecture du texte…',
    readingFirst: 'Lecture du texte… (1re fois : téléchargement des modèles, 10 à 25 Mo)',
    ocrEngine: 'Moteur de lecture', ocrPaddle: 'PaddleOCR (recommandé)', ocrTesseract: 'Tesseract (plus léger)',
    translating: 'Traduction…', noText: 'Aucun texte détecté',
    bubbles1: '1 bulle traduite', bubblesN: '{0} bulles traduites', failed: '({0} non traduite(s))',
    error: 'Erreur : {0}', errUnreadable: 'image illisible', errSmall: 'image trop petite', errOcr: 'lecture du texte impossible',
    original: 'Original', translation: 'Traduction', save: 'Enregistrer', share: 'Partager', retry: 'Réessayer',
    remove: 'Retirer', badgeOriginal: 'Original',
  },
  en: {
    title: 'Bubble Translator', settings: 'Settings',
    ocrLang: 'Language of the text in the image', target: 'Translate to', precision: 'Reading accuracy',
    precPrecise: 'Accurate (recommended)', precFast: 'Fast', engine: 'Translation service (free)',
    langEng: 'English', langJpnVert: 'Japanese (vertical, manga)', langJpn: 'Japanese (horizontal)',
    langKor: 'Korean (webtoon)', langChiSim: 'Simplified Chinese (manhua)', langChiTra: 'Traditional Chinese',
    langFra: 'French', langSpa: 'Spanish', langDeu: 'German', langIta: 'Italian', langPor: 'Portuguese', langRus: 'Russian',
    tgtFr: 'French', tgtEn: 'English', tgtEs: 'Spanish', tgtDe: 'German', tgtIt: 'Italian', tgtPt: 'Portuguese',
    tgtAr: 'Arabic', tgtRu: 'Russian', tgtTr: 'Turkish', tgtId: 'Indonesian', tgtVi: 'Vietnamese', tgtJa: 'Japanese', tgtKo: 'Korean',
    dropTitle: 'Pick a comic or manga page, or a screenshot',
    pick: 'Choose images', pickMore: 'Add images',
    dropHint: 'You can also drag and drop or paste an image (Ctrl+V).',
    saveAll: 'Save all', clearAll: 'Clear all',
    install: 'Install the app',
    installAndroid: 'Install the app: it will show up in the “Share” menu of your screenshots.',
    installIos: 'To install on iPhone: Safari’s Share button, then “Add to Home Screen”.',
    privacy: 'Text recognition runs on your device; only the bubble text is sent to the translation service.',
    privacyLink: 'Privacy', home: 'Desktop extension',
    waiting: 'Waiting…', reading: 'Reading text…',
    readingFirst: 'Reading text… (first time: downloading models, 10 to 25 MB)',
    ocrEngine: 'Text recognition engine', ocrPaddle: 'PaddleOCR (recommended)', ocrTesseract: 'Tesseract (lighter)',
    translating: 'Translating…', noText: 'No text found',
    bubbles1: '1 bubble translated', bubblesN: '{0} bubbles translated', failed: '({0} not translated)',
    error: 'Error: {0}', errUnreadable: 'image could not be read', errSmall: 'image too small', errOcr: 'text recognition failed',
    original: 'Original', translation: 'Translation', save: 'Save', share: 'Share', retry: 'Retry',
    remove: 'Remove', badgeOriginal: 'Original',
  },
};
const LANG = navigator.language.toLowerCase().startsWith('fr') ? 'fr' : 'en';
const tr = (key, ...args) => (I18N[LANG][key] ?? I18N.en[key] ?? key).replace(/\{(\d)\}/g, (_, i) => args[i]);

document.documentElement.lang = LANG;
document.title = tr('title');
for (const el of document.querySelectorAll('[data-t]')) el.textContent = tr(el.dataset.t);
for (const el of document.querySelectorAll('[data-t-aria]')) el.setAttribute('aria-label', tr(el.dataset.tAria));

// ---------- Réglages ----------

const TARGETS = ['fr', 'en', 'es', 'de', 'it', 'pt', 'ar', 'ru', 'tr', 'id', 'vi', 'ja', 'ko'];
const uiLang = navigator.language.split('-')[0];
const DEFAULTS = { ocrLang: 'eng', targetLang: TARGETS.includes(uiLang) ? uiLang : 'en', engine: 'google', ocrEngine: 'paddle', precise: true };
let settings = { ...DEFAULTS, ...JSON.parse(localStorage.getItem('tb-settings') || '{}') };

for (const id of ['ocrLang', 'targetLang', 'engine', 'ocrEngine', 'precise']) {
  const el = document.getElementById(id);
  el.value = String(settings[id]);
  el.addEventListener('change', () => {
    settings = { ...settings, [id]: id === 'precise' ? el.value === 'true' : el.value };
    localStorage.setItem('tb-settings', JSON.stringify(settings));
  });
}
document.getElementById('settingsBtn').addEventListener('click', () => {
  const s = document.getElementById('settings');
  s.hidden = !s.hidden;
});

// ---------- Moteurs ----------

TBOcrRouter.configureFor(new URL('../', location.href).href);
const fontReady = TBRender.loadFont(new URL('../fonts/comic-neue-700.woff2', location.href).href);

// ---------- Liste des images ----------

const list = document.getElementById('list');
const items = [];
let running = false;
const usedLangs = new Set();

function errText(e) {
  const m = String(e?.message || e || '');
  if (m.startsWith('E_SMALL')) return tr('errSmall');
  if (m.startsWith('E_OCR')) return tr('errOcr');
  return m || tr('errUnreadable');
}

function addFiles(files) {
  const images = [...files].filter((f) => f.type.startsWith('image/'));
  for (const file of images) {
    const card = document.getElementById('card').content.firstElementChild.cloneNode(true);
    const item = {
      file, card, bitmap: null, translated: null, showOriginal: false, bubbles: null,
      canvas: card.querySelector('canvas'),
      status: card.querySelector('.status'),
      badge: card.querySelector('.badge'),
      toggle: card.querySelector('.toggle'),
      save: card.querySelector('.save'),
      retry: card.querySelector('.retry'),
    };
    item.toggle.textContent = tr('original');
    item.retry.textContent = tr('retry');
    item.save.textContent = canShareFiles() ? tr('share') : tr('save');
    card.querySelector('.remove').setAttribute('aria-label', tr('remove'));
    item.canvas.addEventListener('click', () => toggle(item));
    item.toggle.addEventListener('click', () => toggle(item));
    item.save.addEventListener('click', () => saveItems([item]));
    item.retry.addEventListener('click', () => { item.retry.hidden = true; enqueue(item); });
    card.querySelector('.remove').addEventListener('click', () => {
      card.remove();
      items.splice(items.indexOf(item), 1);
      refreshLayout();
    });
    list.appendChild(card);
    items.push(item);
    setStatus(item, tr('waiting'), true);
    enqueue(item);
  }
  refreshLayout();
  if (images.length) list.lastElementChild?.scrollIntoView?.({ behavior: 'smooth', block: 'nearest' });
}

function refreshLayout() {
  document.body.classList.toggle('compact', items.length > 0);
  document.getElementById('toolbar').hidden = items.length === 0;
  document.querySelector('#drop [data-t="pick"]').textContent = items.length ? tr('pickMore') : tr('pick');
}

function setStatus(item, text, busy = false, error = false) {
  item.status.textContent = '';
  if (busy) {
    const s = document.createElement('span');
    s.className = 'spin';
    item.status.appendChild(s);
  }
  item.status.append(text);
  item.status.classList.toggle('err', error);
}

function show(item, source) {
  item.canvas.width = source.width;
  item.canvas.height = source.height;
  item.canvas.getContext('2d').drawImage(source, 0, 0);
}

function toggle(item) {
  if (!item.translated) return;
  item.showOriginal = !item.showOriginal;
  show(item, item.showOriginal ? item.bitmap : item.translated);
  item.badge.textContent = item.showOriginal ? tr('badgeOriginal') : '';
  item.toggle.textContent = item.showOriginal ? tr('translation') : tr('original');
}

const queue = [];
function enqueue(item) {
  queue.push(item);
  if (!running) runQueue();
}

async function runQueue() {
  running = true;
  while (queue.length) {
    const item = queue.shift();
    if (items.includes(item)) await processItem(item);
  }
  running = false;
}

async function processItem(item) {
  try {
    item.bitmap ||= await createImageBitmap(item.file);
    show(item, item.bitmap);
    const lang = settings.ocrLang;
    const key = `${settings.ocrEngine}|${lang}`;
    setStatus(item, usedLangs.has(key) ? tr('reading') : tr('readingFirst'), true);
    const { bubbles } = await TBOcrRouter.run({
      source: { blob: item.file }, lang, precise: settings.precise, engine: settings.ocrEngine,
    });
    usedLangs.add(key);
    if (!bubbles.length) {
      setStatus(item, tr('noText'));
      return;
    }
    setStatus(item, tr('translating'), true);
    const { out } = await TBTranslate.translateTexts(bubbles.map((b) => b.text), settings, lang);
    item.bubbles = bubbles.map((b, i) => ({ ...b, translation: out[i] || null }));
    await fontReady;
    item.translated = TBRender.draw(item.bitmap, item.bubbles, { targetLang: settings.targetLang });
    item.showOriginal = false;
    show(item, item.translated);
    const n = item.bubbles.filter((b) => b.translation).length;
    const failed = item.bubbles.length - n;
    setStatus(item, (n === 1 ? tr('bubbles1') : tr('bubblesN', n)) + (failed ? ` ${tr('failed', failed)}` : ''));
    item.toggle.hidden = false;
    item.save.hidden = false;
    item.retry.hidden = !failed;
  } catch (e) {
    console.error(e);
    setStatus(item, tr('error', errText(e)), false, true);
    item.retry.hidden = false;
  }
}

// ---------- Enregistrer / partager ----------

function canShareFiles() {
  try {
    return !!navigator.canShare?.({ files: [new File([''], 'x.jpg', { type: 'image/jpeg' })] })
      && /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  } catch {
    return false;
  }
}

async function toFile(item) {
  const blob = await new Promise((r) => item.translated.toBlob(r, 'image/jpeg', 0.92));
  const base = (item.file.name || 'image').replace(/\.[^.]+$/, '');
  return new File([blob], `${base}-${settings.targetLang}.jpg`, { type: 'image/jpeg' });
}

async function saveItems(selected) {
  const files = await Promise.all(selected.filter((i) => i.translated).map(toFile));
  if (!files.length) return;
  if (canShareFiles() && navigator.canShare({ files })) {
    try {
      await navigator.share({ files });
      return;
    } catch (e) {
      if (e.name === 'AbortError') return;
    }
  }
  for (const f of files) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(f);
    a.download = f.name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }
}

document.getElementById('saveAll').addEventListener('click', () => saveItems(items));
document.getElementById('clearAll').addEventListener('click', () => {
  queue.length = 0;
  items.splice(0).forEach((i) => i.card.remove());
  refreshLayout();
});

// ---------- Entrées : sélecteur, glisser-déposer, coller, partage Android ----------

document.getElementById('file').addEventListener('change', (e) => {
  addFiles(e.target.files);
  e.target.value = '';
});

const drop = document.getElementById('drop');
for (const ev of ['dragenter', 'dragover']) {
  document.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); });
}
for (const ev of ['dragleave', 'drop']) {
  document.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); });
}
document.addEventListener('drop', (e) => addFiles(e.dataTransfer?.files || []));
document.addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.items || [])].filter((i) => i.kind === 'file').map((i) => i.getAsFile());
  if (files.length) addFiles(files);
});

// Images reçues via « Partager » (Android) : le service worker les a mises de côté.
async function loadShared() {
  if (!new URLSearchParams(location.search).has('shared') || !('caches' in window)) return;
  const cache = await caches.open('tb-shared');
  const files = [];
  for (const req of await cache.keys()) {
    const res = await cache.match(req);
    const blob = await res.blob();
    files.push(new File([blob], decodeURIComponent(res.headers.get('x-name') || 'image'), { type: blob.type }));
    await cache.delete(req);
  }
  history.replaceState(null, '', location.pathname);
  addFiles(files);
}

// ---------- Installation (PWA) ----------

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
const installBox = document.getElementById('install');
if (!standalone && /iPhone|iPad|iPod/i.test(navigator.userAgent)) {
  document.getElementById('installText').textContent = tr('installIos');
  installBox.hidden = false;
}
let deferredPrompt = null;
addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  document.getElementById('installText').textContent = tr('installAndroid');
  document.getElementById('installBtn').hidden = false;
  installBox.hidden = false;
});
document.getElementById('installBtn').addEventListener('click', async () => {
  if (!deferredPrompt) return;
  deferredPrompt.prompt();
  await deferredPrompt.userChoice;
  deferredPrompt = null;
  installBox.hidden = true;
});

loadShared();
