// Choix du moteur de lecture : PaddleOCR par défaut, Tesseract en secours automatique
// (modèles impossibles à télécharger, appareil trop ancien…).
// Expose globalThis.TBOcrRouter = { configureFor, run }.
/* global TBOcr, TBPaddle */
(() => {
function configureFor(base) {
  // base : URL du dossier racine (extension ou site), terminée par « / ».
  TBOcr.configure({ workerPath: `${base}lib/worker.min.js`, corePath: `${base}lib/core/`, workerBlobURL: false });
  TBPaddle.configure({ wasmPaths: `${base}lib/ort/`, dictBase: `${base}models/` });
}

async function run(msg) {
  if (msg.engine === 'tesseract') return { ...(await TBOcr.run(msg)), engine: 'tesseract' };
  try {
    return { ...(await TBPaddle.run(msg)), engine: 'paddle' };
  } catch (e) {
    if (/^E_(FETCH|SMALL)/.test(String(e?.message))) throw e; // l'image elle-même pose problème
    console.warn('PaddleOCR indisponible, passage à Tesseract :', e);
    return { ...(await TBOcr.run(msg)), engine: 'tesseract', fallback: true };
  }
}

globalThis.TBOcrRouter = { configureFor, run };
})();
