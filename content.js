// Script de contenu : récupère l'image, affiche les traductions par-dessus les bulles.
(() => {
  if (window.__tradBulles) return;
  window.__tradBulles = true;

  const t = (key, subs) => chrome.i18n.getMessage(key, subs) || key;
  // Messages d'erreur du moteur (codes) -> texte lisible.
  const errText = (e) => {
    const m = String(e || '');
    if (m.startsWith('E_FETCH')) return t('errFetch');
    if (m.startsWith('E_SMALL')) return t('errSmall');
    if (m.startsWith('E_OCR')) return t('errOcr');
    return m || t('errUnreadable');
  };
  const bubblesLabel = (n) => (n === 1 ? t('stBubble1') : t('stBubblesN', [String(n)]));

  // Police BD de l'extension (repli sur les polices du système si le site la bloque).
  try {
    const face = new FontFace('TB Comic', `url(${chrome.runtime.getURL('fonts/comic-neue-700.woff2')})`, { weight: '700' });
    face.load().then((f) => document.fonts.add(f)).catch(() => {});
  } catch { /* FontFace indisponible */ }

  const states = new Map(); // img -> état de l'overlay
  let lastContextTarget = null;
  let pageMode = false;
  let io = null;
  let mo = null;
  const queue = [];
  let running = false;

  document.addEventListener('contextmenu', (e) => {
    lastContextTarget = e.target instanceof HTMLImageElement ? e.target : null;
  }, true);

  const send = (msg) =>
    chrome.runtime.sendMessage({ target: 'background', ...msg })
      .catch((e) => ({
        ok: false,
        fatal: /context invalidated/i.test(String(e.message)),
        error: /context invalidated/i.test(String(e.message))
          ? 'extension updated' : String(e.message || e),
      }));

  const pageLang = () =>
    document.documentElement.lang
    || document.querySelector('meta[http-equiv="content-language" i]')?.content
    || '';

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const nextFrames = (n) => new Promise((r) => {
    const step = () => (n-- <= 0 ? r() : requestAnimationFrame(step));
    step();
  });

  const srcOf = (img) => img.currentSrc || img.src;

  // ---------- Styles (Shadow DOM : le CSS du site ne s'applique pas) ----------

  const CSS = `
    :host { all: initial; }
    .layer { position: absolute; inset: 0; pointer-events: none; }
    .box {
      position: absolute; box-sizing: border-box; pointer-events: auto; cursor: pointer;
      display: flex; align-items: center; justify-content: center; text-align: center;
      background: #fff; color: #111; border-radius: 10px; padding: 2px 3px; overflow: hidden;
      transition: opacity .15s;
      font-family: "TB Comic", "Comic Neue", "Comic Sans MS", "Chalkboard SE", "Segoe UI", system-ui, sans-serif;
      font-weight: 700; line-height: 1.12; box-shadow: 0 0 0 1px rgba(0,0,0,.08);
    }
    .box > div { width: 100%; overflow-wrap: normal; hyphens: auto; }
    .box.wrap > div { overflow-wrap: anywhere; }
    .box.dark { color: #fff; box-shadow: 0 0 0 1px rgba(255,255,255,.12); }
    .box.err { box-shadow: inset 0 0 0 2px rgba(220,0,0,.6); font-weight: 400; }
    .box.off { background: transparent !important; color: transparent; box-shadow: inset 0 0 0 1px rgba(255,80,0,.7); }
    .hidden .box { display: none; }
    .bar {
      position: absolute; top: 4px; left: 4px; display: flex; gap: 4px; align-items: center;
      pointer-events: auto; font: 12px/1.2 system-ui, sans-serif; color: #fff;
      background: rgba(20,20,20,.82); border-radius: 6px; padding: 3px 4px 3px 8px; max-width: calc(100% - 8px);
      opacity: .85;
    }
    .bar:hover { opacity: 1; }
    .bar button {
      all: unset; cursor: pointer; padding: 2px 7px; border-radius: 4px; background: rgba(255,255,255,.15);
      font: 12px/1.2 system-ui, sans-serif; color: #fff;
    }
    .bar button:hover { background: rgba(255,255,255,.3); }
    .bar button[hidden] { display: none; }
    .spin { width: 10px; height: 10px; border: 2px solid rgba(255,255,255,.35); border-top-color: #fff;
      border-radius: 50%; animation: s .8s linear infinite; flex: none; }
    @keyframes s { to { transform: rotate(360deg); } }
    .status { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  `;

  // ---------- Overlay par image ----------

  function createOverlay(img) {
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;z-index:2147483646;pointer-events:none;margin:0;padding:0;border:0;';
    const root = host.attachShadow({ mode: 'open' });
    const el = (tag, cls, text) => {
      const e = document.createElement(tag);
      if (cls) e.className = cls;
      if (text) e.textContent = text;
      return e;
    };
    const bar = el('div', 'bar');
    const retryBtn = el('button', 'retry');
    const toggleBtn = el('button', 'toggle');
    retryBtn.hidden = toggleBtn.hidden = true;
    bar.append(el('span', 'spin'), el('span', 'status'), retryBtn, toggleBtn, el('button', 'close', '✕'));
    root.append(el('style', null, CSS), el('div', 'layer'), bar);
    document.documentElement.appendChild(host);

    const st = {
      img, host, root, src: srcOf(img), busy: true, lastW: 0, lastH: 0,
      layer: root.querySelector('.layer'),
      status: root.querySelector('.status'),
      spin: root.querySelector('.spin'),
      toggle: root.querySelector('.toggle'),
      retry: root.querySelector('.retry'),
    };
    st.retry.textContent = t('btnRetry');
    st.toggle.textContent = t('btnOriginal');
    root.querySelector('.close').title = t('btnClose');
    st.setStatus = (text, busy = true) => {
      st.status.textContent = text;
      st.spin.style.display = busy ? '' : 'none';
    };
    st.toggle.addEventListener('click', () => {
      const hidden = st.layer.classList.toggle('hidden');
      st.toggle.textContent = hidden ? t('btnTranslation') : t('btnOriginal');
    });
    root.querySelector('.close').addEventListener('click', () => removeState(img));
    st.retry.addEventListener('click', () => processImage(img, { force: true }));
    states.set(img, st);
    place(st);
    return st;
  }

  function removeState(img) {
    const st = states.get(img);
    if (!st) return;
    st.host.remove();
    states.delete(img);
  }

  function place(st) {
    const { img, host } = st;
    if (!img.isConnected) return removeState(img);
    if (!st.busy && srcOf(img) !== st.src) { // l'image a changé (lecteur en ligne, lazy-loading)
      removeState(img);
      if (pageMode) watchImage(img);
      return;
    }
    const r = img.getBoundingClientRect();
    const visible = r.width > 0 && r.height > 0 && r.bottom > -200 && r.top < innerHeight + 200;
    host.style.display = visible ? '' : 'none';
    if (!visible) return;
    host.style.transform = `translate(${r.left}px, ${r.top}px)`;
    host.style.width = `${r.width}px`;
    host.style.height = `${r.height}px`;
    if (Math.abs(r.width - st.lastW) > 1 || Math.abs(r.height - st.lastH) > 1) {
      st.lastW = r.width;
      st.lastH = r.height;
      st.layer.querySelectorAll('.box').forEach(fit);
    }
    if (st.covered && !st.busy) {
      const v0 = Math.max(0, -r.top) / r.height;
      const v1 = Math.min(r.height, innerHeight - r.top) / r.height;
      const uncovered = Math.max(0, st.covered[0] - v0) + Math.max(0, v1 - st.covered[1]);
      if (uncovered * r.height > Math.min(250, innerHeight / 3)) {
        clearTimeout(st.moreTimer);
        st.moreTimer = setTimeout(() => !st.busy && states.has(img) && captureMore(st), 500); // attendre la fin du défilement
      }
    }
  }

  let placePending = false;
  function placeAll() {
    if (placePending) return;
    placePending = true;
    requestAnimationFrame(() => {
      placePending = false;
      states.forEach(place);
    });
  }
  addEventListener('scroll', placeAll, { capture: true, passive: true });
  addEventListener('resize', placeAll, { passive: true });
  setInterval(() => states.size && placeAll(), 600);

  // Ajuste la taille de police pour que la traduction tienne dans la bulle ;
  // si elle deviendrait illisible, le cadre s'élargit un peu (il reste dans la bulle d'origine en général).
  function fit(box) {
    for (const grow of [1, 1.25, 1.5]) {
      setGeometry(box, grow);
      if (fitFont(box) >= 11) return;
    }
  }

  function setGeometry(box, grow) {
    const g = JSON.parse(box.dataset.geo);
    const w = Math.min(1, g.w * grow), h = Math.min(1, g.h * (1 + (grow - 1) * 0.6));
    const x = Math.min(Math.max(0, g.x - (w - g.w) / 2), 1 - w);
    const y = Math.min(Math.max(0, g.y - (h - g.h) / 2), 1 - h);
    box.style.left = `${x * 100}%`;
    box.style.top = `${y * 100}%`;
    box.style.width = `${w * 100}%`;
    box.style.height = `${h * 100}%`;
  }

  function fitFont(box) {
    const inner = box.firstChild;
    const availH = box.clientHeight - 4;
    box.classList.remove('wrap');
    let lo = 6, hi = Math.max(8, Math.min(48, availH));
    for (let i = 0; i < 7; i++) {
      const mid = (lo + hi) / 2;
      inner.style.fontSize = `${mid}px`;
      const fits = inner.scrollHeight <= availH && inner.scrollWidth <= inner.clientWidth + 1;
      if (fits) lo = mid; else hi = mid;
    }
    inner.style.fontSize = `${lo}px`;
    if (inner.scrollWidth > inner.clientWidth + 1) box.classList.add('wrap');
    return lo;
  }

  function render(st, bubbles, region, append = false) {
    const r = st.img.getBoundingClientRect();
    const aspect = r.width / Math.max(1, r.height);
    if (!append) st.layer.textContent = '';
    for (const b of bubbles) {
      const padX = b.pad * region.w;
      const padY = padX * aspect;
      const x = region.x + b.x * region.w - padX;
      const y = region.y + b.y * region.h - padY;
      const w = b.w * region.w + 2 * padX;
      const h = b.h * region.h + 2 * padY;
      const box = document.createElement('div');
      box.className = 'box' + (b.translation ? '' : ' err') + (b.dark ? ' dark' : '');
      if (b.bg) box.style.background = b.bg;
      const gx = Math.max(0, x), gy = Math.max(0, y);
      box.dataset.geo = JSON.stringify({ x: gx, y: gy, w: Math.min(1 - gx, w), h: Math.min(1 - gy, h) });
      setGeometry(box, 1);
      box.title = t('boxTitle', [b.text]);
      const inner = document.createElement('div');
      inner.textContent = b.translation || b.text;
      box.appendChild(inner);
      box.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        box.classList.toggle('off');
      });
      st.layer.appendChild(box);
    }
    st.lastW = 0; // force l'ajustement des polices
    place(st);
  }

  // ---------- Récupération des pixels de l'image ----------

  function canvasDataUrl(img) {
    if (srcOf(img).startsWith('data:')) return srcOf(img);
    if (!img.complete || !img.naturalWidth) return null;
    try {
      const c = document.createElement('canvas');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      c.getContext('2d').drawImage(img, 0, 0);
      return c.toDataURL('image/png'); // échoue si l'image est « tainted » (autre origine sans CORS)
    } catch {
      return null;
    }
  }

  // Capture la partie de l'image visible à l'écran (fraction verticale de l'image couverte).
  async function captureVisible(st) {
    const r = st.img.getBoundingClientRect();
    const x0 = Math.max(0, r.left), y0 = Math.max(0, r.top);
    const x1 = Math.min(innerWidth, r.right), y1 = Math.min(innerHeight, r.bottom);
    if (x1 - x0 < 50 || y1 - y0 < 50) return null;
    st.setStatus(t('stCapture'));
    st.host.style.visibility = 'hidden';
    await nextFrames(2);
    const res = await send({
      pageLang: pageLang(),
      type: 'process-capture',
      rect: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 },
      dpr: devicePixelRatio,
    });
    st.host.style.visibility = '';
    const region = { x: (x0 - r.left) / r.width, y: (y0 - r.top) / r.height, w: (x1 - x0) / r.width, h: (y1 - y0) / r.height };
    // Près d'un bord coupé par l'écran, les bulles peuvent être tronquées : on ne garde que
    // celles dont le centre est dans la zone « sûre » ; les autres seront lues au défilement.
    const cutTop = region.y > 0.001, cutBottom = region.y + region.h < 0.999;
    const m = Math.min(0.3 * region.h, 150 / r.height);
    const covered = [region.y + (cutTop ? m : 0), region.y + region.h - (cutBottom ? m : 0)];
    if (res?.ok) {
      res.bubbles = res.bubbles.filter((b) => {
        const cy = region.y + (b.y + b.h / 2) * region.h;
        return cy >= covered[0] && cy <= covered[1];
      });
    }
    return { res, region, covered };
  }

  // Mode capture : quand une partie encore non lue de l'image devient visible, on la capture aussi.
  async function captureMore(st) {
    st.busy = true;
    const cap = await captureVisible(st);
    st.busy = false;
    if (!cap?.res?.ok || !states.has(st.img)) return st.setStatus(st.lastStatus, false);
    const { res, region } = cap;
    const [c0, c1] = st.covered;
    const fresh = res.bubbles.filter((b) => {
      const cy = region.y + (b.y + b.h / 2) * region.h;
      return cy < c0 || cy > c1;
    });
    st.covered = [Math.min(c0, cap.covered[0]), Math.max(c1, cap.covered[1])];
    if (fresh.length) render(st, fresh, region, true);
    st.count += fresh.length;
    st.lastStatus = bubblesLabel(st.count);
    st.setStatus(st.lastStatus, false);
    st.toggle.hidden = !st.count;
  }

  async function processImage(img, { force = false } = {}) {
    if (states.has(img)) {
      if (states.get(img).busy) return;
      removeState(img);
    }
    const st = createOverlay(img);
    st.setStatus(t('stReading'));
    let region = { x: 0, y: 0, w: 1, h: 1 };
    let res;
    const url = srcOf(img);
    const key = /^https?:/i.test(url) && !force ? url : null; // clé du cache (pages déjà traduites)
    const common = { key, pageLang: pageLang() };

    const dataUrl = canvasDataUrl(img);
    if (dataUrl) {
      res = await send({ type: 'process', source: { dataUrl }, ...common });
      if (!res?.ok && !res?.fatal) { // échec passager : une nouvelle tentative
        await sleep(1500);
        res = await send({ type: 'process', source: { dataUrl }, ...common });
      }
    } else {
      if (/^https?:/i.test(url)) res = await send({ type: 'process', source: { url }, ...common });
      // Dernier recours : capture d'écran de la partie visible de l'image.
      if (!res?.ok && window === window.top) {
        const cap = await captureVisible(st);
        if (cap) {
          ({ res, region } = cap);
          st.covered = cap.covered;
        }
      }
    }

    if (!states.has(img)) return; // retiré entre-temps
    st.busy = false;
    if (!res?.ok) {
      st.setStatus(t('errPrefix', [res?.fatal ? t('errReload') : errText(res?.error)]), false);
      st.retry.hidden = !!res?.fatal;
      return;
    }
    const n = res.bubbles.length;
    st.count = n;
    if (!n && !st.covered) {
      st.setStatus(t('stNoText'), false);
      setTimeout(() => states.get(img) === st && removeState(img), 4000);
      return;
    }
    render(st, res.bubbles, region);
    const failed = res.bubbles.filter((b) => !b.translation).length;
    st.lastStatus = bubblesLabel(n) + (failed ? ` ${t('stFailed', [String(failed)])}` : '');
    st.setStatus(st.lastStatus, false);
    st.toggle.hidden = !n;
    st.retry.hidden = !failed && !res.error;
    if (res.error) st.status.title = t('errTranslate', [res.error]);
  }

  // ---------- Mode page entière (avec images chargées au défilement) ----------

  function eligible(img) {
    if (states.has(img) || !img.complete || img.naturalWidth < 150 || img.naturalHeight < 150) return false;
    const r = img.getBoundingClientRect();
    return r.width >= 120 && r.height >= 120;
  }

  const progress = (n) => send({ type: 'progress', pending: n });

  function enqueue(img) {
    if (!queue.includes(img)) queue.push(img);
    progress(queue.length + (running ? 1 : 0));
    if (running) return;
    running = true;
    (async () => {
      while (queue.length) {
        // Priorité à l'image la plus proche de l'écran.
        const dist = (i) => Math.abs(i.getBoundingClientRect().top);
        queue.sort((a, b) => dist(a) - dist(b));
        const next = queue.shift();
        progress(queue.length + 1);
        if (pageMode && next.isConnected && eligible(next)) await processImage(next);
      }
      running = false;
      progress(0);
    })();
  }

  function watchImage(img) {
    if (!io) return;
    io.unobserve(img);
    io.observe(img);
    if (!img.complete) img.addEventListener('load', () => watchImage(img), { once: true });
  }

  function scan() {
    for (const img of document.images) if (!states.has(img)) watchImage(img);
  }

  function startPageMode() {
    if (pageMode) return scan();
    pageMode = true;
    io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting && eligible(e.target)) {
          io.unobserve(e.target);
          enqueue(e.target);
        }
      }
    }, { rootMargin: '1500px 0px' }); // préchargement : traduit avant que l'image n'arrive à l'écran
    let t = null;
    mo = new MutationObserver(() => {
      clearTimeout(t);
      t = setTimeout(scan, 400);
    });
    mo.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'srcset'] });
    scan();
  }

  function clearAll() {
    pageMode = false;
    io?.disconnect();
    mo?.disconnect();
    io = mo = null;
    queue.length = 0;
    progress(0);
    [...states.keys()].forEach(removeState);
  }

  function findImage(srcUrl) {
    const imgs = [...document.images].filter((i) => i.currentSrc === srcUrl || i.src === srcUrl);
    if (lastContextTarget && imgs.includes(lastContextTarget)) return lastContextTarget;
    const area = (i) => { const r = i.getBoundingClientRect(); return r.width * r.height; };
    return imgs.sort((a, b) => area(b) - area(a))[0] || null;
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'translate-image') {
      const img = findImage(msg.srcUrl);
      if (img) processImage(img);
    } else if (msg.type === 'translate-page') {
      startPageMode();
    } else if (msg.type === 'clear') {
      clearAll();
    }
  });
})();
