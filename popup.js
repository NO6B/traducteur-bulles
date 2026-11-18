const DEFAULTS = { ocrLang: 'auto', targetLang: 'fr', engine: 'google', ocrEngine: 'paddle', precise: true, autoSites: [] };
const $ = (id) => document.getElementById(id);
const t = (key) => chrome.i18n.getMessage(key) || key;
const ALL_SITES = { origins: ['<all_urls>'] };

(async () => {
  // Firefox : l'accès aux sites doit parfois être accordé à la main.
  if (!(await chrome.permissions.contains(ALL_SITES))) {
    $('grant').hidden = false;
    $('grant').addEventListener('click', async () => {
      if (await chrome.permissions.request(ALL_SITES)) $('grant').hidden = true;
    });
  }

  const s = await chrome.storage.sync.get(DEFAULTS);
  for (const id of ['ocrLang', 'targetLang', 'engine', 'ocrEngine', 'precise']) {
    const el = $(id);
    el.value = String(s[id]);
    el.addEventListener('change', () => {
      chrome.storage.sync.set({ [id]: id === 'precise' ? el.value === 'true' : el.value });
    });
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let host = null;
  try { host = /^https?:/.test(tab?.url) ? new URL(tab.url).hostname : null; } catch { /* page interne */ }
  const box = $('autoSite');
  if (!host) {
    box.disabled = true;
  } else {
    $('host').textContent = host;
    box.checked = s.autoSites.includes(host);
    box.addEventListener('change', async () => {
      const { autoSites } = await chrome.storage.sync.get(DEFAULTS);
      const next = box.checked ? [...new Set([...autoSites, host])] : autoSites.filter((h) => h !== host);
      await chrome.storage.sync.set({ autoSites: next });
      if (box.checked) command('translate-page');
    });
  }
})();

async function command(cmd) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  const res = await chrome.runtime.sendMessage({ target: 'background', type: 'popup-command', tabId: tab.id, command: cmd });
  if (res?.ok) window.close();
  else $('msg').textContent = t('popupCannot');
}

$('page').addEventListener('click', () => command('translate-page'));
$('clear').addEventListener('click', () => command('clear'));
$('clearCache').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ target: 'background', type: 'clear-cache' });
  $('clearCache').textContent = t('popupCacheCleared');
});
