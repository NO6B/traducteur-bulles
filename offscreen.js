// Document offscreen (Chrome) : héberge le moteur OCR, qui a besoin d'un Web Worker.
/* global TBOcr */
TBOcr.configure({
  workerPath: chrome.runtime.getURL('lib/worker.min.js'),
  corePath: chrome.runtime.getURL('lib/core/'),
  workerBlobURL: false,
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'offscreen' || msg.type !== 'ocr') return;
  TBOcr.run(msg)
    .then((r) => sendResponse({ ok: true, ...r }))
    .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
  return true;
});
