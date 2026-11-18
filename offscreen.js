// Document offscreen (Chrome) : héberge les moteurs OCR (Web Worker, WebAssembly).
/* global TBOcr, TBPaddle, TBOcrRouter */
TBOcrRouter.configureFor(chrome.runtime.getURL(''));

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'offscreen' || msg.type !== 'ocr') return;
  TBOcrRouter.run(msg)
    .then((r) => sendResponse({ ok: true, ...r }))
    .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
  return true;
});
