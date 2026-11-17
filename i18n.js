// Remplit les éléments marqués data-i18n avec le texte dans la langue du navigateur.
for (const el of document.querySelectorAll('[data-i18n]')) {
  el.textContent = chrome.i18n.getMessage(el.dataset.i18n) || el.textContent;
}
document.documentElement.lang = chrome.i18n.getUILanguage();
