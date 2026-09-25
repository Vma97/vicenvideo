"use strict";

// CUADRA — junta clips cortos en un vídeo vertical de 1080 para Instagram.
// Todo pasa en el móvil: los clips se dibujan en un <canvas> en tiempo real
// y MediaRecorder graba ese canvas a MP4. Nada sale del teléfono.

// max = duración máxima en segundos (límites de Instagram): lo que pase se corta
const FORMATS = {
  story: { w: 1080, h: 1920, max: 60 },
  post: { w: 1080, h: 1350, max: 180 },
};
const DURS = [4, 8];
const TRANSITIONS = {
  cut: "Corte",
  fade: "Fundido",
  black: "Negro",
  slide: "Deslizar",
  zoom: "Zoom",
};
const FPS = 30;
const FRAME = 1 / FPS;
const TRANS_LEN = 0.5;          // segundos que dura cada transición
const BITRATE = 12_000_000;     // 12 Mbps: buena calidad en 1080 sin pesar demasiado
const MIN_SLOT = 0.5;

const state = { clips: [], format: "story", dur: 4, trans: "fade", tone: "soft" };
let nextId = 1;

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------- utilidades

function once(el, ev, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { cleanup(); reject(new Error("timeout " + ev)); }, timeout);
    const ok = () => { cleanup(); resolve(); };
    const ko = () => { cleanup(); reject(new Error("error cargando vídeo")); };
    function cleanup() { clearTimeout(t); el.removeEventListener(ev, ok); el.removeEventListener("error", ko); }
    el.addEventListener(ev, ok);
    el.addEventListener("error", ko);
  });
}

async function seek(v, t) {
  if (Math.abs(v.currentTime - t) < 0.001 && v.readyState >= 2 && !v.seeking) return;
  const p = once(v, "seeked");
  v.currentTime = t;
  await p;
}

// iOS no pinta frames de un <video> que nunca se ha reproducido: un play/pause
// muteado lo "despierta" para que drawImage y los seeks funcionen.
async function prime(v) {
  try { await v.play(); } catch (e) { /* sin gesto de usuario puede fallar, no pasa nada */ }
  v.pause();
}

function makeVideo() {
  const v = document.createElement("video");
  v.muted = true;
  v.defaultMuted = true;
  v.playsInline = true;
  v.setAttribute("playsinline", "");
  v.setAttribute("muted", "");
  v.preload = "auto";
  $("vpool").appendChild(v);
  return v;
}

function dropVideo(v) {
  v.pause();
  v.removeAttribute("src");
  v.load();
  v.remove();
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const ease = (p) => (p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2);

function fmtTime(s) {
  s = Math.max(0, Math.round(s));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
const fmtSec = (s) => s.toFixed(2).replace(".", ",") + " s";

// Con velocidad, un hueco de 4 s a 2× consume 8 s de vídeo original ("metraje")
function maxStart(clip) { return Math.max(0, clip.duration - state.dur * clip.speed); }
function slotLen(clip) { return Math.max(MIN_SLOT, Math.min(state.dur, (clip.duration - clip.start) / clip.speed)); }
function footage(clip) { return slotLen(clip) * clip.speed; }
const fmtSpeed = (x) => String(x).replace(".", ",") + "×";
function usable() { return state.clips.filter((c) => !c.loading && !c.error && c.duration > 0); }

// Monta la línea de tiempo hasta el máximo del formato: el último clip que
// entra se recorta para clavar el límite y los que sobran se quedan fuera.
function buildTimeline() {
  const max = FORMATS[state.format].max;
  const tl = [];
  let t = 0;
  for (const clip of usable()) {
    const len = Math.min(slotLen(clip), max - t);
    if (len < 0.3) break;
    tl.push({ clip, t0: t, len });
    t += len;
  }
  return tl;
}

function rawTotal() { return usable().reduce((s, c) => s + slotLen(c), 0); }

// Dibuja un frame del vídeo rellenando el lienzo (tipo "cover"), respetando
// el encuadre del clip: fx/fy van de -1 a 1 y mueven el recorte dentro del hueco
// que sobra; zoom amplía por encima del relleno mínimo.
function drawCover(ctx, v, W, H, clip, o = {}) {
  const vw = v.videoWidth, vh = v.videoHeight;
  if (!vw || !vh || v.readyState < 2) return;
  const s = Math.max(W / vw, H / vh) * clip.zoom * (o.scale || 1);
  const dw = vw * s, dh = vh * s;
  const x = (W - dw) / 2 + clip.fx * (dw - W) / 2 + (o.dx || 0);
  const y = (H - dh) / 2 + clip.fy * (dh - H) / 2;
  ctx.globalAlpha = o.alpha == null ? 1 : o.alpha;
  const g = o.raw ? null : gradeParams(clip);
  if (g && grader.render(v, x, y, dw, dh, W, H, g)) ctx.drawImage(grader.canvas, 0, 0, W, H);
  else ctx.drawImage(v, x, y, dw, dh);
  ctx.globalAlpha = 1;
}

// ---------------------------------------------------------------- igualar tono

// Cada clip se analiza (media de R, G, B y contraste en varios frames del trozo usado).
// El objetivo es la mediana de todos los clips del vídeo, y cada clip se corrige hacia ahí:
// color = (color - media_clip) * contraste + media_objetivo. Así los oscuros suben, los
// quemados bajan y los que tiran a azul o amarillo se acercan al tono común.
const TONES = { off: "No", soft: "Suave", full: "Fuerte" };
const TONE_STRENGTH = { off: 0, soft: 0.55, full: 1 };
let toneTarget = null;

const statsKey = (clip) => `${clip.start.toFixed(3)}|${state.dur}|${clip.speed}`;
const median = (arr) => { const a = [...arr].sort((p, q) => p - q); const m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };

async function computeStats(v, clip) {
  const c = document.createElement("canvas");
  c.width = c.height = 48;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  const len = footage(clip);
  let r = 0, g = 0, b = 0, y = 0, y2 = 0, n = 0;
  for (let k = 0; k < 5; k++) {
    await seek(v, Math.min(clip.duration - 0.05, clip.start + len * (k + 0.5) / 5));
    ctx.drawImage(v, 0, 0, 48, 48);
    const d = ctx.getImageData(0, 0, 48, 48).data;
    for (let i = 0; i < d.length; i += 4) {
      const R = d[i] / 255, G = d[i + 1] / 255, B = d[i + 2] / 255;
      const L = 0.2126 * R + 0.7152 * G + 0.0722 * B;
      r += R; g += G; b += B; y += L; y2 += L * L; n++;
    }
  }
  const my = y / n;
  clip.stats = { key: statsKey(clip), mean: [r / n, g / n, b / n], std: Math.sqrt(Math.max(0, y2 / n - my * my)) };
}

function computeToneTarget(tl) {
  const st = tl.map((e) => e.clip.stats).filter(Boolean);
  if (st.length < 2) return null;
  return {
    mean: [0, 1, 2].map((ch) => median(st.map((s) => s.mean[ch]))),
    std: median(st.map((s) => s.std)),
  };
}

function gradeParams(clip) {
  const strength = TONE_STRENGTH[state.tone];
  if (!strength || !toneTarget || !clip.stats) return null;
  const s = clip.stats;
  return {
    m: s.mean,
    // Límites para no destrozar clips muy distintos (un atardecer no debe volverse gris)
    t: s.mean.map((m, ch) => m + clamp(toneTarget.mean[ch] - m, -0.18, 0.18)),
    k: clamp(toneTarget.std / Math.max(s.std, 0.02), 0.8, 1.3),
    s: strength,
  };
}

// Recalcula lo que haya cambiado (trozo elegido o duración) antes de reproducir/exportar
async function ensureStats(onProgress) {
  const todo = usable().filter((c) => !c.stats || c.stats.key !== statsKey(c));
  if (!todo.length) return;
  const v = makeVideo();
  try {
    for (let i = 0; i < todo.length; i++) {
      onProgress && onProgress(i, todo.length);
      const clip = todo[i];
      v.src = clip.url;
      try {
        await once(v, "loadedmetadata");
        await prime(v);
        await computeStats(v, clip);
      } catch (e) { clip.stats = null; }
    }
  } finally {
    dropVideo(v);
  }
}

// Aplica la corrección con la GPU (WebGL): el vídeo se pinta en un canvas del tamaño
// de salida con el shader de color, y ese canvas se copia al lienzo principal.
const grader = {
  canvas: null, gl: null, ok: null,
  init() {
    this.canvas = document.createElement("canvas");
    const gl = this.canvas.getContext("webgl", { preserveDrawingBuffer: true, premultipliedAlpha: true, antialias: false });
    if (!gl) return (this.ok = false);
    const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return s; };
    const p = gl.createProgram();
    gl.attachShader(p, sh(gl.VERTEX_SHADER,
      "attribute vec2 pos; attribute vec2 tc; varying vec2 uv; void main(){ uv = tc; gl_Position = vec4(pos, 0.0, 1.0); }"));
    gl.attachShader(p, sh(gl.FRAGMENT_SHADER,
      "precision mediump float; varying vec2 uv; uniform sampler2D tex; uniform vec3 m; uniform vec3 t; uniform float k; uniform float s;" +
      "void main(){ vec3 c = texture2D(tex, uv).rgb; vec3 o = clamp((c - m) * k + t, 0.0, 1.0); gl_FragColor = vec4(mix(c, o, s), 1.0); }"));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) return (this.ok = false);
    gl.useProgram(p);
    this.buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    const aPos = gl.getAttribLocation(p, "pos"), aTc = gl.getAttribLocation(p, "tc");
    gl.enableVertexAttribArray(aPos);
    gl.enableVertexAttribArray(aTc);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 16, 0);
    gl.vertexAttribPointer(aTc, 2, gl.FLOAT, false, 16, 8);
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    this.u = { m: gl.getUniformLocation(p, "m"), t: gl.getUniformLocation(p, "t"), k: gl.getUniformLocation(p, "k"), s: gl.getUniformLocation(p, "s") };
    this.gl = gl;
    return (this.ok = true);
  },
  render(v, x, y, dw, dh, W, H, g) {
    if (this.ok === null) this.init();
    if (!this.ok) return false;
    const gl = this.gl;
    if (this.canvas.width !== W || this.canvas.height !== H) { this.canvas.width = W; this.canvas.height = H; }
    gl.viewport(0, 0, W, H);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    try { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, v); } catch (e) { return false; }
    const X0 = x / W * 2 - 1, X1 = (x + dw) / W * 2 - 1, Y0 = 1 - y / H * 2, Y1 = 1 - (y + dh) / H * 2;
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([X0, Y0, 0, 0, X1, Y0, 1, 0, X0, Y1, 0, 1, X1, Y1, 1, 1]), gl.STREAM_DRAW);
    gl.uniform3fv(this.u.m, g.m);
    gl.uniform3fv(this.u.t, g.t);
    gl.uniform1f(this.u.k, g.k);
    gl.uniform1f(this.u.s, g.s);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    return true;
  },
};

// Ajusta el tamaño CSS del canvas para que quepa en su contenedor manteniendo proporción.
function fitCanvas(canvas, stage) {
  const r = stage.getBoundingClientRect();
  const aw = r.width - 32, ah = r.height - 8;
  const k = Math.min(aw / canvas.width, ah / canvas.height);
  canvas.style.width = Math.floor(canvas.width * k) + "px";
  canvas.style.height = Math.floor(canvas.height * k) + "px";
}

// ---------------------------------------------------------------- preferencias

function loadPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem("cuadra-prefs") || "{}");
    if (FORMATS[p.format]) state.format = p.format;
    if (DURS.includes(p.dur)) state.dur = p.dur;
    if (TRANSITIONS[p.trans]) state.trans = p.trans;
    if (p.tone in TONE_STRENGTH) state.tone = p.tone;
  } catch (e) { /* sin almacenamiento, valores por defecto */ }
}
function savePrefs() {
  try {
    localStorage.setItem("cuadra-prefs", JSON.stringify({ format: state.format, dur: state.dur, trans: state.trans, tone: state.tone }));
  } catch (e) { /* nada */ }
}

// ---------------------------------------------------------------- añadir clips

async function addFiles(fileList) {
  const files = [...fileList].filter((f) => (f.type || "").startsWith("video/") || /\.(mov|mp4|m4v|webm|3gp)$/i.test(f.name));
  if (!files.length) return;
  const added = files.map((f) => ({
    id: nextId, fileKey: nextId++, file: f, url: URL.createObjectURL(f), name: f.name,
    duration: 0, thumb: "", start: 0, zoom: 1, fx: 0, fy: 0, speed: 1, loading: true, error: false,
  }));
  state.clips.push(...added);
  render();
  // De uno en uno para no reventar la memoria del móvil con muchos decodificadores a la vez
  for (const clip of added) {
    try { await probe(clip); } catch (e) { clip.error = true; }
    clip.loading = false;
    render();
    if (!clip.error) store.putFile(clip.fileKey, clip.file);
  }
}

async function probe(clip) {
  const v = makeVideo();
  try {
    v.src = clip.url;
    await once(v, "loadedmetadata");
    clip.duration = isFinite(v.duration) ? v.duration : 0;
    if (!clip.duration) throw new Error("sin duración");
    await prime(v);
    try { await computeStats(v, clip); } catch (e) { clip.stats = null; }
    await seek(v, Math.min(0.05, clip.duration / 2));
    clip.thumb = snapshot(v, clip);
  } finally {
    dropVideo(v);
  }
}

function snapshot(v, clip) {
  const f = FORMATS[state.format];
  const c = document.createElement("canvas");
  c.width = 240;
  c.height = Math.round(240 * f.h / f.w);
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, c.width, c.height);
  drawCover(ctx, v, c.width, c.height, clip, { raw: true });
  return c.toDataURL("image/jpeg", 0.72);
}

// Un mismo vídeo puede estar en varios clips (duplicados): la URL solo se libera
// cuando ya no la usa ninguno.
function releaseUrl(url) {
  if (!state.clips.some((c) => c.url === url) && !(undo && undo.clip.url === url)) URL.revokeObjectURL(url);
}

let undo = null;
function removeClip(clip) {
  finishUndo();
  const idx = state.clips.indexOf(clip);
  state.clips.splice(idx, 1);
  undo = { clip, idx, timer: setTimeout(finishUndo, 6000) };
  showToast("Clip quitado", "Deshacer", () => {
    if (!undo) return;
    clearTimeout(undo.timer);
    state.clips.splice(Math.min(undo.idx, state.clips.length), 0, undo.clip);
    undo = null;
    render();
  });
}
function finishUndo() {
  if (!undo) return;
  clearTimeout(undo.timer);
  const { clip } = undo;
  undo = null;
  hideToast();
  releaseUrl(clip.url);
  store.saveSoon();
}

let toastTimer = 0;
function showToast(text, action, onAction, ms = 0) {
  clearTimeout(toastTimer);
  $("toastText").textContent = text;
  const b = $("toastBtn");
  b.textContent = action;
  b.onclick = () => { hideToast(); onAction(); };
  $("toast").hidden = false;
  if (ms) toastTimer = setTimeout(hideToast, ms);
}
function hideToast() { clearTimeout(toastTimer); $("toast").hidden = true; }

function duplicateClip(clip) {
  const copy = { ...clip, id: nextId++, stats: null };
  // El duplicado arranca justo donde acaba el original, si queda vídeo
  copy.start = Math.min(clip.start + footage(clip), maxStart(clip));
  state.clips.splice(state.clips.indexOf(clip) + 1, 0, copy);
  return copy;
}

// ---------------------------------------------------------------- render

function renderSeg(el, items, current, key) {
  el.innerHTML = "";
  for (const [v, label] of items) {
    const b = document.createElement("button");
    b.dataset.v = v;
    b.innerHTML = label;
    b.classList.toggle("on", String(current) === String(v));
    b.addEventListener("click", () => {
      state[key] = key === "dur" ? Number(v) : v;
      if (key === "dur") for (const c of state.clips) c.start = Math.min(c.start, maxStart(c));
      savePrefs();
      render();
    });
    el.appendChild(b);
  }
}

function render() {
  const has = state.clips.length > 0;
  $("empty").hidden = has;
  $("project").hidden = !has;
  $("bar").hidden = !has;
  $("btnClear").hidden = !has;
  document.body.classList.toggle("fmt-post", state.format === "post");
  document.body.classList.toggle("fmt-story", state.format === "story");

  renderSeg($("segFormat"), [
    ["story", "Historia<small>9:16 · hasta 1 min</small>"],
    ["post", "Publicación<small>4:5 · hasta 3 min</small>"],
  ], state.format, "format");
  renderSeg($("segDur"), DURS.map((d) => [d, d + " s"]), state.dur, "dur");
  renderSeg($("segTrans"), Object.entries(TRANSITIONS), state.trans, "trans");
  renderSeg($("segTone"), Object.entries(TONES), state.tone, "tone");

  const tl = buildTimeline();
  toneTarget = computeToneTarget(tl);
  const total = tl.reduce((s, e) => s + e.len, 0);
  const max = FORMATS[state.format].max;
  const over = rawTotal() > max + 0.05;
  const loading = state.clips.some((c) => c.loading);
  $("sumCount").textContent = `${tl.length} clip${tl.length === 1 ? "" : "s"}` + (loading ? " · cargando…" : "");
  $("sumTotal").textContent = `${fmtTime(total)} / ${fmtTime(max)}`;
  $("sumTotal").classList.toggle("warn", over);
  $("hint").textContent = over
    ? `Te pasas de ${fmtTime(max)}: se corta ahí y los clips en gris no entran. Quita alguno o baja la duración por clip.`
    : "Toca un clip para elegir el trozo y el encuadre. Mantén pulsado para moverlo.";
  $("hint").classList.toggle("warn", over);
  $("btnPreview").disabled = !tl.length || loading;
  $("btnExport").disabled = !tl.length || loading;

  renderGrid(tl);
  store.saveSoon();
}

function renderGrid(tl = buildTimeline()) {
  const grid = $("grid");
  grid.innerHTML = "";
  const lens = new Map(tl.map((e) => [e.clip, e.len]));
  state.clips.forEach((clip, i) => {
    const t = document.createElement("div");
    t.className = "tile";
    t.dataset.id = clip.id;
    if (clip.loading) t.classList.add("loading");
    if (clip.error) {
      t.classList.add("err");
      t.textContent = "No se puede leer este vídeo";
    } else if (clip.thumb) {
      t.style.backgroundImage = `url("${clip.thumb}")`;
    }
    if (drag && drag.id === clip.id) t.classList.add("placeholder");
    const num = document.createElement("span");
    num.className = "num";
    num.textContent = i + 1;
    t.appendChild(num);
    if (!clip.loading && !clip.error) {
      const len = document.createElement("span");
      const l = lens.get(clip);
      if (l == null) {
        t.classList.add("out");
        len.className = "len";
        len.textContent = "no entra";
      } else {
        len.className = "len" + (l < state.dur - 0.01 ? " short" : "");
        len.textContent = l.toFixed(1).replace(".", ",") + " s" + (clip.speed !== 1 ? " · " + fmtSpeed(clip.speed) : "");
      }
      t.appendChild(len);
    }
    grid.appendChild(t);
  });
}

// ---------------------------------------------------------------- reordenar arrastrando

let drag = null;
let suppressClick = false;

function setupGrid() {
  const grid = $("grid");
  let hold = null, sx = 0, sy = 0;
  const pt = (e) => (e.touches ? e.touches[0] || e.changedTouches[0] : e);

  function down(e) {
    const tile = e.target.closest(".tile");
    if (!tile) return;
    const p = pt(e);
    sx = p.clientX; sy = p.clientY;
    clearTimeout(hold);
    hold = setTimeout(() => begin(tile, p), 330);
  }
  function begin(tile, p) {
    hold = null;
    const r = tile.getBoundingClientRect();
    const ghost = tile.cloneNode(true);
    ghost.classList.add("drag-ghost");
    Object.assign(ghost.style, { left: r.left + "px", top: r.top + "px", width: r.width + "px", height: r.height + "px" });
    document.body.appendChild(ghost);
    drag = { id: Number(tile.dataset.id), ghost, ox: sx - r.left, oy: sy - r.top };
    tile.classList.add("placeholder");
    suppressClick = true;
    if (navigator.vibrate) navigator.vibrate(12);
  }
  function move(e) {
    const p = pt(e);
    if (!drag) {
      if (hold && (Math.abs(p.clientX - sx) > 8 || Math.abs(p.clientY - sy) > 8)) { clearTimeout(hold); hold = null; }
      return;
    }
    if (e.cancelable) e.preventDefault();
    drag.ghost.style.left = p.clientX - drag.ox + "px";
    drag.ghost.style.top = p.clientY - drag.oy + "px";
    if (p.clientY < 90) window.scrollBy(0, -10);
    else if (p.clientY > window.innerHeight - 130) window.scrollBy(0, 10);
    const over = document.elementFromPoint(p.clientX, p.clientY);
    const tile = over && over.closest && over.closest(".tile");
    if (!tile) return;
    const toId = Number(tile.dataset.id);
    if (toId === drag.id) return;
    const from = state.clips.findIndex((c) => c.id === drag.id);
    const to = state.clips.findIndex((c) => c.id === toId);
    const [c] = state.clips.splice(from, 1);
    state.clips.splice(to, 0, c);
    renderGrid();
  }
  function up() {
    clearTimeout(hold); hold = null;
    if (!drag) return;
    drag.ghost.remove();
    drag = null;
    render();
    setTimeout(() => { suppressClick = false; }, 80);
  }

  grid.addEventListener("touchstart", down, { passive: true });
  document.addEventListener("touchmove", move, { passive: false });
  document.addEventListener("touchend", up);
  document.addEventListener("touchcancel", up);
  grid.addEventListener("mousedown", (e) => { if (e.button === 0) down(e); });
  document.addEventListener("mousemove", move);
  document.addEventListener("mouseup", up);
  grid.addEventListener("contextmenu", (e) => e.preventDefault());

  grid.addEventListener("click", (e) => {
    if (suppressClick) return;
    const tile = e.target.closest(".tile");
    if (tile) openEditor(Number(tile.dataset.id));
  });
}

// ---------------------------------------------------------------- editor de clip

const ed = { clip: null, v: null, raf: 0, playing: false, pending: null, seeking: false };

async function openEditor(id) {
  const clip = state.clips.find((c) => c.id === id);
  if (!clip || clip.loading || clip.error) return;
  ed.clip = clip;
  const f = FORMATS[state.format];
  const cv = $("edCanvas");
  cv.width = f.w / 2;
  cv.height = f.h / 2;
  $("editor").hidden = false;
  document.body.style.overflow = "hidden";
  fitCanvas(cv, $("edStage"));
  updateEditorUI();

  if (!ed.v) ed.v = makeVideo();
  const v = ed.v;
  v.src = clip.url;
  try {
    await once(v, "loadedmetadata");
    await prime(v);
    await seek(v, clip.start);
  } catch (e) { /* si falla, el canvas se queda en negro */ }
  if (ed.clip === clip) edDraw();
}

function updateEditorUI() {
  const clip = ed.clip;
  const i = state.clips.indexOf(clip);
  const n = state.clips.length;
  $("edTitle").textContent = `Clip ${i + 1} de ${n}`;
  const s = $("edStart");
  s.max = maxStart(clip);
  s.value = clip.start;
  s.disabled = maxStart(clip) <= 0;
  $("edStartOut").textContent = `${fmtSec(clip.start)} → ${fmtSec(clip.start + footage(clip))}`;
  document.querySelectorAll("#edSpeed button").forEach((b) => b.classList.toggle("on", Number(b.dataset.v) === clip.speed));
  $("edZoom").value = clip.zoom;
  $("edZoomOut").textContent = clip.zoom.toFixed(2).replace(".", ",") + "×";
  $("edLeft").disabled = i <= 0;
  $("edRight").disabled = i >= n - 1;
}

function edDraw() {
  const cv = $("edCanvas");
  const ctx = cv.getContext("2d");
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, cv.width, cv.height);
  if (ed.v && ed.clip) drawCover(ctx, ed.v, cv.width, cv.height, ed.clip);
}

// Seeks encadenados: si el usuario arrastra rápido solo se aplica el último valor
async function edSeek(t) {
  ed.pending = t;
  if (ed.seeking) return;
  ed.seeking = true;
  while (ed.pending != null) {
    const target = ed.pending;
    ed.pending = null;
    try { await seek(ed.v, target); } catch (e) { break; }
    edDraw();
  }
  ed.seeking = false;
}

function edStop() {
  ed.playing = false;
  cancelAnimationFrame(ed.raf);
  if (ed.v) ed.v.pause();
  $("edPlay").textContent = "▶ Probar";
}

function edTogglePlay() {
  if (ed.playing) { edStop(); seekToStart(); return; }
  const clip = ed.clip, v = ed.v;
  ed.playing = true;
  $("edPlay").textContent = "■ Parar";
  v.currentTime = clip.start;
  v.playbackRate = clip.speed;
  v.play().catch(() => {});
  const loop = () => {
    if (!ed.playing) return;
    if (v.currentTime >= clip.start + footage(clip) || v.ended) {
      v.currentTime = clip.start;
      v.play().catch(() => {});
    }
    edDraw();
    ed.raf = requestAnimationFrame(loop);
  };
  ed.raf = requestAnimationFrame(loop);
}

function seekToStart() { if (ed.clip) edSeek(ed.clip.start); }

function closeEditor() {
  edStop();
  const clip = ed.clip;
  // La miniatura pasa a ser el frame y encuadre elegidos
  if (clip && ed.v && ed.v.readyState >= 2) {
    const v = ed.v;
    seek(v, clip.start).then(async () => {
      clip.thumb = snapshot(v, clip);
      // Si ha cambiado el trozo, se vuelve a medir su luz (salvo que ya se esté editando otro clip)
      if (!ed.clip && (!clip.stats || clip.stats.key !== statsKey(clip))) await computeStats(v, clip);
      render();
    }).catch(() => {});
  }
  ed.clip = null;
  $("editor").hidden = true;
  document.body.style.overflow = "";
  render();
}

function moveClip(delta) {
  const i = state.clips.indexOf(ed.clip);
  const j = i + delta;
  if (j < 0 || j >= state.clips.length) return;
  [state.clips[i], state.clips[j]] = [state.clips[j], state.clips[i]];
  updateEditorUI();
}

function setupEditor() {
  $("edDone").addEventListener("click", closeEditor);
  $("edStart").addEventListener("input", (e) => {
    edStop();
    ed.clip.start = clamp(Number(e.target.value), 0, maxStart(ed.clip));
    updateEditorUI();
    edSeek(ed.clip.start);
  });
  document.querySelectorAll(".frame-btns [data-step]").forEach((b) => b.addEventListener("click", () => {
    edStop();
    ed.clip.start = clamp(ed.clip.start + Number(b.dataset.step) * FRAME, 0, maxStart(ed.clip));
    updateEditorUI();
    edSeek(ed.clip.start);
  }));
  $("edPlay").addEventListener("click", edTogglePlay);
  $("edZoom").addEventListener("input", (e) => {
    ed.clip.zoom = Number(e.target.value);
    updateEditorUI();
    if (!ed.playing) edDraw();
  });
  $("edCenter").addEventListener("click", () => {
    Object.assign(ed.clip, { fx: 0, fy: 0, zoom: 1 });
    updateEditorUI();
    if (!ed.playing) edDraw();
  });
  $("edLeft").addEventListener("click", () => moveClip(-1));
  $("edRight").addEventListener("click", () => moveClip(1));
  $("edDelete").addEventListener("click", () => {
    const clip = ed.clip;
    edStop();
    ed.clip = null;
    removeClip(clip);
    $("editor").hidden = true;
    document.body.style.overflow = "";
    render();
  });
  $("edDup").addEventListener("click", () => {
    edStop();
    const copy = duplicateClip(ed.clip);
    ed.clip = copy;
    updateEditorUI();
    edSeek(copy.start);
    showToast("Duplicado: elige otro trozo para este", "Vale", () => {}, 3000);
  });
  document.querySelectorAll("#edSpeed button").forEach((b) => b.addEventListener("click", () => {
    edStop();
    ed.clip.speed = Number(b.dataset.v);
    ed.clip.start = Math.min(ed.clip.start, maxStart(ed.clip));
    updateEditorUI();
    edSeek(ed.clip.start);
  }));

  // Arrastrar sobre la imagen para mover el encuadre
  const cv = $("edCanvas");
  let last = null;
  cv.addEventListener("pointerdown", (e) => { last = { x: e.clientX, y: e.clientY }; cv.setPointerCapture(e.pointerId); });
  cv.addEventListener("pointermove", (e) => {
    if (!last || !ed.clip || !ed.v || !ed.v.videoWidth) return;
    const r = cv.getBoundingClientRect();
    const k = cv.width / r.width;
    const dx = (e.clientX - last.x) * k, dy = (e.clientY - last.y) * k;
    last = { x: e.clientX, y: e.clientY };
    const v = ed.v, clip = ed.clip, W = cv.width, H = cv.height;
    const s = Math.max(W / v.videoWidth, H / v.videoHeight) * clip.zoom;
    const roomX = (v.videoWidth * s - W) / 2, roomY = (v.videoHeight * s - H) / 2;
    if (roomX > 0.5) clip.fx = clamp(clip.fx + dx / roomX, -1, 1);
    if (roomY > 0.5) clip.fy = clamp(clip.fy + dy / roomY, -1, 1);
    if (!ed.playing) edDraw();
  });
  const end = () => { last = null; };
  cv.addEventListener("pointerup", end);
  cv.addEventListener("pointercancel", end);
}

// ---------------------------------------------------------------- motor de composición

// Usa 3 <video> en rueda: el clip actual, el anterior (mientras dura la transición)
// y el siguiente, que se va cargando y posicionando en su frame de inicio con antelación.
class Engine {
  constructor(canvas, tl, opts) {
    this.c = canvas;
    this.ctx = canvas.getContext("2d");
    this.W = canvas.width;
    this.H = canvas.height;
    this.tl = tl;
    this.total = tl.reduce((s, e) => s + e.len, 0);
    this.trans = state.trans;
    this.opts = opts;
    this.pool = [0, 1, 2].map(() => makeVideo());
    this.stopped = false;
    this.stalled = false;
  }

  el(i) { return this.pool[i % 3]; }

  indexAt(t) {
    for (let i = this.tl.length - 1; i >= 0; i--) if (t >= this.tl[i].t0) return i;
    return 0;
  }

  trLen(i) {
    if (this.trans === "cut" || i === 0) return 0;
    return Math.min(TRANS_LEN, this.tl[i].len / 2, this.tl[i - 1].len / 2);
  }

  prepare(i) {
    const el = this.el(i);
    if (el._idx === i) return el._prep;
    el._idx = i;
    el._ready = false;
    el._failed = false;
    const clip = this.tl[i].clip;
    el._prep = (async () => {
      el.pause();
      el.src = clip.url;
      await once(el, "loadedmetadata");
      if (el._idx !== i) return;
      await prime(el);
      await seek(el, clip.start);
      el.defaultPlaybackRate = el.playbackRate = clip.speed;
      if (el._idx === i) el._ready = true;
    })();
    el._prep.catch(() => { if (el._idx === i) el._failed = true; });
    return el._prep;
  }

  run() {
    return new Promise(async (resolve, reject) => {
      this._resolve = resolve;
      this._reject = reject;
      try { await this.prepare(0); } catch (e) { return this.fail(new Error("No se pudo leer el clip 1")); }
      if (this.stopped) return;
      if (this.tl.length > 1) this.prepare(1).catch(() => {});
      if (this.opts.record) {
        try { this.startRecorder(); } catch (e) { return this.fail(new Error("Este navegador no puede grabar vídeo: " + e.message)); }
      }
      this.vt = 0;
      this.last = performance.now();
      this.lastDraw = -1e9;
      this.raf = requestAnimationFrame((t) => this.frame(t));
    });
  }

  setStall(on) {
    if (on === this.stalled) return;
    this.stalled = on;
    if (on) for (const v of this.pool) v.pause();
    if (this.rec) {
      try {
        if (on && this.rec.state === "recording") this.rec.pause();
        if (!on && this.rec.state === "paused") this.rec.resume();
      } catch (e) { /* algunos navegadores no soportan pause: se graba un pequeño parón */ }
    }
    this.opts.onStall && this.opts.onStall(on);
  }

  frame(now) {
    if (this.stopped) return;
    const dt = Math.min((now - this.last) / 1000, 0.1);
    this.last = now;
    const tl = this.tl;
    const i = this.indexAt(this.vt);
    const e = tl[i];
    const local = this.vt - e.t0;
    const tr = this.trLen(i);
    const inTr = tr > 0 && local < tr;
    const cur = this.el(i);

    if (cur._idx !== i) this.prepare(i).catch(() => {});
    if (cur._failed) return this.fail(new Error(`No se pudo leer el clip ${i + 1}`));
    if (!cur._ready) {
      this.setStall(true);
      this.raf = requestAnimationFrame((t) => this.frame(t));
      return;
    }
    if (this.stalled) this.setStall(false);

    const prev = inTr ? this.el(i - 1) : null;
    for (const v of this.pool) {
      const needed = v === cur || v === prev;
      if (needed && v.paused && !v.ended) {
        v.playbackRate = tl[v._idx].clip.speed;
        v.play().catch(() => {});
      }
      // (los que aún se están preparando no se tocan: su play/pause de arranque es necesario en iOS)
      if (!needed && !v.paused && v._ready) v.pause();
    }
    // Si el vídeo se ha desfasado del reloj, lo recolocamos
    const target = e.clip.start + local * e.clip.speed;
    if (!cur.seeking && Math.abs(cur.currentTime - target) > 0.3 && target < cur.duration - 0.05) cur.currentTime = target;

    // En pantallas de 120 Hz no hace falta pintar más de 30 veces por segundo
    if (now - this.lastDraw >= 1000 / FPS - 4) {
      this.lastDraw = now;
      this.compose(i, local, tr, inTr, prev);
    }
    if (i + 1 < tl.length) this.prepare(i + 1).catch(() => {});

    this.vt += dt;
    this.opts.onProgress && this.opts.onProgress(Math.min(this.vt, this.total), this.total);
    if (this.vt >= this.total) { this.finish(); return; }
    this.raf = requestAnimationFrame((t) => this.frame(t));
  }

  compose(i, local, tr, inTr, prevEl) {
    const { ctx, W, H } = this;
    ctx.globalAlpha = 1;
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, W, H);
    const cur = this.el(i), c = this.tl[i].clip;
    if (!inTr) { drawCover(ctx, cur, W, H, c); return; }
    const pc = this.tl[i - 1].clip;
    const p = clamp(local / tr, 0, 1);
    const k = ease(p);
    switch (this.trans) {
      case "fade":
        drawCover(ctx, prevEl, W, H, pc);
        drawCover(ctx, cur, W, H, c, { alpha: k });
        break;
      case "black":
        if (p < 0.5) drawCover(ctx, prevEl, W, H, pc);
        else drawCover(ctx, cur, W, H, c);
        ctx.fillStyle = `rgba(0,0,0,${p < 0.5 ? p * 2 : (1 - p) * 2})`;
        ctx.fillRect(0, 0, W, H);
        break;
      case "slide":
        drawCover(ctx, prevEl, W, H, pc, { dx: -W * k });
        drawCover(ctx, cur, W, H, c, { dx: W * (1 - k) });
        break;
      case "zoom":
        drawCover(ctx, prevEl, W, H, pc, { scale: 1 + 0.15 * k });
        drawCover(ctx, cur, W, H, c, { alpha: k, scale: 1.2 - 0.2 * k });
        break;
      default:
        drawCover(ctx, cur, W, H, c);
    }
  }

  startRecorder() {
    if (!window.MediaRecorder || !this.c.captureStream) throw new Error("falta MediaRecorder");
    const stream = this.c.captureStream(FPS);
    const types = ["video/mp4;codecs=avc1.640028", "video/mp4;codecs=avc1", "video/mp4", "video/webm;codecs=vp9", "video/webm"];
    const mime = types.find((t) => MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t)) || "";
    this.chunks = [];
    this.rec = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: BITRATE } : { videoBitsPerSecond: BITRATE });
    this.mime = this.rec.mimeType || mime || "video/mp4";
    this.rec.ondataavailable = (ev) => { if (ev.data && ev.data.size) this.chunks.push(ev.data); };
    this.rec.start(1000);
  }

  stopRecorder() {
    return new Promise((resolve) => {
      this.rec.onstop = () => resolve(new Blob(this.chunks, { type: this.mime.split(";")[0] }));
      this.rec.stop();
    });
  }

  async finish() {
    this.stopped = true;
    cancelAnimationFrame(this.raf);
    let blob = null;
    if (this.rec) {
      await wait(200);  // deja que el último frame entre en la grabación
      blob = await this.stopRecorder();
    }
    this.cleanup();
    this._resolve(blob);
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    cancelAnimationFrame(this.raf);
    if (this.rec && this.rec.state !== "inactive") { this.rec.ondataavailable = null; this.rec.stop(); }
    this.cleanup();
    this._resolve && this._resolve(null);
  }

  fail(err) {
    this.stop();
    this._reject && this._reject(err);
  }

  cleanup() {
    for (const v of this.pool) dropVideo(v);
  }
}

// ---------------------------------------------------------------- vista previa / exportar

let engine = null;
let wakeLock = null;
let resultUrl = null;

async function startPlayer(record) {
  const tl = buildTimeline();
  if (!tl.length) return;
  const f = FORMATS[state.format];
  const cv = $("plCanvas");
  // La vista previa va a la mitad de resolución para ir más fluida; la exportación a 1080 real
  cv.width = record ? f.w : f.w / 2;
  cv.height = record ? f.h : f.h / 2;
  cv.hidden = false;
  $("plResult").hidden = true;
  $("plActions").hidden = true;
  $("plBar").style.width = "0";
  $("plTitle").textContent = record ? `Exportando ${f.w}×${f.h}` : "Vista previa";
  setStatus(record ? "Preparando…" : "");
  $("player").hidden = false;
  document.body.style.overflow = "hidden";
  fitCanvas(cv, $("plStage"));

  if (record) {
    try { wakeLock = await navigator.wakeLock.request("screen"); } catch (e) { wakeLock = null; }
  }
  if (TONE_STRENGTH[state.tone]) {
    await ensureStats((i, n) => setStatus(`Igualando tono… ${i + 1}/${n}`));
    if ($("player").hidden) { releaseWake(); return; }
    toneTarget = computeToneTarget(tl);
  }

  let stalled = false;
  engine = new Engine(cv, tl, {
    record,
    onStall: (on) => { stalled = on; },
    onProgress: (t, total) => {
      $("plBar").style.width = (t / total * 100).toFixed(1) + "%";
      if (record) setStatus(stalled ? "Cargando el siguiente clip…" : `${fmtTime(t)} / ${fmtTime(total)} · no bloquees el móvil ni salgas de la app`);
      else setStatus(`${fmtTime(t)} / ${fmtTime(total)}`);
    },
  });
  const my = engine;
  try {
    const blob = await engine.run();
    if (my !== engine) return;
    if (record && blob) showResult(blob);
    else if (!record && !my.stoppedByUser) setStatus("Fin de la vista previa");
  } catch (err) {
    if (my === engine) setStatus(err.message || "Algo ha fallado", true);
  } finally {
    releaseWake();
  }
}

function setStatus(text, error = false) {
  const s = $("plStatus");
  s.textContent = text;
  s.classList.toggle("error", error);
}

function releaseWake() {
  if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
}

function showResult(blob) {
  const ext = blob.type.includes("mp4") ? "mp4" : "webm";
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const name = `cuadra-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.${ext}`;
  if (resultUrl) URL.revokeObjectURL(resultUrl);
  resultUrl = URL.createObjectURL(blob);
  const v = $("plResult");
  v.src = resultUrl;
  v.hidden = false;
  $("plCanvas").hidden = true;
  const f = FORMATS[state.format];
  v.width = f.w; v.height = f.h;
  fitVideo(v);
  $("plTitle").textContent = "¡Listo!";
  setStatus(`${(blob.size / 1048576).toFixed(1).replace(".", ",")} MB · ${ext.toUpperCase()} ${f.w}×${f.h}`);
  $("plActions").hidden = false;
  const a = $("plDownload");
  a.href = resultUrl;
  a.download = name;
  $("plShare").onclick = async () => {
    const file = new File([blob], name, { type: blob.type });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file] }); } catch (e) { /* cancelado */ }
    } else {
      a.click();
    }
  };
  const canShare = !!(navigator.canShare && navigator.canShare({ files: [new File([blob], name, { type: blob.type })] }));
  $("plShare").hidden = !canShare;
  $("plActions").style.gridTemplateColumns = canShare ? "" : "1fr";
}

function fitVideo(v) {
  const r = $("plStage").getBoundingClientRect();
  const k = Math.min((r.width - 32) / v.width, (r.height - 8) / v.height);
  v.style.width = Math.floor(v.width * k) + "px";
  v.style.height = Math.floor(v.height * k) + "px";
}

function closePlayer() {
  if (engine) { engine.stoppedByUser = true; engine.stop(); engine = null; }
  releaseWake();
  const v = $("plResult");
  v.pause();
  v.removeAttribute("src");
  v.load();
  if (resultUrl) { URL.revokeObjectURL(resultUrl); resultUrl = null; }
  $("player").hidden = true;
  document.body.style.overflow = "";
}

// Si el usuario sale de la app mientras exporta, iOS congela la página y la grabación sale rota
document.addEventListener("visibilitychange", () => {
  if (document.hidden && engine && engine.opts.record && !engine.stopped) {
    const e = engine;
    engine = null;
    e.stop();
    releaseWake();
    setStatus("Has salido de la app y la exportación se ha cortado. Dale a Cerrar y vuelve a exportar.", true);
  }
});

// ---------------------------------------------------------------- guardar proyecto

// Los vídeos y el estado de cada clip se guardan en IndexedDB (dentro del propio móvil),
// para que si iOS cierra la app al irte a Fotos o a Instagram, al volver siga todo igual.
const store = {
  _db: null,
  _timer: 0,
  failed: false,
  restored: false,
  db() {
    if (!this._db) {
      this._db = new Promise((resolve, reject) => {
        const r = indexedDB.open("cuadra", 1);
        r.onupgradeneeded = () => { r.result.createObjectStore("files"); r.result.createObjectStore("meta"); };
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
    }
    return this._db;
  },
  async req(name, mode, fn) {
    const db = await this.db();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(name, mode);
      const rq = fn(tx.objectStore(name));
      tx.oncomplete = () => resolve(rq && rq.result);
      tx.onerror = tx.onabort = () => reject(tx.error);
    });
  },
  async putFile(key, file) {
    try { await this.req("files", "readwrite", (s) => s.put(file, key)); }
    catch (e) {
      if (this.failed) return;
      this.failed = true;
      showToast("No hay espacio para guardar los clips: si cierras la app se perderán", "Vale", () => {});
    }
  },
  saveSoon() {
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this.saveNow(), 400);
  },
  async saveNow() {
    clearTimeout(this._timer);
    if (!this.restored) return;   // no pisar lo guardado antes de haberlo cargado
    const keep = ["id", "fileKey", "name", "duration", "thumb", "start", "zoom", "fx", "fy", "speed", "stats"];
    const clips = state.clips.filter((c) => !c.loading && !c.error)
      .map((c) => Object.fromEntries(keep.map((k) => [k, c[k]])));
    try {
      await this.req("meta", "readwrite", (s) => s.put({ clips, nextId }, "project"));
      // Borra los vídeos que ya no usa ningún clip
      const used = new Set(state.clips.map((c) => c.fileKey));
      if (undo) used.add(undo.clip.fileKey);
      const keys = await this.req("files", "readonly", (s) => s.getAllKeys());
      const unused = keys.filter((k) => !used.has(k));
      if (unused.length) await this.req("files", "readwrite", (s) => { unused.forEach((k) => s.delete(k)); });
    } catch (e) { /* sin IndexedDB: la app funciona igual, solo que sin guardar */ }
  },
  async restore() {
    try {
      if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
      const meta = await this.req("meta", "readonly", (s) => s.get("project"));
      if (meta && meta.clips && meta.clips.length && !state.clips.length) {
        const files = new Map();
        const clips = [];
        for (const c of meta.clips) {
          if (!files.has(c.fileKey)) {
            const file = await this.req("files", "readonly", (s) => s.get(c.fileKey));
            files.set(c.fileKey, file ? { file, url: URL.createObjectURL(file) } : null);
          }
          const f = files.get(c.fileKey);
          if (f) clips.push({ speed: 1, ...c, file: f.file, url: f.url, loading: false, error: false });
        }
        nextId = Math.max(nextId, meta.nextId || 1, ...clips.map((c) => c.id + 1));
        state.clips = clips;
      }
    } catch (e) { /* nada guardado o sin IndexedDB */ }
    this.restored = true;
    render();
  },
};

// ---------------------------------------------------------------- arranque

function init() {
  loadPrefs();
  const onPick = (e) => { addFiles(e.target.files); e.target.value = ""; };
  $("fileInput").addEventListener("change", onPick);
  $("fileInput2").addEventListener("change", onPick);
  $("btnClear").addEventListener("click", () => {
    if (!confirm("¿Quitar todos los clips?")) return;
    finishUndo();
    const urls = new Set(state.clips.map((c) => c.url));
    state.clips = [];
    urls.forEach((u) => URL.revokeObjectURL(u));
    render();
  });
  $("btnPreview").addEventListener("click", () => startPlayer(false));
  $("btnExport").addEventListener("click", () => startPlayer(true));
  $("plClose").addEventListener("click", closePlayer);
  window.addEventListener("resize", () => {
    if (!$("editor").hidden) fitCanvas($("edCanvas"), $("edStage"));
    if (!$("player").hidden) {
      if (!$("plCanvas").hidden) fitCanvas($("plCanvas"), $("plStage"));
      else fitVideo($("plResult"));
    }
  });
  setupGrid();
  setupEditor();
  render();
  store.restore();
  // iOS puede matar la app en cuanto se va a segundo plano: se guarda ya
  document.addEventListener("visibilitychange", () => { if (document.hidden) store.saveNow(); });

  if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
}

init();
