"use strict";

// CUADRA — junta clips cortos en un vídeo vertical de 1080 para Instagram.
// Todo pasa en el móvil: los clips se dibujan en un <canvas> en tiempo real
// y MediaRecorder graba ese canvas a MP4. Nada sale del teléfono.

// max = duración máxima en segundos (límites de Instagram): lo que pase se corta
const FORMATS = {
  story: { w: 1080, h: 1920, max: 60, label: "Historia" },
  post: { w: 1080, h: 1350, max: 180, label: "Publicación" },
};
const DUR_MODES = { 4: "4 s", 8: "8 s", beat: "Ritmo" };
const BEATS = [2, 4, 8];
const TRANSITIONS = { cut: "Corte", fade: "Fundido", black: "Negro", slide: "Deslizar", zoom: "Zoom" };
const TONES = { off: "No", soft: "Suave", full: "Fuerte" };
const TONE_STRENGTH = { off: 0, soft: 0.55, full: 1 };
const FADES = { off: "No", on: "Desde negro" };
// Looks para todo el vídeo: se aplican después de igualar el tono
const LOOKS = {
  natural: { label: "Natural" },
  vivo: { label: "Vivo", sat: 1.25, con: 1.06 },
  calido: { label: "Cálido", warm: 0.45, sat: 1.08, con: 1.04 },
  cine: { label: "Cine", warm: 0.12, sat: 0.82, con: 1.1, lift: 0.05, vig: 0.35 },
  frio: { label: "Frío", warm: -0.45, sat: 0.95, con: 1.04 },
  bn: { label: "B/N", sat: 0, con: 1.15, vig: 0.25 },
};
const KB = { none: "No", in: "Acercar", out: "Alejar" };
const KB_AMOUNT = 0.12;          // zoom lento: 12 % a lo largo del clip
const FPS = 30;
const FRAME = 1 / FPS;
const TRANS_LEN = 0.5;           // segundos que dura cada transición
const FADE_LEN = 0.6;            // fundido de entrada y salida
const BITRATE = 12_000_000;      // 12 Mbps: buena calidad en 1080 sin pesar demasiado
const MIN_SLOT = 0.5;

// Ajustes de cada proyecto (y valores de uno nuevo)
const DEFAULTS = { format: "story", durMode: "4", bpm: 120, beats: 4, trans: "fade", tone: "soft", look: "natural", fades: "on" };
const state = { projectId: null, name: "", saved: false, clips: [], ...DEFAULTS };
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
const pad2 = (n) => String(n).padStart(2, "0");

function fmtTime(s) {
  s = Math.max(0, Math.round(s));
  return `${Math.floor(s / 60)}:${pad2(s % 60)}`;
}
const fmtSec = (s) => s.toFixed(2).replace(".", ",") + " s";
const fmtNum = (x, d = 1) => x.toFixed(d).replace(".", ",");
const fmtSpeed = (x) => String(x).replace(".", ",") + "×";
const fmtClock = (ms) => { const d = new Date(ms); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };
const fmtDay = (ms) => new Date(ms).toLocaleDateString("es-ES", { day: "numeric", month: "short" }).replace(".", "");

// Duración de cada clip: fija (4 / 8 s) o sacada del ritmo de la canción
function clipDur() {
  return state.durMode === "beat" ? state.beats * 60 / state.bpm : Number(state.durMode);
}

// Con velocidad, un hueco de 4 s a 2× consume 8 s de vídeo original ("metraje")
function maxStart(clip) { return Math.max(0, clip.duration - clipDur() * clip.speed); }
function slotLen(clip) { return Math.max(MIN_SLOT, Math.min(clipDur(), (clip.duration - clip.start) / clip.speed)); }
function footage(clip) { return slotLen(clip) * clip.speed; }
function usable() { return state.clips.filter((c) => !c.loading && !c.error && c.duration > 0); }
function clampStarts() { for (const c of state.clips) c.start = Math.min(c.start, maxStart(c)); }

function normalizeClip(c) {
  return Object.assign(
    { zoom: 1, fx: 0, fy: 0, speed: 1, stats: null, date: null, kb: "none", zones: [], loading: false, error: false },
    c,
    { adj: Object.assign({ bright: 0, warm: 0, sat: 1 }, c.adj) },
  );
}

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

// ---------------------------------------------------------------- dibujo de un clip

// Rectángulo donde se pinta el vídeo para rellenar el lienzo (tipo "cover"), con el
// encuadre del clip: fx/fy van de -1 a 1 y mueven el recorte dentro del hueco que
// sobra; zoom amplía; el zoom lento (kb) va creciendo según el progreso p del clip.
function coverRect(vw, vh, W, H, clip, o = {}) {
  const p = clamp(o.p || 0, 0, 1);
  const kb = clip.kb === "in" ? 1 + KB_AMOUNT * ease(p) : clip.kb === "out" ? 1 + KB_AMOUNT * (1 - ease(p)) : 1;
  const s = Math.max(W / vw, H / vh) * clip.zoom * kb * (o.scale || 1);
  const dw = vw * s, dh = vh * s;
  return {
    x: (W - dw) / 2 + clip.fx * (dw - W) / 2 + (o.dx || 0),
    y: (H - dh) / 2 + clip.fy * (dh - H) / 2,
    dw, dh,
  };
}

function drawCover(ctx, v, W, H, clip, o = {}) {
  const vw = v.videoWidth, vh = v.videoHeight;
  if (!vw || !vh || v.readyState < 2) return;
  const r = coverRect(vw, vh, W, H, clip, o);
  ctx.globalAlpha = o.alpha == null ? 1 : o.alpha;
  const g = o.raw ? null : gradeParams(clip);
  if (g && grader.render(v, r.x, r.y, r.dw, r.dh, W, H, g)) ctx.drawImage(grader.canvas, 0, 0, W, H);
  else ctx.drawImage(v, r.x, r.y, r.dw, r.dh);
  ctx.globalAlpha = 1;
  if (!o.raw) for (const z of clip.zones) {
    const q = zoneCanvasRect(z, r, o.p || 0);
    pixelate(ctx, q.x, q.y, q.w, q.h, W, H);
  }
}

// ---------------------------------------------------------------- tapar matrículas

// Cada zona se guarda en coordenadas del vídeo original (0–1), así sigue a la imagen
// aunque cambie el encuadre o el zoom. Si tiene posición final (x2/y2), se mueve en
// línea recta del inicio al final del trozo usado.
function zoneAt(z, p) {
  return {
    x: z.x2 == null ? z.x : z.x + (z.x2 - z.x) * p,
    y: z.y2 == null ? z.y : z.y + (z.y2 - z.y) * p,
    w: z.w, h: z.h,
  };
}
function zoneCanvasRect(z, r, p) {
  const q = zoneAt(z, clamp(p, 0, 1));
  return { x: r.x + q.x * r.dw, y: r.y + q.y * r.dh, w: q.w * r.dw, h: q.h * r.dh };
}

const pixCanvas = document.createElement("canvas");
const pixCtx = pixCanvas.getContext("2d");
// Mosaico: cada cuadro mide ~1/3,5 del alto de la zona. En una matrícula cada letra se queda
// en 2×2 o 3×3 cuadros: se ve el pixelado típico pero no se puede leer.
function pixelate(ctx, x, y, w, h, W, H) {
  const x0 = Math.max(0, Math.floor(x)), y0 = Math.max(0, Math.floor(y));
  const x1 = Math.min(W, Math.ceil(x + w)), y1 = Math.min(H, Math.ceil(y + h));
  const pw = x1 - x0, ph = y1 - y0;
  if (pw < 2 || ph < 2) return;
  const block = Math.max(W / 140, h / 3.5);
  const sw = Math.max(1, Math.round(pw / block)), sh = Math.max(1, Math.round(ph / block));
  pixCanvas.width = sw;
  pixCanvas.height = sh;
  pixCtx.drawImage(ctx.canvas, x0, y0, pw, ph, 0, 0, sw, sh);
  ctx.save();
  ctx.globalAlpha = 1;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(pixCanvas, 0, 0, sw, sh, x0, y0, pw, ph);
  ctx.restore();
}

function drawVignette(ctx, W, H, amount) {
  if (!amount) return;
  const g = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, Math.hypot(W, H) / 2);
  g.addColorStop(0, "rgba(0,0,0,0)");
  g.addColorStop(1, `rgba(0,0,0,${amount})`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
}

// ---------------------------------------------------------------- color: tono, look y luz

// Igualar tono: cada clip se analiza (media de R, G, B y contraste en varios frames del
// trozo usado). El objetivo es la mediana de todos los clips del vídeo, y cada clip se
// corrige hacia ahí: color = (color - media_clip) * contraste + media_objetivo.
let toneTarget = null;

const statsKey = (clip) => `${clip.start.toFixed(3)}|${clipDur().toFixed(3)}|${clip.speed}`;
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

// Junta en un solo paso del shader: igualar tono + luz manual del clip + look del vídeo
function gradeParams(clip) {
  const look = LOOKS[state.look] || LOOKS.natural;
  const strength = TONE_STRENGTH[state.tone];
  const tone = strength && toneTarget && clip.stats;
  const s = clip.stats;
  const g = {
    m: tone ? s.mean : [0, 0, 0],
    // Límites para no destrozar clips muy distintos (un atardecer no debe volverse gris)
    t: tone ? s.mean.map((m, ch) => m + clamp(toneTarget.mean[ch] - m, -0.18, 0.18)) : [0, 0, 0],
    k: tone ? clamp(toneTarget.std / Math.max(s.std, 0.02), 0.8, 1.3) : 1,
    s: tone ? strength : 0,
    bright: clip.adj.bright,
    warm: (look.warm || 0) + clip.adj.warm,
    sat: (look.sat == null ? 1 : look.sat) * clip.adj.sat,
    con: look.con || 1,
    lift: look.lift || 0,
  };
  const neutral = !g.s && !g.bright && !g.warm && g.sat === 1 && g.con === 1 && !g.lift;
  return neutral ? null : g;
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

// El color se hace con la GPU (WebGL): el vídeo se pinta en un canvas del tamaño
// de salida con el shader, y ese canvas se copia al lienzo principal.
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
    gl.attachShader(p, sh(gl.FRAGMENT_SHADER, `
      precision mediump float;
      varying vec2 uv;
      uniform sampler2D tex;
      uniform vec3 m; uniform vec3 t; uniform float k; uniform float s;
      uniform float bright; uniform float warm; uniform float sat; uniform float con; uniform float lift;
      void main() {
        vec3 c = texture2D(tex, uv).rgb;
        c = mix(c, clamp((c - m) * k + t, 0.0, 1.0), s);
        c += bright;
        c += vec3(warm, warm * 0.3, -warm) * 0.12;
        float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
        c = mix(vec3(l), c, sat);
        c = (c - 0.5) * con + 0.5;
        c = lift + c * (1.0 - lift);
        gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
      }`));
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
    this.u = {};
    for (const n of ["m", "t", "k", "s", "bright", "warm", "sat", "con", "lift"]) this.u[n] = gl.getUniformLocation(p, n);
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
    for (const n of ["k", "s", "bright", "warm", "sat", "con", "lift"]) gl.uniform1f(this.u[n], g[n]);
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

// ---------------------------------------------------------------- hora de grabación

// Los .mov/.mp4 del iPhone llevan dentro (caja "mvhd" del "moov") la fecha de creación.
// Se leen solo las cabeceras con file.slice, sin cargar el vídeo entero en memoria.
const MP4_EPOCH = Date.UTC(1904, 0, 1);

async function readCreationDate(file) {
  try {
    const size = file.size;
    let off = 0;
    for (let guard = 0; guard < 200 && off + 8 <= size; guard++) {
      const h = new DataView(await file.slice(off, off + 16).arrayBuffer());
      let len = h.getUint32(0), hl = 8;
      const type = String.fromCharCode(h.getUint8(4), h.getUint8(5), h.getUint8(6), h.getUint8(7));
      if (len === 1) { len = Number(h.getBigUint64(8)); hl = 16; } else if (len === 0) len = size - off;
      if (len < 8) return null;
      if (type === "moov") {
        const end = off + Math.min(len, 16 * 1024 * 1024);
        const dv = new DataView(await file.slice(off + hl, end).arrayBuffer());
        for (let o = 0; o + 8 <= dv.byteLength;) {
          const bl = dv.getUint32(o);
          if (bl < 8) break;
          if (dv.getUint32(o + 4) === 0x6d766864 /* mvhd */) {
            const secs = dv.getUint8(o + 8) === 1 ? Number(dv.getBigUint64(o + 12)) : dv.getUint32(o + 12);
            const ms = MP4_EPOCH + secs * 1000;
            // Fechas absurdas (0 o futuras) = el vídeo no la trae
            return ms > Date.UTC(2005, 0, 1) && ms < Date.now() + 86400000 ? ms : null;
          }
          o += bl;
        }
        return null;
      }
      off += len;
    }
  } catch (e) { /* formato raro: sin fecha */ }
  return null;
}

// Orden estable: primero los que tienen hora, en orden; los que no, detrás tal cual
function byDate(a, b) {
  if (a.date == null && b.date == null) return 0;
  if (a.date == null) return 1;
  if (b.date == null) return -1;
  return a.date - b.date;
}

function sortByDate() {
  const dated = state.clips.filter((c) => c.date != null).length;
  if (!dated) { showToast("Estos vídeos no traen la hora de grabación", "Vale", () => {}, 4000); return; }
  const before = state.clips.slice();
  state.clips.sort(byDate);
  render();
  showToast(`Ordenados por hora de grabación${dated < state.clips.length ? ` (${state.clips.length - dated} sin hora, al final)` : ""}`, "Deshacer", () => {
    state.clips = before.filter((c) => state.clips.includes(c));
    render();
  }, 6000);
}

// ---------------------------------------------------------------- añadir clips

async function addFiles(fileList) {
  const files = [...fileList].filter((f) => (f.type || "").startsWith("video/") || /\.(mov|mp4|m4v|webm|3gp)$/i.test(f.name));
  if (!files.length) return;
  // La hora se lee antes para que la tanda entre ya ordenada
  const dates = await Promise.all(files.map(readCreationDate));
  const added = files.map((f, i) => normalizeClip({
    id: nextId, fileKey: nextId++, file: f, url: URL.createObjectURL(f), name: f.name,
    duration: 0, thumb: "", start: 0, date: dates[i], loading: true,
  })).sort(byDate);
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
function releaseAllUrls() {
  new Set(state.clips.map((c) => c.url)).forEach((u) => URL.revokeObjectURL(u));
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

function cloneClip(clip) {
  return { ...clip, id: nextId++, stats: null, adj: { ...clip.adj }, zones: clip.zones.map((z) => ({ ...z })) };
}

function duplicateClip(clip) {
  const copy = cloneClip(clip);
  // El duplicado arranca justo donde acaba el original, si queda vídeo
  copy.start = Math.min(clip.start + footage(clip), maxStart(clip));
  state.clips.splice(state.clips.indexOf(clip) + 1, 0, copy);
  return copy;
}

// ---------------------------------------------------------------- render

function renderSeg(el, items, current, onPick) {
  el.innerHTML = "";
  for (const [v, label] of items) {
    const b = document.createElement("button");
    b.dataset.v = v;
    b.innerHTML = label;
    b.classList.toggle("on", String(current) === String(v));
    b.addEventListener("click", () => onPick(v));
    el.appendChild(b);
  }
}

function setSetting(key, value) {
  state[key] = value;
  if (key === "durMode" || key === "beats" || key === "bpm") clampStarts();
  render();
}

function render() {
  const has = state.clips.length > 0;
  $("empty").hidden = has;
  $("project").hidden = !has;
  $("bar").hidden = !has;
  $("projName").textContent = state.saved ? state.name : "";
  document.body.classList.toggle("fmt-post", state.format === "post");
  document.body.classList.toggle("fmt-story", state.format === "story");

  renderSeg($("segFormat"), [
    ["story", "Historia<small>9:16 · hasta 1 min</small>"],
    ["post", "Publicación<small>4:5 · hasta 3 min</small>"],
  ], state.format, (v) => setSetting("format", v));
  renderSeg($("segDur"), Object.entries(DUR_MODES), state.durMode, (v) => setSetting("durMode", v));
  $("beatRow").hidden = state.durMode !== "beat";
  $("bpmOut").textContent = state.bpm;
  renderSeg($("segBeats"), BEATS.map((n) => [n, `${n} golpes<small>${fmtNum(n * 60 / state.bpm)} s</small>`]),
    state.beats, (v) => setSetting("beats", Number(v)));
  renderSeg($("segTrans"), Object.entries(TRANSITIONS), state.trans, (v) => setSetting("trans", v));
  renderSeg($("segTone"), Object.entries(TONES), state.tone, (v) => setSetting("tone", v));
  renderSeg($("segLook"), Object.entries(LOOKS).map(([k, l]) => [k, l.label]), state.look, (v) => setSetting("look", v));
  renderSeg($("segFades"), Object.entries(FADES), state.fades, (v) => setSetting("fades", v));
  $("settingsSum").textContent = [
    FORMATS[state.format].label,
    state.durMode === "beat" ? `${state.bpm} BPM` : DUR_MODES[state.durMode],
    TRANSITIONS[state.trans],
    LOOKS[state.look].label,
  ].join(" · ");

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
    : "Toca un clip para editarlo. Mantén pulsado para moverlo.";
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
  const dur = clipDur();
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
    if (clip.date != null) {
      const time = document.createElement("span");
      time.className = "time";
      time.textContent = fmtClock(clip.date);
      t.appendChild(time);
    }
    if (!clip.loading && !clip.error) {
      const marks = [];
      if (clip.speed !== 1) marks.push(fmtSpeed(clip.speed));
      if (clip.kb !== "none") marks.push("🔍");
      if (clip.zones.length) marks.push("▦");
      const len = document.createElement("span");
      const l = lens.get(clip);
      if (l == null) {
        t.classList.add("out");
        len.className = "len";
        len.textContent = "no entra";
      } else {
        len.className = "len" + (l < dur - 0.01 ? " short" : "");
        len.textContent = [fmtNum(l) + " s", ...marks].join(" · ");
      }
      t.appendChild(len);
    }
    grid.appendChild(t);
  });
}

// ---------------------------------------------------------------- ritmo (BPM)

// Tap tempo: tocando al ritmo de la canción se calcula el BPM con la media de los intervalos
let taps = [];
function tapTempo() {
  const now = performance.now();
  if (taps.length && now - taps[taps.length - 1] > 2000) taps = [];
  taps.push(now);
  if (taps.length > 9) taps.shift();
  const b = $("btnTap");
  b.classList.remove("hit");
  void b.offsetWidth;
  b.classList.add("hit");
  if (taps.length >= 3) {
    const iv = (taps[taps.length - 1] - taps[0]) / (taps.length - 1);
    setSetting("bpm", clamp(Math.round(60000 / iv), 50, 220));
    b.textContent = "Toca al ritmo";
  } else {
    b.textContent = "Sigue tocando…";
  }
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

const ed = { clip: null, v: null, raf: 0, playing: false, pending: null, seeking: false, tab: "trozo", key: "start", zone: -1 };

async function openEditor(id) {
  const clip = state.clips.find((c) => c.id === id);
  if (!clip || clip.loading || clip.error) return;
  ed.clip = clip;
  ed.key = "start";
  ed.zone = clip.zones.length ? 0 : -1;
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

const HINTS = {
  trozo: "Arrastra para encuadrar",
  encuadre: "Arrastra para encuadrar",
  luz: "",
  tapar: "Arrastra el recuadro · esquina para el tamaño",
};

function updateEditorUI() {
  const clip = ed.clip;
  const i = state.clips.indexOf(clip);
  const n = state.clips.length;
  $("edTitle").textContent = `Clip ${i + 1} de ${n}` + (clip.date != null ? ` · ${fmtClock(clip.date)}` : "");
  document.querySelectorAll("#edTabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === ed.tab));
  document.querySelectorAll(".pane").forEach((p) => { p.hidden = p.dataset.pane !== ed.tab; });
  $("edHint").textContent = HINTS[ed.tab];
  $("edHint").hidden = !HINTS[ed.tab];

  // Trozo
  const s = $("edStart");
  s.max = maxStart(clip);
  s.value = clip.start;
  s.disabled = maxStart(clip) <= 0;
  $("edStartOut").textContent = `${fmtSec(clip.start)} → ${fmtSec(clip.start + footage(clip))}`;
  document.querySelectorAll("#edSpeed button").forEach((b) => b.classList.toggle("on", Number(b.dataset.v) === clip.speed));
  // Encuadre
  $("edZoom").value = clip.zoom;
  $("edZoomOut").textContent = fmtNum(clip.zoom, 2) + "×";
  document.querySelectorAll("#edKb button").forEach((b) => b.classList.toggle("on", b.dataset.v === clip.kb));
  // Luz
  $("edBright").value = Math.round(clip.adj.bright / 0.25 * 100);
  $("edWarm").value = Math.round(clip.adj.warm * 100);
  $("edSat").value = Math.round(clip.adj.sat * 100);
  const signed = (x) => (x > 0 ? "+" : "") + x;
  $("edBrightOut").textContent = signed(Number($("edBright").value));
  $("edWarmOut").textContent = signed(Number($("edWarm").value));
  $("edSatOut").textContent = $("edSat").value + " %";
  // Tapar
  document.querySelectorAll("#edKey button").forEach((b) => b.classList.toggle("on", b.dataset.v === ed.key));
  $("zoneDel").disabled = ed.zone < 0;
  $("zoneCount").textContent = clip.zones.length
    ? `${clip.zones.length} recuadro${clip.zones.length === 1 ? "" : "s"}${clip.zones.some((z) => z.x2 != null) ? " · con movimiento" : ""}`
    : "Sin recuadros";

  $("edLeft").disabled = i <= 0;
  $("edRight").disabled = i >= n - 1;
}

function edProgress() {
  const c = ed.clip;
  return ed.v ? clamp((ed.v.currentTime - c.start) / footage(c), 0, 1) : 0;
}

function edRect() {
  const v = ed.v, cv = $("edCanvas");
  if (!v || !v.videoWidth) return null;
  return coverRect(v.videoWidth, v.videoHeight, cv.width, cv.height, ed.clip, { p: edProgress() });
}

function edDraw() {
  const cv = $("edCanvas");
  const ctx = cv.getContext("2d");
  const W = cv.width, H = cv.height;
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, W, H);
  if (!ed.v || !ed.clip) return;
  const p = edProgress();
  drawCover(ctx, ed.v, W, H, ed.clip, { p });
  drawVignette(ctx, W, H, LOOKS[state.look].vig);

  if (ed.tab === "encuadre" || ed.tab === "trozo") {
    // Tercios y, en historias, las franjas que tapa la interfaz de Instagram
    ctx.strokeStyle = "rgba(255,255,255,.35)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const k of [1, 2]) {
      ctx.moveTo(W * k / 3, 0); ctx.lineTo(W * k / 3, H);
      ctx.moveTo(0, H * k / 3); ctx.lineTo(W, H * k / 3);
    }
    ctx.stroke();
    if (state.format === "story") {
      ctx.fillStyle = "rgba(0,0,0,.4)";
      ctx.fillRect(0, 0, W, H * 0.11);
      ctx.fillRect(0, H * 0.84, W, H * 0.16);
      ctx.fillStyle = "rgba(255,255,255,.7)";
      ctx.font = `${Math.round(W / 32)}px -apple-system, sans-serif`;
      ctx.textAlign = "center";
      ctx.fillText("zona que tapa Instagram", W / 2, H * 0.07);
      ctx.fillText("zona que tapa Instagram", W / 2, H * 0.93);
    }
  }
  // Los marcos solo sirven para colocar: al darle a Probar se ve tal cual saldrá
  if (ed.tab === "tapar" && !ed.playing) {
    const r = edRect();
    if (!r) return;
    ed.clip.zones.forEach((z, i) => {
      const q = zoneCanvasRect(z, r, p);
      const sel = i === ed.zone;
      ctx.lineWidth = sel ? 3 : 2;
      ctx.strokeStyle = sel ? "#FF5C39" : "rgba(255,255,255,.85)";
      ctx.setLineDash(sel ? [] : [6, 4]);
      ctx.strokeRect(q.x, q.y, q.w, q.h);
      ctx.setLineDash([]);
      if (sel) {
        ctx.fillStyle = "#FF5C39";
        ctx.fillRect(q.x + q.w - 9, q.y + q.h - 9, 18, 18);
      }
    });
  }
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
  if (ed.playing) { edStop(); edSeek(edKeyTime()); return; }
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

// En la pestaña Tapar, "Final" muestra el último frame del trozo para colocar ahí el recuadro
function edKeyTime() {
  const c = ed.clip;
  return ed.tab === "tapar" && ed.key === "end" ? Math.max(c.start, c.start + footage(c) - 0.05) : c.start;
}

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

function edChanged() {
  updateEditorUI();
  if (!ed.playing) edDraw();
}

function setupEditor() {
  $("edDone").addEventListener("click", closeEditor);
  document.querySelectorAll("#edTabs button").forEach((b) => b.addEventListener("click", () => {
    ed.tab = b.dataset.tab;
    if (!ed.playing) edSeek(edKeyTime());
    edChanged();
  }));

  // Trozo
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
  document.querySelectorAll("#edSpeed button").forEach((b) => b.addEventListener("click", () => {
    edStop();
    ed.clip.speed = Number(b.dataset.v);
    ed.clip.start = Math.min(ed.clip.start, maxStart(ed.clip));
    updateEditorUI();
    edSeek(ed.clip.start);
  }));
  $("edPlay").addEventListener("click", edTogglePlay);

  // Encuadre
  $("edZoom").addEventListener("input", (e) => { ed.clip.zoom = Number(e.target.value); edChanged(); });
  $("edCenter").addEventListener("click", () => { Object.assign(ed.clip, { fx: 0, fy: 0, zoom: 1 }); edChanged(); });
  document.querySelectorAll("#edKb button").forEach((b) => b.addEventListener("click", () => { ed.clip.kb = b.dataset.v; edChanged(); }));
  $("kbAll").addEventListener("click", () => {
    const kb = ed.clip.kb;
    // "Acercar" o "Alejar" en todos se alterna para que no canse: acercar, alejar, acercar…
    state.clips.forEach((c, i) => { c.kb = kb === "none" ? "none" : (i % 2 === 0 ? kb : (kb === "in" ? "out" : "in")); });
    edChanged();
    showToast(kb === "none" ? "Zoom lento quitado de todos" : "Zoom lento en todos, alternando acercar y alejar", "Vale", () => {}, 3000);
  });

  // Luz
  $("edBright").addEventListener("input", (e) => { ed.clip.adj.bright = Number(e.target.value) / 100 * 0.25; edChanged(); });
  $("edWarm").addEventListener("input", (e) => { ed.clip.adj.warm = Number(e.target.value) / 100; edChanged(); });
  $("edSat").addEventListener("input", (e) => { ed.clip.adj.sat = Number(e.target.value) / 100; edChanged(); });
  $("lightReset").addEventListener("click", () => { ed.clip.adj = { bright: 0, warm: 0, sat: 1 }; edChanged(); });
  $("lightAll").addEventListener("click", () => {
    for (const c of state.clips) c.adj = { ...ed.clip.adj };
    showToast("Luz copiada a todos los clips", "Vale", () => {}, 3000);
  });

  // Tapar
  document.querySelectorAll("#edKey button").forEach((b) => b.addEventListener("click", () => {
    edStop();
    ed.key = b.dataset.v;
    updateEditorUI();
    edSeek(edKeyTime());
  }));
  $("zoneAdd").addEventListener("click", () => {
    const r = edRect();
    if (!r) return;
    const cv = $("edCanvas");
    // Recuadro nuevo en el centro de lo que se ve, del tamaño aproximado de una matrícula
    const w = cv.width * 0.34 / r.dw, h = cv.width * 0.09 / r.dh;
    const cx = (cv.width / 2 - r.x) / r.dw, cy = (cv.height / 2 - r.y) / r.dh;
    ed.clip.zones.push({ x: cx - w / 2, y: cy - h / 2, w, h, x2: null, y2: null });
    ed.zone = ed.clip.zones.length - 1;
    edChanged();
  });
  $("zoneDel").addEventListener("click", () => {
    if (ed.zone < 0) return;
    ed.clip.zones.splice(ed.zone, 1);
    ed.zone = ed.clip.zones.length - 1;
    edChanged();
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

  // Arrastrar sobre la imagen: mueve el encuadre, o los recuadros en la pestaña Tapar
  const cv = $("edCanvas");
  let last = null, mode = null;
  const toCanvas = (e) => {
    const b = cv.getBoundingClientRect();
    const k = cv.width / b.width;
    return { x: (e.clientX - b.left) * k, y: (e.clientY - b.top) * k, k };
  };
  cv.addEventListener("pointerdown", (e) => {
    last = toCanvas(e);
    mode = "frame";
    cv.setPointerCapture(e.pointerId);
    if (ed.tab !== "tapar") return;
    mode = null;
    const r = edRect();
    if (!r) return;
    const p = edProgress();
    const grab = 22 * last.k;
    for (let i = ed.clip.zones.length - 1; i >= 0; i--) {
      const q = zoneCanvasRect(ed.clip.zones[i], r, p);
      const nearCorner = Math.abs(last.x - (q.x + q.w)) < grab && Math.abs(last.y - (q.y + q.h)) < grab;
      const inside = last.x >= q.x && last.x <= q.x + q.w && last.y >= q.y && last.y <= q.y + q.h;
      if (nearCorner || inside) { ed.zone = i; mode = nearCorner ? "resize" : "move"; break; }
    }
    edChanged();
  });
  cv.addEventListener("pointermove", (e) => {
    if (!last || !mode || !ed.clip || !ed.v || !ed.v.videoWidth) return;
    const now = toCanvas(e);
    const dx = now.x - last.x, dy = now.y - last.y;
    last = now;
    const clip = ed.clip, W = cv.width, H = cv.height;
    const r = edRect();
    if (mode === "frame") {
      const roomX = (r.dw - W) / 2, roomY = (r.dh - H) / 2;
      if (roomX > 0.5) clip.fx = clamp(clip.fx + dx / roomX, -1, 1);
      if (roomY > 0.5) clip.fy = clamp(clip.fy + dy / roomY, -1, 1);
    } else {
      const z = clip.zones[ed.zone];
      if (!z) return;
      const nx = dx / r.dw, ny = dy / r.dh;
      if (mode === "resize") {
        z.w = clamp(z.w + nx, 0.01, 1);
        z.h = clamp(z.h + ny, 0.01, 1);
      } else if (ed.key === "end") {
        if (z.x2 == null) { z.x2 = z.x; z.y2 = z.y; }
        z.x2 += nx; z.y2 += ny;
      } else {
        z.x += nx; z.y += ny;
      }
    }
    if (!ed.playing) edDraw();
  });
  const end = () => {
    if (mode && mode !== "frame") updateEditorUI();
    last = null; mode = null;
  };
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
    this.vig = LOOKS[state.look].vig || 0;
    this.fades = state.fades === "on";
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
    const pc = i > 0 ? this.tl[i - 1].clip : null;
    const p = local / this.tl[i].len;   // progreso del clip (zoom lento y recuadros)
    if (!inTr) {
      drawCover(ctx, cur, W, H, c, { p });
    } else {
      const q = clamp(local / tr, 0, 1);
      const k = ease(q);
      switch (this.trans) {
        case "fade":
          drawCover(ctx, prevEl, W, H, pc, { p: 1 });
          drawCover(ctx, cur, W, H, c, { p, alpha: k });
          break;
        case "black":
          if (q < 0.5) drawCover(ctx, prevEl, W, H, pc, { p: 1 });
          else drawCover(ctx, cur, W, H, c, { p });
          ctx.fillStyle = `rgba(0,0,0,${q < 0.5 ? q * 2 : (1 - q) * 2})`;
          ctx.fillRect(0, 0, W, H);
          break;
        case "slide":
          drawCover(ctx, prevEl, W, H, pc, { p: 1, dx: -W * k });
          drawCover(ctx, cur, W, H, c, { p, dx: W * (1 - k) });
          break;
        case "zoom":
          drawCover(ctx, prevEl, W, H, pc, { p: 1, scale: 1 + 0.15 * k });
          drawCover(ctx, cur, W, H, c, { p, alpha: k, scale: 1.2 - 0.2 * k });
          break;
        default:
          drawCover(ctx, cur, W, H, c, { p });
      }
    }
    drawVignette(ctx, W, H, this.vig);
    if (this.fades) {
      const t = this.vt, a = t < FADE_LEN ? 1 - t / FADE_LEN : t > this.total - FADE_LEN ? (t - (this.total - FADE_LEN)) / FADE_LEN : 0;
      if (a > 0) {
        ctx.fillStyle = `rgba(0,0,0,${clamp(a, 0, 1)})`;
        ctx.fillRect(0, 0, W, H);
      }
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
      // Último frame (en negro si hay fundido) y un respiro para que entre en la grabación
      this.vt = this.total;
      this.compose(this.tl.length - 1, this.tl[this.tl.length - 1].len, 0, false, null);
      await wait(200);
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

function slug(s) {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
}

function showResult(blob) {
  const ext = blob.type.includes("mp4") ? "mp4" : "webm";
  const d = new Date();
  const name = `${slug(state.name) || "cuadra"}-${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}.${ext}`;
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
  setStatus(`${fmtNum(blob.size / 1048576)} MB · ${ext.toUpperCase()} ${f.w}×${f.h}`);
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

// ---------------------------------------------------------------- guardar proyectos

// Todo se guarda en IndexedDB, dentro del propio móvil, para que si iOS cierra la app
// al irte a Fotos o a Instagram, al volver siga todo igual.
//   files:  fileKey → vídeo original (compartido entre duplicados)
//   meta:   "projects" → índice de proyectos, "project:<id>" → ajustes y clips,
//           "current" → proyecto abierto, "counter" → siguiente id libre
const CLIP_KEYS = ["id", "fileKey", "name", "duration", "thumb", "start", "zoom", "fx", "fy", "speed", "stats", "date", "adj", "kb", "zones"];
const SETTING_KEYS = Object.keys(DEFAULTS);

const store = {
  _db: null,
  _timer: 0,
  _chain: Promise.resolve(),
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
  get(key) { return this.req("meta", "readonly", (s) => s.get(key)); },
  put(key, val) { return this.req("meta", "readwrite", (s) => s.put(val, key)); },
  async index() { return (await this.get("projects")) || []; },

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
  // Los guardados van en fila para que dos no se pisen
  saveNow() {
    clearTimeout(this._timer);
    this._chain = this._chain.then(() => this._save()).catch(() => {});
    return this._chain;
  },
  async _save() {
    if (!this.restored || !state.projectId) return;   // no pisar lo guardado antes de haberlo cargado
    const clips = state.clips.filter((c) => !c.loading && !c.error)
      .map((c) => Object.fromEntries(CLIP_KEYS.map((k) => [k, c[k]])));
    const settings = Object.fromEntries(SETTING_KEYS.map((k) => [k, state[k]]));
    await this.put("project:" + state.projectId, { id: state.projectId, name: state.name, saved: state.saved, settings, clips });
    const tl = buildTimeline();
    const list = await this.index();
    const entry = list.find((p) => p.id === state.projectId);
    const info = {
      id: state.projectId, name: state.name, saved: state.saved, updated: Date.now(),
      count: clips.length, total: tl.reduce((s, e) => s + e.len, 0), format: state.format,
      thumb: (clips[0] && clips[0].thumb) || "",
      fileKeys: [...new Set(clips.map((c) => c.fileKey))],
    };
    if (entry) Object.assign(entry, info); else list.push({ created: Date.now(), ...info });
    await this.put("projects", list);
    await this.put("current", state.projectId);
    await this.put("counter", nextId);
    // Borra los vídeos que ya no usa ningún clip de ningún proyecto
    const used = new Set(list.flatMap((p) => p.fileKeys || []));
    state.clips.forEach((c) => used.add(c.fileKey));
    if (undo) used.add(undo.clip.fileKey);
    const keys = await this.req("files", "readonly", (s) => s.getAllKeys());
    const unused = keys.filter((k) => !used.has(k));
    if (unused.length) await this.req("files", "readwrite", (s) => { unused.forEach((k) => s.delete(k)); });
  },

  async load(id) {
    const rec = await this.get("project:" + id);
    if (!rec) return false;
    const files = new Map();
    const clips = [];
    for (const c of rec.clips || []) {
      if (!files.has(c.fileKey)) {
        const file = await this.req("files", "readonly", (s) => s.get(c.fileKey));
        files.set(c.fileKey, file ? { file, url: URL.createObjectURL(file) } : null);
      }
      const f = files.get(c.fileKey);
      if (f) clips.push(normalizeClip({ ...c, file: f.file, url: f.url }));
    }
    Object.assign(state, DEFAULTS, rec.settings || {}, { projectId: id, name: rec.name, saved: !!rec.saved, clips });
    nextId = Math.max(nextId, ...clips.map((c) => Math.max(c.id, c.fileKey) + 1));
    return true;
  },

  async create(name, settings, saved = false) {
    const list = await this.index();
    const id = "p" + Date.now().toString(36);
    const rec = { id, name: name || defaultDraftName(), saved, settings: settings || { ...DEFAULTS }, clips: [] };
    await this.put("project:" + id, rec);
    list.push({ id, name: rec.name, saved, created: Date.now(), updated: Date.now(), count: 0, total: 0, thumb: "", fileKeys: [], format: rec.settings.format });
    await this.put("projects", list);
    return id;
  },

  async remove(id) {
    const list = (await this.index()).filter((p) => p.id !== id);
    await this.put("projects", list);
    await this.req("meta", "readwrite", (s) => s.delete("project:" + id));
    return list;
  },

  async rename(id, name) {
    const list = await this.index();
    const p = list.find((x) => x.id === id);
    if (p) p.name = name;
    await this.put("projects", list);
    const rec = await this.get("project:" + id);
    if (rec) { rec.name = name; await this.put("project:" + id, rec); }
  },

  async restore() {
    try {
      if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
      nextId = Math.max(nextId, (await this.get("counter")) || 1);
      // Versión anterior (un solo proyecto): se convierte en el primero de la lista
      const old = await this.get("project");
      if (old && !(await this.index()).length) {
        const id = await this.create("Mi primer vídeo", null, true);
        const rec = await this.get("project:" + id);
        rec.clips = old.clips || [];
        await this.put("project:" + id, rec);
        nextId = Math.max(nextId, old.nextId || 1);
        await this.put("current", id);
        await this.req("meta", "readwrite", (s) => s.delete("project"));
      }
      let id = await this.get("current");
      if (!id || !(await this.load(id))) {
        const list = await this.index();
        const last = list.filter((p) => !p.saved).pop();
        id = last ? last.id : await this.create();
        await this.load(id);
      }
    } catch (e) {
      // Sin IndexedDB (modo privado raro): la app funciona igual, solo que sin guardar
      state.projectId = state.projectId || "local";
      state.name = state.name || "Proyecto";
    }
    this.restored = true;
    render();
  },
};

// ---------------------------------------------------------------- borradores

// Lo que estás editando se guarda solo (por si iOS cierra la app). "Guardar borrador" le
// pone nombre y lo deja en la lista para retomarlo otro día; lo no guardado se descarta
// cuando empiezas otro vídeo (preguntando antes).
function defaultDraftName() {
  const now = Date.now();
  return `Borrador · ${fmtDay(now)} ${fmtClock(now)}`;
}

async function saveDraft() {
  const name = prompt("Nombre del borrador", state.saved ? state.name : defaultDraftName());
  if (name == null) return false;
  state.name = name.trim() || defaultDraftName();
  state.saved = true;
  await store.saveNow();
  render();
  showToast("Borrador guardado", "Vale", () => {}, 2500);
  return true;
}

// Pequeño diálogo con varias opciones (confirm() solo da dos y aquí hacen falta tres)
function ask(text, options) {
  return new Promise((resolve) => {
    $("askText").textContent = text;
    const box = $("askBtns");
    box.innerHTML = "";
    for (const [value, label, cls] of options) {
      const b = document.createElement("button");
      b.className = "btn " + (cls || "");
      b.textContent = label;
      b.onclick = () => { $("ask").hidden = true; resolve(value); };
      box.appendChild(b);
    }
    $("ask").hidden = false;
  });
}

// Antes de dejar el vídeo actual: si tiene clips y no es un borrador guardado, se pregunta
async function leaveCurrent() {
  if (state.clips.some((c) => c.loading)) {
    showToast("Espera a que terminen de cargar los clips", "Vale", () => {}, 3000);
    return false;
  }
  finishUndo();
  if (!state.saved && state.clips.length) {
    const r = await ask("El vídeo actual no está guardado como borrador.", [
      ["save", "Guardar borrador", "primary"], ["drop", "Descartarlo", "danger-btn"], ["cancel", "Cancelar"],
    ]);
    if (r === "cancel") return false;
    if (r === "save" && !(await saveDraft())) return false;
  }
  await store.saveNow();
  // Un vídeo sin guardar se tira (con sus clips) al salir de él
  if (!state.saved && state.projectId) await store.remove(state.projectId);
  releaseAllUrls();
  state.clips = [];
  state.projectId = null;
  await store.saveNow();   // limpia los vídeos que ya no usa nadie
  return true;
}

async function newVideo() {
  // El vídeo nuevo hereda los ajustes del actual (formato, ritmo, look…)
  const settings = Object.fromEntries(SETTING_KEYS.map((k) => [k, state[k]]));
  if (!(await leaveCurrent())) return;
  await store.load(await store.create(null, settings));
  closeDrafts();
  window.scrollTo(0, 0);
  render();
}

async function openDraft(id) {
  if (!(await leaveCurrent())) return;
  if (!(await store.load(id))) await store.load(await store.create());
  closeDrafts();
  window.scrollTo(0, 0);
  render();
}

async function openDrafts() {
  await store.saveNow();
  const list = (await store.index()).filter((p) => p.saved).sort((a, b) => (b.updated || 0) - (a.updated || 0));
  const box = $("projList");
  box.innerHTML = "";
  if (!list.length) {
    const p = document.createElement("p");
    p.className = "proj-empty";
    p.textContent = "Aún no tienes borradores. Dale a «Guardar» en un vídeo para dejarlo aquí.";
    box.appendChild(p);
  }
  for (const p of list) {
    const row = document.createElement("div");
    row.className = "proj" + (p.id === state.projectId ? " current" : "");
    row.dataset.id = p.id;
    const th = document.createElement("div");
    th.className = "proj-thumb" + (p.format === "post" ? " post" : "");
    if (p.thumb) th.style.backgroundImage = `url("${p.thumb}")`;
    const info = document.createElement("div");
    info.className = "proj-info";
    const b = document.createElement("b");
    b.textContent = p.name;
    const sm = document.createElement("span");
    sm.textContent = (p.id === state.projectId ? "Abierto · " : "") +
      `${p.count || 0} clip${p.count === 1 ? "" : "s"} · ${fmtTime(p.total || 0)} · ${fmtDay(p.updated || p.created || Date.now())}`;
    info.append(b, sm);
    const ren = document.createElement("button");
    ren.className = "icon-btn";
    ren.dataset.act = "ren";
    ren.setAttribute("aria-label", "Renombrar");
    ren.textContent = "✎";
    const del = document.createElement("button");
    del.className = "icon-btn danger";
    del.dataset.act = "del";
    del.setAttribute("aria-label", "Borrar");
    del.textContent = "✕";
    row.append(th, info, ren, del);
    box.appendChild(row);
  }
  $("projects").hidden = false;
  document.body.style.overflow = "hidden";
}

function closeDrafts() {
  $("projects").hidden = true;
  document.body.style.overflow = "";
}

function setupDrafts() {
  $("btnDrafts").addEventListener("click", openDrafts);
  $("btnSaveDraft").addEventListener("click", saveDraft);
  $("projClose").addEventListener("click", closeDrafts);
  $("projNew").addEventListener("click", newVideo);
  $("projList").addEventListener("click", async (e) => {
    const row = e.target.closest(".proj");
    if (!row) return;
    const id = row.dataset.id;
    const act = e.target.closest("[data-act]");
    if (act && act.dataset.act === "ren") {
      const cur = row.querySelector("b").textContent;
      const name = (prompt("Nombre del borrador", cur) || "").trim();
      if (!name || name === cur) return;
      if (id === state.projectId) { state.name = name; await store.saveNow(); }
      await store.rename(id, name);
      render();
      openDrafts();
    } else if (act && act.dataset.act === "del") {
      if (!confirm(`¿Borrar "${row.querySelector("b").textContent}" y sus clips? No se puede deshacer.`)) return;
      if (id === state.projectId) {
        // Borrar el que tienes abierto: te quedas con un vídeo vacío
        state.saved = false;
        state.clips.length = 0;
        await leaveCurrent();
        await store.load(await store.create());
        render();
      } else {
        await store.remove(id);
      }
      await store.saveNow();
      openDrafts();
    } else if (id !== state.projectId) {
      await openDraft(id);
    } else {
      closeDrafts();
    }
  });
}

// ---------------------------------------------------------------- arranque

function init() {
  const onPick = (e) => { addFiles(e.target.files); e.target.value = ""; };
  $("fileInput").addEventListener("change", onPick);
  $("fileInput2").addEventListener("change", onPick);
  $("btnSort").addEventListener("click", sortByDate);
  $("btnTap").addEventListener("pointerdown", (e) => { e.preventDefault(); tapTempo(); });
  $("bpmMinus").addEventListener("click", () => setSetting("bpm", clamp(state.bpm - 1, 50, 220)));
  $("bpmPlus").addEventListener("click", () => setSetting("bpm", clamp(state.bpm + 1, 50, 220)));
  // Recordar si el panel de ajustes estaba abierto (comodidad, no importa si falla)
  const box = $("settingsBox");
  try { if (localStorage.getItem("cuadra-settings-open") === "0") box.open = false; } catch (e) { /* nada */ }
  box.addEventListener("toggle", () => { try { localStorage.setItem("cuadra-settings-open", box.open ? "1" : "0"); } catch (e) { /* nada */ } });

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
  setupDrafts();
  render();
  store.restore();
  // iOS puede matar la app en cuanto se va a segundo plano: se guarda ya
  document.addEventListener("visibilitychange", () => { if (document.hidden) store.saveNow(); });

  if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
}

init();
