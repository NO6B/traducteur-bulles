const DEFAULTS = { ocrLang: 'eng', targetLang: 'fr', engine: 'google' };
const ids = Object.keys(DEFAULTS);

chrome.storage.sync.get(DEFAULTS).then((s) => {
  for (const id of ids) {
    const el = document.getElementById(id);
    el.value = s[id];
    el.addEventListener('change', () => chrome.storage.sync.set({ [id]: el.value }));
  }
});

async function command(cmd) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  const res = await chrome.runtime.sendMessage({ target: 'background', type: 'popup-command', tabId: tab.id, command: cmd });
  if (res?.ok) window.close();
  else document.getElementById('msg').textContent = 'Impossible sur cette page (pages Chrome, Web Store…).';
}

document.getElementById('page').addEventListener('click', () => command('translate-page'));
document.getElementById('clear').addEventListener('click', () => command('clear'));
