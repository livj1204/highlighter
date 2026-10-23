(() => {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const body = document.body;
  const canvas = $('#canvas');
  const ctx = canvas.getContext('2d');
  const stage = $('#stage');
  const sheet = $('#sheet');
  const dropzone = $('#dropzone');
  const fileInput = $('#fileInput');
  const hintChip = $('#hintChip');
  const hintText = $('#hintText');
  const page = $('#page');
  const pageText = $('#pageText');
  const pageCanvas = $('#pageCanvas');
  const textInput = $('#textInput');
  const pager = $('#pager');
  const pagerNum = $('#pagerNum');
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  const THICKNESS_LABELS = ['얇게', '보통', '굵게'];
  const UNIT_NAMES = { image: { glyph: '글자', word: '단어', line: '줄' }, text: { glyph: '글자', word: '단어', line: '문장' } };

  const settings = { unit: 'glyph', thickness: 1, alpha: 0.45, shape: 'round', color: '#FFE24A', eraser: false };

  const image = { bitmap: null, name: 'image', width: 0, height: 0, layout: null, lum: null, busy: false };
  const text = { raw: '', typeset: false, index: null };
  // 연 PDF. 쪽마다 칠한 곳·되돌리기·글자 자리를 따로 들고 있고, 그린 그림은 가까운 몇 쪽만 남긴다.
  const pdfView = { doc: null, count: 0, index: -1, want: -1, pages: [], loading: '' };
  let pdfTicket = 0;

  const modes = {
    image: { marks: [], history: [], pending: null, preview: null },
    text: { marks: [], history: [], pending: null, preview: null },
  };
  let mode = 'image';
  let showOriginal = false;
  let drag = null;
  let hintTimer = 0;

  // ---------------------------------------------------------------- 공통 그리기

  function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function roundRectPath(c, x, y, w, h, r) {
    const rr = Math.max(0, Math.min(r, w / 2, h / 2));
    c.moveTo(x + rr, y);
    c.arcTo(x + w, y, x + w, y + h, rr);
    c.arcTo(x + w, y + h, x, y + h, rr);
    c.arcTo(x, y + h, x, y, rr);
    c.arcTo(x, y, x + w, y, rr);
    c.closePath();
  }

  function shapePath(c, s, shape, seed) {
    const w = s.x1 - s.x0;
    const h = s.y1 - s.y0;
    c.beginPath();
    if (shape === 'square') {
      c.rect(s.x0, s.y0, w, h);
    } else if (shape === 'hand') {
      // 끝이 비스듬한 펜촉으로 긋은 것처럼, 위아래 가장자리를 살짝 흔든다.
      const rnd = mulberry32(seed);
      const slant = Math.min(h * 0.28, w * 0.3);
      const amp = h * 0.045;
      const n = Math.max(2, Math.ceil(w / Math.max(8, h * 0.7)));
      c.moveTo(s.x0 + slant, s.y0 + (rnd() - 0.5) * 2 * amp);
      for (let i = 1; i <= n; i++) c.lineTo(s.x0 + slant + (w - slant) * i / n, s.y0 + (rnd() - 0.5) * 2 * amp);
      for (let i = n; i >= 0; i--) c.lineTo(s.x0 + (w - slant) * i / n, s.y1 + (rnd() - 0.5) * 2 * amp);
      c.closePath();
    } else {
      roundRectPath(c, s.x0, s.y0, w, h, Math.min(h * 0.32, 12));
    }
  }

  const scratch = document.createElement('canvas');
  const sctx = scratch.getContext('2d');

  // 한 번 칠한 곳 안에서 겹친 부분이 더 진해지지 않도록, 불투명하게 그린 뒤 한 번에 합성한다.
  function paintMark(target, mark, segs, blendOf, scale) {
    const groups = new Map();
    for (const s of segs) {
      const blend = blendOf(s);
      if (!groups.has(blend)) groups.set(blend, []);
      groups.get(blend).push(s);
    }
    for (const [blend, list] of groups) {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const s of list) {
        x0 = Math.min(x0, s.x0); y0 = Math.min(y0, s.y0);
        x1 = Math.max(x1, s.x1); y1 = Math.max(y1, s.y1);
      }
      x0 = Math.floor(x0) - 2; y0 = Math.floor(y0) - 2;
      const w = Math.ceil(x1) + 2 - x0;
      const h = Math.ceil(y1) + 2 - y0;
      if (w <= 0 || h <= 0) continue;
      scratch.width = Math.ceil(w * scale);
      scratch.height = Math.ceil(h * scale);
      sctx.setTransform(scale, 0, 0, scale, -x0 * scale, -y0 * scale);
      sctx.fillStyle = mark.color;
      list.forEach((s, i) => { shapePath(sctx, s, mark.shape, mark.seed + i * 7919); sctx.fill(); });
      target.save();
      target.globalCompositeOperation = blend;
      target.globalAlpha = blend === 'multiply' ? mark.alpha : Math.min(1, mark.alpha * 1.15);
      target.drawImage(scratch, x0, y0, w, h);
      target.restore();
    }
  }

  function outlineSegments(target, segs, lineWidth) {
    target.save();
    target.strokeStyle = '#2B2622';
    target.lineWidth = lineWidth;
    target.setLineDash([lineWidth * 4, lineWidth * 3]);
    for (const s of segs) {
      target.beginPath();
      roundRectPath(target, s.x0, s.y0, s.x1 - s.x0, s.y1 - s.y0, Math.min((s.y1 - s.y0) * 0.3, 10));
      target.stroke();
    }
    target.restore();
  }

  function newMark(a, b) {
    return {
      a, b,
      color: settings.color,
      alpha: settings.alpha,
      thickness: settings.thickness,
      shape: settings.shape,
      seed: (Math.random() * 1e9) | 0,
    };
  }

  // [a, b] 구간을 모든 칠에서 빼낸다(지우개).
  function subtractRange(marks, a, b) {
    const out = [];
    for (const m of marks) {
      if (b < m.a || a > m.b) { out.push(m); continue; }
      if (a > m.a) out.push({ ...m, b: a - 1 });
      if (b < m.b) out.push({ ...m, a: b + 1, seed: m.seed + 1 });
    }
    return out;
  }

  function commit(a, b) {
    const st = modes[mode];
    st.history.push(st.marks.slice());
    if (st.history.length > 60) st.history.shift();
    st.marks = settings.eraser ? subtractRange(st.marks, a, b) : st.marks.concat(newMark(a, b));
    st.preview = null;
    st.pending = null;
    redraw();
    updateButtons();
  }

  function undo() {
    const st = modes[mode];
    if (!st.history.length) return;
    st.marks = st.history.pop();
    st.pending = null;
    redraw();
    updateButtons();
  }

  // ---------------------------------------------------------------- 안내

  function hint(message, duration = 0) {
    clearTimeout(hintTimer);
    if (!message) { hintChip.hidden = true; return; }
    hintText.textContent = message;
    hintChip.hidden = false;
    if (duration) hintTimer = setTimeout(() => { hintChip.hidden = true; }, duration);
  }

  function restingHint() {
    if (mode === 'image' && pdfView.loading) return pdfView.loading;
    if (settings.eraser) return '지우개 · 지울 곳을 드래그하거나 시작과 끝을 눌러요';
    if (mode === 'image') {
      if (image.busy) return '글자 자리를 찾는 중…';
      if (!image.layout) return '';
      if (!image.layout.lines.length) return '글자를 찾지 못했어요. 글로 다시 쓰기를 써 보세요';
      return '드래그해서 칠해요 · 줄이 바뀌어도 이어져요';
    }
    return text.typeset ? '드래그해서 칠해요 · 시작과 끝을 눌러도 돼요' : '';
  }

  function refreshHint() { hint(restingHint()); }

  function pendingHint() {
    const unit = UNIT_NAMES[mode][settings.unit];
    hint(`끝 ${unit === '글자' ? '글자' : unit}를 눌러요 · 같은 곳을 한 번 더 누르면 그 ${unit}만 칠해요`);
  }

  // ---------------------------------------------------------------- 이미지 모드

  function buildLayout(result, scale) {
    const glyphs = [];
    const words = [];
    const lines = [];
    const inv = 1 / scale;
    result.lines.forEach((L, li) => {
      const line = { x0: L.x0 * inv, y0: L.y0 * inv, x1: L.x1 * inv, y1: L.y1 * inv, g0: glyphs.length };
      for (const W of L.words) {
        const word = { line: li, g0: glyphs.length };
        for (const U of W.units) glyphs.push({ line: li, word: words.length, x0: U.x0 * inv, x1: U.x1 * inv });
        word.g1 = glyphs.length - 1;
        words.push(word);
      }
      line.g1 = glyphs.length - 1;
      lines.push(line);
    });
    const heights = lines.map((l) => l.y1 - l.y0).sort((x, y) => x - y);
    const medianH = heights.length ? heights[heights.length >> 1] : 16;
    for (const line of lines) {
      const h = Math.max(line.y1 - line.y0, medianH * 0.8);
      const cy = (line.y0 + line.y1) / 2;
      line.band = { top: cy - h / 2, bottom: cy + h / 2, h };
    }
    return { glyphs, words, lines, medianH };
  }

  function runEngine(payload) {
    const direct = () => new Promise((resolve, reject) => {
      setTimeout(() => {
        try { resolve(window.InkEngine.segment(payload)); } catch (err) { reject(err); }
      }, 30);
    });
    let worker = null;
    try { worker = new Worker('ink-worker.js?v=20261024-1'); } catch (err) { worker = null; }
    if (!worker) return direct();
    return new Promise((resolve, reject) => {
      worker.onmessage = (ev) => {
        worker.terminate();
        if (ev.data.ok) resolve(ev.data.result); else reject(new Error(ev.data.message));
      };
      worker.onerror = (ev) => {
        if (ev.preventDefault) ev.preventDefault();
        worker.terminate();
        direct().then(resolve, reject);
      };
      worker.postMessage(payload);
    });
  }

  function buildLumGrid(bitmap, w, h) {
    const cell = 8;
    const gw = Math.max(1, Math.ceil(w / cell));
    const gh = Math.max(1, Math.ceil(h / cell));
    const c = document.createElement('canvas');
    c.width = gw; c.height = gh;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.imageSmoothingQuality = 'high';
    g.drawImage(bitmap, 0, 0, gw, gh);
    const d = g.getImageData(0, 0, gw, gh).data;
    const lum = new Float32Array(gw * gh);
    for (let i = 0; i < lum.length; i++) lum[i] = (d[i * 4] * 0.299 + d[i * 4 + 1] * 0.587 + d[i * 4 + 2] * 0.114) / 255;
    return { lum, gw, gh, cell };
  }

  function lumAt(s) {
    const L = image.lum;
    const cx0 = Math.max(0, Math.floor(s.x0 / L.cell)), cx1 = Math.min(L.gw - 1, Math.floor(s.x1 / L.cell));
    const cy0 = Math.max(0, Math.floor(s.y0 / L.cell)), cy1 = Math.min(L.gh - 1, Math.floor(s.y1 / L.cell));
    let sum = 0, n = 0;
    for (let y = cy0; y <= cy1; y++) for (let x = cx0; x <= cx1; x++) { sum += L.lum[y * L.gw + x]; n++; }
    return n ? sum / n : 1;
  }

  const blendOfImage = (s) => (lumAt(s) > 0.5 ? 'multiply' : 'source-over');

  function imageBand(line, thickness) {
    const t = line.band;
    if (thickness === 0) return [t.bottom - t.h * 0.42, t.bottom + t.h * 0.10];
    if (thickness === 2) return [t.top - t.h * 0.30, t.bottom + t.h * 0.30];
    return [t.top - t.h * 0.14, t.bottom + t.h * 0.14];
  }

  function imageSegments(a, b, thickness) {
    const L = image.layout;
    const segs = [];
    let i = a;
    while (i <= b) {
      const line = L.lines[L.glyphs[i].line];
      const end = Math.min(b, line.g1);
      const [y0, y1] = imageBand(line, thickness);
      const padX = Math.max(2, (y1 - y0) * 0.10);
      segs.push({ x0: L.glyphs[i].x0 - padX, x1: L.glyphs[end].x1 + padX, y0, y1 });
      i = end + 1;
    }
    return segs;
  }

  function imageExpand(a, b) {
    const L = image.layout;
    if (a > b) [a, b] = [b, a];
    if (settings.unit === 'word') { a = L.words[L.glyphs[a].word].g0; b = L.words[L.glyphs[b].word].g1; }
    else if (settings.unit === 'line') { a = L.lines[L.glyphs[a].line].g0; b = L.lines[L.glyphs[b].line].g1; }
    return [a, b];
  }

  function imagePoint(e) {
    const r = canvas.getBoundingClientRect();
    return { x: (e.clientX - r.left) * canvas.width / r.width, y: (e.clientY - r.top) * canvas.height / r.height };
  }

  function hitGlyph(p) {
    const L = image.layout;
    if (!L || !L.lines.length) return -1;
    let best = -1, bestD = Infinity;
    L.lines.forEach((line, li) => {
      const pad = Math.max((line.y1 - line.y0) * 0.6, L.medianH * 0.5);
      const dy = p.y < line.y0 - pad ? line.y0 - pad - p.y : p.y > line.y1 + pad ? p.y - line.y1 - pad : 0;
      const dx = p.x < line.x0 ? line.x0 - p.x : p.x > line.x1 ? p.x - line.x1 : 0;
      const d = dy * 3 + dx;
      if (d < bestD) { bestD = d; best = li; }
    });
    if (best < 0 || bestD > L.medianH * 4) return -1;
    const line = L.lines[best];
    let g = line.g0, gd = Infinity;
    for (let i = line.g0; i <= line.g1; i++) {
      const G = L.glyphs[i];
      const d = p.x < G.x0 ? G.x0 - p.x : p.x > G.x1 ? p.x - G.x1 : 0;
      if (d < gd) { gd = d; g = i; }
    }
    return g;
  }

  function renderImage() {
    if (!image.bitmap) return;
    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(image.bitmap, 0, 0);
    ctx.restore();
    if (showOriginal || !image.layout) return;
    const st = modes.image;
    for (const m of st.marks) paintMark(ctx, m, imageSegments(m.a, m.b, m.thickness), blendOfImage, 1);
    const lw = Math.max(1.5, canvas.width / 700);
    if (st.preview) {
      const segs = imageSegments(st.preview.a, st.preview.b, st.preview.thickness);
      if (settings.eraser) outlineSegments(ctx, segs, lw);
      else paintMark(ctx, st.preview, segs, blendOfImage, 1);
    }
    if (st.pending !== null) {
      const G = image.layout.glyphs[st.pending];
      const line = image.layout.lines[G.line];
      ctx.save();
      ctx.fillStyle = '#2B2622';
      ctx.fillRect(G.x0 - lw * 1.5, line.band.top - line.band.h * 0.2, lw * 2, line.band.h * 1.4);
      ctx.restore();
    }
  }

  const blankEntry = () => ({ canvas: null, layout: null, lum: null, marks: [], history: [] });

  async function loadImageFile(file) {
    if (isPdf(file)) { openPdf(file); return; }
    if (!file || !/^image\//.test(file.type)) { hint('이미지나 PDF 파일만 열 수 있어요', 2600); return; }
    let bitmap;
    try {
      bitmap = await createImageBitmap(file);
    } catch (err) {
      hint('이 이미지는 열 수 없어요. PNG나 JPG로 다시 저장해 보세요', 4000);
      return;
    }
    closePdf();
    setMode('image');
    image.name = (file.name || 'image').replace(/\.[^.]+$/, '') || 'image';
    showBitmap(bitmap, blankEntry());
  }

  // 이미지(또는 PDF 한 쪽)를 캔버스에 올린다. 처음 보는 그림이면 글자 자리를 찾아 entry에 남긴다.
  async function showBitmap(bitmap, entry) {
    image.bitmap = bitmap;
    image.width = bitmap.width;
    image.height = bitmap.height;
    if (!entry.lum) entry.lum = buildLumGrid(bitmap, bitmap.width, bitmap.height);
    image.lum = entry.lum;
    image.layout = entry.layout;
    modes.image.marks = entry.marks;
    modes.image.history = entry.history;
    modes.image.pending = null;
    modes.image.preview = null;
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    dropzone.hidden = true;
    sheet.hidden = false;
    image.busy = !entry.layout;
    renderImage();
    updateButtons();
    refreshHint();
    if (entry.layout) return;
    let layout;
    try {
      const maxSide = 2600;
      const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
      const w = Math.max(1, Math.round(bitmap.width * scale));
      const h = Math.max(1, Math.round(bitmap.height * scale));
      const work = document.createElement('canvas');
      work.width = w; work.height = h;
      const wctx = work.getContext('2d', { willReadFrequently: true });
      wctx.drawImage(bitmap, 0, 0, w, h);
      const data = wctx.getImageData(0, 0, w, h);
      const result = await runEngine({ data: data.data, width: w, height: h });
      layout = buildLayout(result, scale);
    } catch (err) {
      console.error(err);
      layout = { glyphs: [], words: [], lines: [], medianH: 16 };
    }
    entry.layout = layout;
    if (image.bitmap !== bitmap) return; // 그사이 다른 이미지나 쪽을 열었다
    image.layout = layout;
    image.busy = false;
    refreshHint();
    renderImage();
    updateButtons();
  }

  // ---------------------------------------------------------------- PDF
  // PDF 도구(pdf.js)는 PDF를 열 때만 내려받는다. 한국어 글꼴 표(cmaps)도 같은 곳에서 받는다.
  const PDFJS_CDNS = [
    'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/',
    'https://unpkg.com/pdfjs-dist@4.10.38/',
  ];
  let pdfjs = null;
  let pdfjsBase = '';

  async function ensurePdfjs() {
    if (pdfjs) return pdfjs;
    let lastError = null;
    for (const base of PDFJS_CDNS) {
      try {
        const lib = await import(`${base}build/pdf.min.mjs`);
        lib.GlobalWorkerOptions.workerSrc = `${base}build/pdf.worker.min.mjs`;
        pdfjs = lib;
        pdfjsBase = base;
        return lib;
      } catch (err) { lastError = err; }
    }
    throw lastError || new Error('pdf.js');
  }

  const isPdf = (file) => !!file && (file.type === 'application/pdf' || /\.pdf$/i.test(file.name || ''));

  async function openPdfDoc(file) {
    const lib = await ensurePdfjs();
    const data = new Uint8Array(await file.arrayBuffer());
    return lib.getDocument({
      data,
      cMapUrl: `${pdfjsBase}cmaps/`,
      cMapPacked: true,
      standardFontDataUrl: `${pdfjsBase}standard_fonts/`,
      isEvalSupported: false,
    }).promise;
  }

  function pdfErrorMessage(err) {
    const name = err && err.name;
    if (name === 'PasswordException') return '암호가 걸린 PDF는 열 수 없어요';
    if (!pdfjs) return 'PDF 도구를 불러오지 못했어요. 인터넷 연결을 확인해 주세요';
    return '이 PDF는 열 수 없어요. 파일이 깨졌을 수 있어요';
  }

  // 한 쪽을 가로 약 1800px로 그린다. 아주 큰 쪽은 픽셀 수(약 700만)에 맞춰 줄인다.
  async function renderPdfPage(doc, number) {
    const pg = await doc.getPage(number);
    const base = pg.getViewport({ scale: 1 });
    let scale = 1800 / base.width;
    const maxPixels = 7e6;
    if (base.width * base.height * scale * scale > maxPixels) scale = Math.sqrt(maxPixels / (base.width * base.height));
    const viewport = pg.getViewport({ scale });
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.floor(viewport.width));
    c.height = Math.max(1, Math.floor(viewport.height));
    const cc = c.getContext('2d');
    cc.fillStyle = '#fff';
    cc.fillRect(0, 0, c.width, c.height);
    await pg.render({ canvasContext: cc, viewport }).promise;
    pg.cleanup();
    return c;
  }

  async function openPdf(file) {
    const ticket = ++pdfTicket;
    pdfView.loading = 'PDF 여는 중…';
    hint(pdfView.loading);
    let doc;
    try {
      doc = await openPdfDoc(file);
    } catch (err) {
      console.error(err);
      if (ticket !== pdfTicket) return;
      pdfView.loading = '';
      hint(pdfErrorMessage(err), 4000);
      return;
    }
    if (ticket !== pdfTicket) { doc.destroy(); return; } // 그사이 다른 파일을 열었다
    closePdf();
    pdfView.doc = doc;
    pdfView.count = doc.numPages;
    pdfView.pages = Array.from({ length: doc.numPages }, blankEntry);
    image.name = (file.name || 'pdf').replace(/\.[^.]+$/, '') || 'pdf';
    setMode('image');
    showPdfPage(0);
  }

  function closePdf() {
    pdfTicket++;
    if (pdfView.doc) pdfView.doc.destroy();
    Object.assign(pdfView, { doc: null, count: 0, index: -1, want: -1, pages: [], loading: '' });
    updatePager();
  }

  async function showPdfPage(i, dir = 0) {
    const P = pdfView;
    const doc = P.doc;
    if (!doc || i < 0 || i >= P.count) return;
    P.want = i;
    updatePager(dir);
    const entry = P.pages[i];
    if (!entry.canvas) {
      P.loading = P.count > 1 ? `${i + 1}쪽 그리는 중…` : 'PDF 그리는 중…';
      refreshHint();
      let pic;
      try {
        pic = await renderPdfPage(doc, i + 1);
      } catch (err) {
        console.error(err);
        if (P.doc !== doc || P.want !== i) return;
        P.loading = '';
        P.want = P.index;
        updatePager();
        hint('이 쪽을 그리지 못했어요', 3000);
        return;
      }
      if (P.doc !== doc) return;
      entry.canvas = pic;
      trimPdfCache(i);
      if (P.want !== i) return; // 그사이 다른 쪽으로 넘겼다
      P.loading = '';
    }
    // 떠나는 쪽의 칠한 곳과 되돌리기를 그 쪽에 맡겨 둔다.
    if (P.index >= 0 && P.index !== i) {
      P.pages[P.index].marks = modes.image.marks;
      P.pages[P.index].history = modes.image.history;
    }
    P.index = i;
    showBitmap(entry.canvas, entry);
  }

  // 그린 쪽 그림은 지금 쪽에서 가까운 5쪽만 남긴다(글자 자리와 칠한 곳은 모두 남는다).
  function trimPdfCache(center) {
    const kept = pdfView.pages.map((p, i) => (p.canvas ? i : -1)).filter((i) => i >= 0);
    kept.sort((x, y) => Math.abs(y - center) - Math.abs(x - center));
    while (kept.length > 5) {
      const far = kept.shift();
      if (far !== pdfView.index) pdfView.pages[far].canvas = null;
    }
  }

  function turnPage(step) {
    const at = pdfView.want >= 0 ? pdfView.want : pdfView.index;
    const next = at + step;
    if (next < 0 || next >= pdfView.count) return;
    showPdfPage(next, step);
  }

  function updatePager(dir = 0) {
    const P = pdfView;
    const on = P.count > 1;
    pager.hidden = !on;
    body.classList.toggle('has-pager', on);
    if (!on) return;
    const at = P.want >= 0 ? P.want : P.index;
    $('#prevPageBtn').disabled = at <= 0;
    $('#nextPageBtn').disabled = at >= P.count - 1;
    pagerNum.textContent = `${at + 1} / ${P.count}`;
    if (dir && pagerNum.animate && !reduceMotion.matches) {
      pagerNum.animate([{ opacity: 0, transform: `translateX(${dir * 8}px)` }, { opacity: 1, transform: 'none' }], { duration: 200, easing: 'ease-out' });
    }
  }

  canvas.addEventListener('pointerdown', (e) => {
    if (!image.layout || (e.pointerType === 'mouse' && e.button !== 0)) return;
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, start: hitGlyph(imagePoint(e)), moved: false, target: 'image' };
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!drag || drag.target !== 'image' || e.pointerId !== drag.id) return;
    if (!drag.moved && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 6) return;
    drag.moved = true;
    modes.image.pending = null;
    const g = hitGlyph(imagePoint(e));
    if (drag.start < 0) drag.start = g;
    if (drag.start >= 0 && g >= 0) {
      const [a, b] = imageExpand(drag.start, g);
      modes.image.preview = newMark(a, b);
      modes.image.preview.seed = 7;
    }
    renderImage();
  });

  function endImageDrag(e, cancelled) {
    if (!drag || drag.target !== 'image' || e.pointerId !== drag.id) return;
    const st = modes.image;
    const d = drag;
    drag = null;
    if (cancelled) { st.preview = null; renderImage(); return; }
    if (d.moved) {
      if (st.preview) commit(st.preview.a, st.preview.b);
      else renderImage();
      refreshHint();
      return;
    }
    tapAt(d.start, imageExpand);
  }
  canvas.addEventListener('pointerup', (e) => endImageDrag(e, false));
  canvas.addEventListener('pointercancel', (e) => endImageDrag(e, true));

  // 시작 글자 → 끝 글자를 한 번씩 누르는 방식(모바일에서 편하다)
  function tapAt(index, expand) {
    const st = modes[mode];
    if (index < 0) { st.pending = null; refreshHint(); redraw(); return; }
    if (st.pending === null) {
      st.pending = index;
      pendingHint();
      redraw();
      return;
    }
    const [a, b] = expand(st.pending, index);
    st.pending = null;
    commit(a, b);
    refreshHint();
  }

  // ---------------------------------------------------------------- 글로 다시 쓰기

  function escapeHtml(s) {
    return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  function typeset(raw) {
    const clean = raw.replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    const paragraphs = clean.split(/\n{2,}/);
    pageText.innerHTML = paragraphs.map((p) => `<p>${p.split('\n').map(escapeHtml).join('<br>')}</p>`).join('');
    text.raw = raw;
    text.typeset = true;
    text.index = buildTextIndex();
    modes.text.marks = [];
    modes.text.history = [];
    modes.text.pending = null;
    $('#compose').hidden = true;
    $('#pageWrap').hidden = false;
    requestAnimationFrame(renderPage);
    refreshHint();
    updateButtons();
  }

  // 화면의 글을 한 줄 문자열로 펼친 색인. <br>과 문단 끝은 '\n'으로 센다.
  function buildTextIndex() {
    const nodes = [];
    let flat = '';
    for (const p of pageText.children) {
      for (const child of p.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) {
          nodes.push({ node: child, start: flat.length, end: flat.length + child.nodeValue.length });
          flat += child.nodeValue;
        } else if (child.nodeName === 'BR') {
          flat += '\n';
        }
      }
      flat += '\n';
    }
    return { nodes, flat };
  }

  function domPos(i) {
    const nodes = text.index.nodes;
    for (const n of nodes) if (i >= n.start && i <= n.end) return { node: n.node, offset: i - n.start };
    for (const n of nodes) if (n.start >= i) return { node: n.node, offset: 0 };
    const last = nodes[nodes.length - 1];
    return { node: last.node, offset: last.node.nodeValue.length };
  }

  function flatIndex(node, offset) {
    const nodes = text.index.nodes;
    if (node.nodeType === Node.TEXT_NODE) {
      const n = nodes.find((x) => x.node === node);
      return n ? n.start + offset : -1;
    }
    // 요소 경계: 그 뒤의 첫 글자 노드 위치
    const child = node.childNodes[offset];
    const probe = child || node;
    for (const n of nodes) {
      const rel = probe.compareDocumentPosition(n.node);
      if (probe === n.node || (child ? (rel & Node.DOCUMENT_POSITION_FOLLOWING) || (rel & Node.DOCUMENT_POSITION_CONTAINED_BY) : (rel & Node.DOCUMENT_POSITION_FOLLOWING))) return n.start;
    }
    return text.index.flat.length;
  }

  function rangeOf(a, b) { // [a, b] 포함
    const s = domPos(a);
    const e = domPos(b + 1);
    const r = document.createRange();
    r.setStart(s.node, s.offset);
    r.setEnd(e.node, e.offset);
    return r;
  }

  const isSpace = (ch) => ch === undefined || /\s/.test(ch);
  const isTerminal = (ch) => /[.!?…。？！]/.test(ch || '');

  function textExpand(a, b) {
    const flat = text.index.flat;
    if (a > b) [a, b] = [b, a];
    const last = flat.length - 1;
    if (settings.unit === 'word') {
      while (a > 0 && !isSpace(flat[a - 1])) a--;
      while (b < last && !isSpace(flat[b + 1])) b++;
    } else if (settings.unit === 'line') {
      while (a > 0 && flat[a - 1] !== '\n' && !(isSpace(flat[a - 1]) && isTerminal(flat[a - 2]))) a--;
      while (b < last && flat[b + 1] !== '\n' && !(isTerminal(flat[b]) && isSpace(flat[b + 1]))) b++;
      while (b < last && /["'”’」』)]/.test(flat[b + 1])) b++;
    }
    while (a < b && isSpace(flat[a])) a++;
    while (b > a && isSpace(flat[b])) b--;
    return [a, b];
  }

  function textSegments(a, b, thickness) {
    const origin = page.getBoundingClientRect();
    const rects = Array.from(rangeOf(a, b).getClientRects()).filter((r) => r.width > 0.5 && r.height > 0.5);
    const lines = [];
    for (const r of rects) {
      const same = lines.find((l) => Math.abs(l.top - r.top) < 3);
      if (same) { same.left = Math.min(same.left, r.left); same.right = Math.max(same.right, r.right); same.bottom = Math.max(same.bottom, r.bottom); }
      else lines.push({ left: r.left, right: r.right, top: r.top, bottom: r.bottom });
    }
    return lines.map((l) => {
      const top = l.top - origin.top;
      const h = l.bottom - l.top;
      const bottom = top + h;
      let y0, y1;
      if (thickness === 0) { y0 = bottom - h * 0.46; y1 = bottom - h * 0.04; }
      else if (thickness === 2) { y0 = top - h * 0.06; y1 = bottom + h * 0.04; }
      else { y0 = top + h * 0.08; y1 = bottom - h * 0.04; }
      return { x0: l.left - origin.left - 1.5, x1: l.right - origin.left + 1.5, y0, y1 };
    });
  }

  function renderPage() {
    if (!text.typeset) return;
    const rect = page.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    pageCanvas.width = Math.max(1, Math.round(rect.width * dpr));
    pageCanvas.height = Math.max(1, Math.round(rect.height * dpr));
    const pc = pageCanvas.getContext('2d');
    pc.setTransform(dpr, 0, 0, dpr, 0, 0);
    pc.clearRect(0, 0, rect.width, rect.height);
    const st = modes.text;
    const normal = () => 'source-over';
    for (const m of st.marks) paintMark(pc, m, textSegments(m.a, m.b, m.thickness), normal, dpr);
    if (st.preview) {
      const segs = textSegments(st.preview.a, st.preview.b, st.preview.thickness);
      if (settings.eraser) outlineSegments(pc, segs, 1.5);
      else paintMark(pc, st.preview, segs, normal, dpr);
    }
    if (st.pending !== null) {
      const segs = textSegments(st.pending, st.pending, 1);
      if (segs[0]) {
        pc.fillStyle = page.dataset.theme === 'night' ? '#E9E9EA' : '#2B2622';
        pc.fillRect(segs[0].x0 - 1, segs[0].y0 - 3, 2, segs[0].y1 - segs[0].y0 + 6);
      }
    }
  }

  function charAtPoint(x, y) {
    let node = null, offset = 0;
    if (document.caretPositionFromPoint) {
      const p = document.caretPositionFromPoint(x, y);
      if (p) { node = p.offsetNode; offset = p.offset; }
    } else if (document.caretRangeFromPoint) {
      const r = document.caretRangeFromPoint(x, y);
      if (r) { node = r.startContainer; offset = r.startOffset; }
    }
    if (!node || !pageText.contains(node)) return -1;
    let i = flatIndex(node, offset);
    if (i < 0) return -1;
    // 캐럿은 글자 사이를 가리키므로, 눌린 자리에 실제로 있는 글자를 고른다.
    const flat = text.index.flat;
    for (const c of [i, i - 1]) {
      if (c < 0 || c >= flat.length || isSpace(flat[c])) continue;
      const rr = rangeOf(c, c).getClientRects()[0];
      if (rr && x >= rr.left - 2 && x <= rr.right + 2 && y >= rr.top - 4 && y <= rr.bottom + 4) return c;
    }
    if (i >= flat.length || isSpace(flat[i])) i = Math.max(0, i - 1);
    return isSpace(flat[i]) ? -1 : i;
  }

  function selectionToRange() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
    const r = sel.getRangeAt(0);
    if (!pageText.contains(r.commonAncestorContainer)) return null;
    const a = flatIndex(r.startContainer, r.startOffset);
    const b = flatIndex(r.endContainer, r.endOffset) - 1;
    if (a < 0 || b < a) return null;
    return [a, b];
  }

  pageText.addEventListener('pointerdown', (e) => {
    if (!text.typeset) return;
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, target: 'text' };
  });

  pageText.addEventListener('pointerup', (e) => {
    if (!drag || drag.target !== 'text') return;
    const d = drag;
    const x = e.clientX;
    const y = e.clientY;
    drag = null;
    // 빠르게 드래그하면 선택 영역이 손을 뗀 뒤에 갱신될 수 있어 한 박자 늦게 읽는다.
    setTimeout(() => {
      const picked = selectionToRange();
      if (picked) {
        const [a, b] = textExpand(picked[0], picked[1]);
        window.getSelection().removeAllRanges();
        modes.text.pending = null;
        if (b >= a) commit(a, b);
        refreshHint();
        return;
      }
      if (Math.hypot(x - d.x, y - d.y) < 6) tapAt(charAtPoint(x, y), textExpand);
    }, 0);
  });

  pageText.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const picked = selectionToRange();
    if (!picked) return;
    e.preventDefault();
    const [a, b] = textExpand(picked[0], picked[1]);
    window.getSelection().removeAllRanges();
    if (b >= a) commit(a, b);
  });

  async function exportPageCanvas() {
    if (document.fonts && document.fonts.ready) await document.fonts.ready;
    const rect = page.getBoundingClientRect();
    const scale = 2;
    const out = document.createElement('canvas');
    out.width = Math.round(rect.width * scale);
    out.height = Math.round(rect.height * scale);
    const oc = out.getContext('2d');
    oc.scale(scale, scale);
    const pageStyle = getComputedStyle(page);
    oc.fillStyle = pageStyle.backgroundColor;
    oc.fillRect(0, 0, rect.width, rect.height);
    const normal = () => 'source-over';
    for (const m of modes.text.marks) paintMark(oc, m, textSegments(m.a, m.b, m.thickness), normal, scale);
    const ts = getComputedStyle(pageText);
    oc.fillStyle = pageStyle.color;
    oc.font = `${ts.fontWeight} ${ts.fontSize} ${ts.fontFamily}`;
    oc.textBaseline = 'alphabetic';
    const m = oc.measureText('가Hg');
    const asc = m.fontBoundingBoxAscent || parseFloat(ts.fontSize) * 0.88;
    const desc = m.fontBoundingBoxDescent || parseFloat(ts.fontSize) * 0.24;
    const r = document.createRange();
    for (const n of text.index.nodes) {
      const value = n.node.nodeValue;
      let i = 0;
      for (const ch of value) {
        const len = ch.length;
        if (!/\s/.test(ch)) {
          r.setStart(n.node, i);
          r.setEnd(n.node, i + len);
          const rr = r.getClientRects()[0];
          if (rr) oc.fillText(ch, rr.left - rect.left, rr.top - rect.top + (rr.height - (asc + desc)) / 2 + asc);
        }
        i += len;
      }
    }
    return out;
  }

  // 이미지에서 글 가져오기(선택 기능): 글자 인식 엔진은 누를 때만 내려받는다.
  let ocrWorker = null;
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src; s.async = true;
      s.onload = resolve;
      s.onerror = () => reject(new Error(src));
      document.head.appendChild(s);
    });
  }

  let ocrProgress = () => {};
  async function ensureOcr(onProgress) {
    ocrProgress = onProgress; // 엔진은 한 번만 만들어지므로 진행 표시는 부를 때마다 바꿔 끼운다
    if (ocrWorker) return ocrWorker;
    const cdns = [
      { lib: 'https://cdn.jsdelivr.net/npm/tesseract.js@6.0.1/dist/tesseract.min.js', worker: 'https://cdn.jsdelivr.net/npm/tesseract.js@6.0.1/dist/worker.min.js', core: 'https://cdn.jsdelivr.net/npm/tesseract.js-core@6.0.0' },
      { lib: 'https://unpkg.com/tesseract.js@6.0.1/dist/tesseract.min.js', worker: 'https://unpkg.com/tesseract.js@6.0.1/dist/worker.min.js', core: 'https://unpkg.com/tesseract.js-core@6.0.0' },
    ];
    let lastError = null;
    for (const cdn of cdns) {
      try {
        if (!window.Tesseract) await loadScript(cdn.lib);
        ocrWorker = await window.Tesseract.createWorker(['kor', 'eng'], 1, {
          workerPath: cdn.worker,
          corePath: cdn.core,
          logger: (msg) => { if (msg && typeof msg.progress === 'number') ocrProgress(msg); },
        });
        return ocrWorker;
      } catch (err) { lastError = err; }
    }
    throw lastError || new Error('OCR');
  }

  // PDF 한 쪽의 글 조각을 y 위치로 줄로 묶는다. 줄 사이가 크게 벌어지면 빈 줄(문단)로 나눈다.
  function pdfPageText(content) {
    const lines = [];
    let cur = null;
    for (const it of content.items) {
      if (typeof it.str !== 'string') continue;
      if (!it.str) { if (it.hasEOL && cur) cur.eol = true; continue; }
      const x = it.transform[4];
      const y = it.transform[5];
      const h = Math.abs(it.transform[3]) || it.height || 10;
      const same = cur && !cur.eol && Math.abs(y - cur.y) < Math.max(cur.h, h) * 0.5;
      if (!same) {
        cur = { y, h, text: '', end: x, eol: false };
        lines.push(cur);
      } else if (x - cur.end > h * 0.2 && !/\s$/.test(cur.text) && !/^\s/.test(it.str)) {
        cur.text += ' ';
      }
      cur.text += it.str;
      cur.end = x + (it.width || 0);
      cur.h = Math.max(cur.h, h);
      if (it.hasEOL) cur.eol = true;
    }
    const gaps = [];
    for (let i = 1; i < lines.length; i++) { const d = lines[i - 1].y - lines[i].y; if (d > 0) gaps.push(d); }
    gaps.sort((a, b) => a - b);
    const pitch = gaps.length ? gaps[gaps.length >> 1] : 0;
    let out = '';
    lines.forEach((l, i) => {
      if (i) out += pitch && lines[i - 1].y - l.y > pitch * 1.6 ? '\n\n' : '\n';
      out += l.text.replace(/\s+$/, '');
    });
    return out.replace(/\n{3,}/g, '\n\n').trim();
  }

  const cleanOcr = (s) => (s || '').replace(/[ \t]+\n/g, '\n').trim();

  // PDF는 안에 든 글을 그대로 꺼낸다. 글이 없는 쪽(스캔본)만 그림으로 그려 글자를 읽는다.
  async function importTextFromPdf(file) {
    const status = $('#ocrStatus');
    const ocrBtn = $('#ocrBtn');
    ocrBtn.disabled = true;
    status.textContent = 'PDF 여는 중…';
    let doc = null;
    let step = 'open';
    try {
      doc = await openPdfDoc(file);
      const total = doc.numPages;
      const parts = [];
      let usedOcr = false;
      for (let n = 1; n <= total; n++) {
        const where = total > 1 ? ` ${n}/${total}쪽` : '';
        step = 'text';
        status.textContent = `글 꺼내는 중…${where}`;
        const pg = await doc.getPage(n);
        let got = pdfPageText(await pg.getTextContent());
        if (!got.replace(/\s/g, '')) {
          usedOcr = true;
          const pic = await renderPdfPage(doc, n);
          step = 'ocr';
          status.textContent = '글자 인식 엔진을 불러오는 중… 처음 한 번은 조금 걸려요';
          const worker = await ensureOcr((msg) => {
            const pct = Math.round(msg.progress * 100);
            status.textContent = msg.status === 'recognizing text' ? `글자 읽는 중…${where} ${pct}%` : `준비 중… ${pct}%`;
          });
          const { data } = await worker.recognize(pic);
          got = cleanOcr(data.text);
        }
        if (got) parts.push(got);
      }
      const all = parts.join('\n\n');
      if (!all) { status.textContent = '읽은 글자가 없어요. 직접 붙여 넣어 주세요'; return; }
      textInput.value = textInput.value.trim() ? `${textInput.value.trim()}\n\n${all}` : all;
      status.textContent = usedOcr ? '가져왔어요. 틀린 글자를 고친 뒤 종이에 옮겨요' : '가져왔어요. 살펴본 뒤 종이에 옮겨요';
      textInput.focus();
    } catch (err) {
      console.error(err);
      if (step === 'open') status.textContent = pdfErrorMessage(err);
      else if (step === 'ocr') status.textContent = '글자 인식 엔진을 불러오지 못했어요. 인터넷 연결을 확인해 주세요';
      else status.textContent = '이 PDF에서 글을 가져오지 못했어요';
    } finally {
      if (doc) doc.destroy();
      ocrBtn.disabled = false;
    }
  }

  async function importTextFromImage(file) {
    if (isPdf(file)) return importTextFromPdf(file);
    const status = $('#ocrStatus');
    const ocrBtn = $('#ocrBtn');
    ocrBtn.disabled = true;
    status.textContent = '글자 인식 엔진을 불러오는 중… 처음 한 번은 조금 걸려요';
    try {
      const worker = await ensureOcr((msg) => {
        const pct = Math.round(msg.progress * 100);
        status.textContent = msg.status === 'recognizing text' ? `글자 읽는 중… ${pct}%` : `준비 중… ${pct}%`;
      });
      const { data } = await worker.recognize(file);
      const got = (data.text || '').replace(/[ \t]+\n/g, '\n').trim();
      if (!got) { status.textContent = '읽은 글자가 없어요. 직접 붙여 넣어 주세요'; return; }
      textInput.value = textInput.value.trim() ? `${textInput.value.trim()}\n\n${got}` : got;
      status.textContent = '가져왔어요. 틀린 글자를 고친 뒤 종이에 옮겨요';
      textInput.focus();
    } catch (err) {
      console.error(err);
      status.textContent = '글자 인식 엔진을 불러오지 못했어요. 인터넷 연결을 확인해 주세요';
    } finally {
      ocrBtn.disabled = false;
    }
  }

  // ---------------------------------------------------------------- 저장·복사

  async function currentCanvas() {
    if (mode === 'image') {
      const keep = showOriginal;
      showOriginal = false;
      const st = modes.image;
      const saved = { preview: st.preview, pending: st.pending };
      st.preview = null; st.pending = null;
      renderImage();
      const snapshot = document.createElement('canvas');
      snapshot.width = canvas.width; snapshot.height = canvas.height;
      snapshot.getContext('2d').drawImage(canvas, 0, 0);
      Object.assign(st, saved);
      showOriginal = keep;
      renderImage();
      return snapshot;
    }
    return exportPageCanvas();
  }

  const toBlob = (c) => new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error('blob'))), 'image/png'));

  async function save() {
    const blob = await toBlob(await currentCanvas());
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    const pageNo = mode === 'image' && pdfView.count > 1 ? `-${pdfView.index + 1}쪽` : '';
    a.download = `형광펜-${mode === 'image' ? image.name + pageNo : '글'}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    hint('PNG로 저장했어요', 2200);
    setTimeout(refreshHint, 2300);
  }

  async function copy() {
    try {
      const blob = currentCanvas().then(toBlob);
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      hint('클립보드에 복사했어요', 2200);
    } catch (err) {
      console.error(err);
      hint('이 브라우저에서는 복사가 막혀 있어요. PNG 저장을 써 주세요', 3500);
    }
    setTimeout(refreshHint, 3600);
  }

  // ---------------------------------------------------------------- 화면 상태

  function redraw() {
    if (mode === 'image') renderImage(); else renderPage();
  }

  function hasContent() {
    return mode === 'image' ? !!image.bitmap : text.typeset;
  }

  function updateButtons() {
    const ready = hasContent();
    $('#saveBtn').disabled = !ready;
    $('#copyBtn').disabled = !ready || !window.ClipboardItem;
    $('#originalBtn').disabled = !(mode === 'image' && image.bitmap);
    $('#undoBtn').disabled = !modes[mode].history.length;
  }

  function setMode(next) {
    if (next === mode) return;
    modes[mode].pending = null;
    modes[mode].preview = null;
    mode = next;
    body.dataset.mode = next;
    $$('.mode-switch button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === next)));
    $('#imageView').hidden = next !== 'image';
    $('#textView').hidden = next !== 'text';
    $('#tagline').textContent = next === 'image' ? '이미지 글자에 칠하기' : '글을 종이에 옮겨 적고 칠하기';
    if (next === 'text' && !text.typeset) setTimeout(() => textInput.focus(), 0);
    setOriginal(false);
    refreshHint();
    updateButtons();
    redraw();
  }

  function setOriginal(on) {
    showOriginal = on;
    $('#originalBtn').setAttribute('aria-pressed', String(on));
    $('#originalBtn').textContent = on ? '칠한 모습 보기' : '원본 보기';
    if (mode === 'image') renderImage();
  }

  function setEraser(on) {
    settings.eraser = on;
    body.classList.toggle('is-eraser', on);
    $('#eraserBtn').setAttribute('aria-pressed', String(on));
    modes[mode].pending = null;
    refreshHint();
    redraw();
  }

  function pickPen(button) {
    if (!button || button.hidden) return;
    $$('.pen').forEach((p) => p.setAttribute('aria-pressed', String(p === button)));
    settings.color = button.dataset.color;
    if (settings.eraser) setEraser(false);
  }

  function pressGroup(selector, attr, value) {
    $$(selector).forEach((b) => b.setAttribute('aria-pressed', String(b.dataset[attr] === value)));
  }

  // ---------------------------------------------------------------- 연결

  $$('.pen').forEach((p) => { if (p.dataset.color) p.style.setProperty('--pen', p.dataset.color); });
  $('#pens').addEventListener('click', (e) => {
    const pen = e.target.closest('.pen');
    if (pen) pickPen(pen);
  });
  $('#makeColorBtn').addEventListener('click', () => $('#colorInput').click());
  $('#colorInput').addEventListener('input', (e) => {
    const pen = $('#customPen');
    pen.dataset.color = e.target.value;
    pen.style.setProperty('--pen', e.target.value);
    pen.hidden = false;
    pickPen(pen);
  });

  $$('.mode-switch button').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));

  $$('[data-unit]').forEach((b) => b.addEventListener('click', () => {
    settings.unit = b.dataset.unit;
    pressGroup('[data-unit]', 'unit', settings.unit);
    modes[mode].pending = null;
    refreshHint();
    redraw();
  }));
  $$('[data-shape]').forEach((b) => b.addEventListener('click', () => {
    settings.shape = b.dataset.shape;
    pressGroup('[data-shape]', 'shape', settings.shape);
  }));
  $$('[data-theme]').forEach((b) => b.addEventListener('click', () => {
    page.dataset.theme = b.dataset.theme;
    pressGroup('[data-theme]', 'theme', b.dataset.theme);
    requestAnimationFrame(renderPage);
  }));
  $$('[data-font]').forEach((b) => b.addEventListener('click', () => {
    page.dataset.font = b.dataset.font;
    pressGroup('[data-font]', 'font', b.dataset.font);
    requestAnimationFrame(renderPage);
  }));
  $$('[data-size]').forEach((b) => b.addEventListener('click', () => {
    page.dataset.size = b.dataset.size;
    pressGroup('[data-size]', 'size', b.dataset.size);
    requestAnimationFrame(renderPage);
  }));

  $('#thickness').addEventListener('input', (e) => {
    settings.thickness = Number(e.target.value);
    $('#thicknessLabel').textContent = THICKNESS_LABELS[settings.thickness];
  });
  $('#alpha').addEventListener('input', (e) => {
    settings.alpha = Number(e.target.value) / 100;
    $('#alphaLabel').textContent = `${e.target.value}%`;
  });

  $('#eraserBtn').addEventListener('click', () => setEraser(!settings.eraser));
  $('#undoBtn').addEventListener('click', undo);
  $('#originalBtn').addEventListener('click', () => setOriginal(!showOriginal));
  $('#saveBtn').addEventListener('click', () => { save().catch((err) => { console.error(err); hint('저장하지 못했어요', 3000); }); });
  $('#copyBtn').addEventListener('click', copy);
  $('#infoBtn').addEventListener('click', () => $('#infoDialog').showModal());

  $('#pickBtn').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => { loadImageFile(fileInput.files[0]); fileInput.value = ''; });

  $('#typesetBtn').addEventListener('click', () => {
    const raw = textInput.value;
    if (!raw.trim()) { $('#ocrStatus').textContent = '먼저 글을 붙여 넣어 주세요'; textInput.focus(); return; }
    typeset(raw);
  });
  $('#editTextBtn').addEventListener('click', () => {
    if (modes.text.marks.length && !window.confirm('글을 고치면 칠한 곳이 지워져요. 계속할까요?')) return;
    textInput.value = text.raw;
    text.typeset = false;
    $('#pageWrap').hidden = true;
    $('#compose').hidden = false;
    textInput.focus();
    refreshHint();
    updateButtons();
  });
  $('#ocrBtn').addEventListener('click', () => $('#ocrFile').click());
  $('#ocrFile').addEventListener('change', (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (f) importTextFromImage(f);
  });

  $('#prevPageBtn').addEventListener('click', () => turnPage(-1));
  $('#nextPageBtn').addEventListener('click', () => turnPage(1));

  // 붙여넣기: 이미지(또는 PDF)면 이미지 모드로 연다.
  document.addEventListener('paste', (e) => {
    const items = Array.from((e.clipboardData && e.clipboardData.items) || []);
    const img = items.find((it) => it.kind === 'file' && (it.type.startsWith('image/') || it.type === 'application/pdf'));
    if (img) {
      e.preventDefault();
      if (mode === 'text' && !text.typeset) importTextFromImage(img.getAsFile());
      else loadImageFile(img.getAsFile());
    }
  });

  // 끌어다 놓기
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => { if (e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files')) { dragDepth++; dropzone.classList.add('is-over'); } });
  window.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) dropzone.classList.remove('is-over'); });
  window.addEventListener('dragover', (e) => { if (e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files')) e.preventDefault(); });
  window.addEventListener('drop', (e) => {
    const f = e.dataTransfer && e.dataTransfer.files[0];
    dragDepth = 0;
    dropzone.classList.remove('is-over');
    if (!f) return;
    e.preventDefault();
    if (mode === 'text' && !text.typeset) importTextFromImage(f);
    else loadImageFile(f);
  });

  // 단축키
  document.addEventListener('keydown', (e) => {
    const typing = e.target.closest && e.target.closest('textarea, input, [contenteditable="true"]');
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'z' && !typing) { e.preventDefault(); undo(); return; }
    if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
    if (/^[1-6]$/.test(e.key)) {
      const pens = $$('.pen').filter((p) => !p.hidden);
      pickPen(pens[Number(e.key) - 1]);
    } else if (e.key.toLowerCase() === 'e') {
      setEraser(!settings.eraser);
    } else if (e.key === ' ' && mode === 'image' && image.bitmap && !e.repeat) {
      e.preventDefault();
      setOriginal(true);
    } else if (mode === 'image' && pdfView.count > 1 && /^(ArrowLeft|ArrowRight|PageUp|PageDown)$/.test(e.key)) {
      e.preventDefault();
      turnPage(e.key === 'ArrowRight' || e.key === 'PageDown' ? 1 : -1);
    } else if (e.key === 'Escape') {
      modes[mode].pending = null;
      refreshHint();
      redraw();
    }
  });
  document.addEventListener('keyup', (e) => {
    if (e.key === ' ' && mode === 'image' && showOriginal) setOriginal(false);
  });

  new ResizeObserver(() => { if (mode === 'text') renderPage(); }).observe(page);
  // 좁은 화면에서는 필통이 아래에 붙어 있으므로, 쪽 넘기기 알약을 그 위에 띄운다.
  const tray = $('.tray');
  new ResizeObserver(() => body.style.setProperty('--tray-h', `${tray.offsetHeight}px`)).observe(tray);
  if (document.fonts) document.fonts.addEventListener('loadingdone', () => { if (mode === 'text') renderPage(); });

  updateButtons();
})();
