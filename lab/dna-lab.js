// ─── dna-lab.js ──────────────────────────────────────────────────────────────
// ESPERIMENTO — Step 1 "Spatial Playground". Nodi fittizi, nessun dato vero,
// nessuna rete. Serve solo a capire se esplorare il DNA nello spazio è
// piacevole.
//
// L'idea (approccio A, 2.5D con un filo di prospettiva vera):
//   - i nodi sono gli STESSI <button class="dna-node"> del DNA, stesso markup;
//   - la profondità non è decorativa: è la distanza in salti dal nodo che stai
//     guardando (la stessa che oggi il DNA usa solo per l'opacità). Il nodo
//     attivo sta davanti, i vicini subito dietro, il resto sfuma in fondo;
//   - toccare un nodo = la camera ci "vola" sopra e tutta la rete si
//     riordina in profondità attorno a lui;
//   - il trascinamento muove la camera: i piani lontani scorrono più piano
//     (parallax), e mentre il dito si muove la scena si inclina di pochi
//     gradi, quanto basta a far "vedere dietro";
//   - il pinch avvicina/allontana la camera lungo la profondità.
//
// Niente librerie: una proiezione prospettica calcolata a mano e applicata
// con transform/opacity (compositor), solo mentre qualcosa si muove.

import { avatarHtml } from "../ui.js?v=da87024";
import { escapeHtml } from "../cine-core.js?v=da87024";

const POSTER = "https://image.tmdb.org/t/p/w185";

// ─── DATI FITTIZI ────────────────────────────────────────────────────────────
// Stessi tipi e stessi tipi di arco del DNA vero (ama / appartiene / diretto /
// recita). Le locandine sono vere solo per avere lo stesso aspetto.

const NODES = {
  "persona:Tu":            { label: "Tu" },
  "persona:Marco":         { label: "Marco" },
  "persona:Sara":          { label: "Sara" },
  "film:interstellar":     { label: "Interstellar", year: 2014, poster: "/gEU2QniE6E77NI6lCU6MxlNBvIx.jpg" },
  "film:inception":        { label: "Inception", year: 2010, poster: "/9gk7adHYeDvHkCSEqAvQNLV5Uge.jpg" },
  "film:dark-knight":      { label: "Il cavaliere oscuro", year: 2008, poster: "/qJ2tW6WMUDux911r6m7haRef0WH.jpg" },
  "film:dune":             { label: "Dune", year: 2021, poster: "/d5NXSklXo0qyIYkgV94XAgMIckC.jpg" },
  "film:joker":            { label: "Joker", year: 2019, poster: "/udDclJoHjfjb8Ekgsd4FDteOkCU.jpg" },
  "film:lotr":             { label: "Il ritorno del re", year: 2003, poster: "/rCzpDGLbOoPwLjy3OAm5NUPOTrC.jpg" },
  "film:fastx":            { label: "Fast X", year: 2023, poster: "/1E5baAaEse26fej7uHcjOgEE2t2.jpg" },
  "genere:Fantascienza":   { label: "Fantascienza" },
  "genere:Dramma":         { label: "Dramma" },
  "genere:Fantasy":        { label: "Fantasy" },
  "regista:Christopher Nolan": { label: "Christopher Nolan" },
  "attore:Timothée Chalamet":  { label: "Timothée Chalamet" }
};

// [a, b, tipo] — l'ordine conta: è l'ordine in cui un tap li apre.
const EDGES = [
  ["persona:Tu", "film:interstellar", "ama"],
  ["persona:Tu", "genere:Fantascienza", "ama"],
  ["persona:Tu", "regista:Christopher Nolan", "diretto"],
  ["persona:Tu", "film:inception", "ama"],
  ["persona:Tu", "film:dark-knight", "ama"],
  ["film:interstellar", "persona:Marco", "ama"],
  ["film:interstellar", "persona:Sara", "ama"],
  ["film:interstellar", "genere:Fantascienza", "appartiene"],
  ["film:interstellar", "regista:Christopher Nolan", "diretto"],
  ["film:inception", "persona:Marco", "ama"],
  ["film:inception", "regista:Christopher Nolan", "diretto"],
  ["film:inception", "genere:Fantascienza", "appartiene"],
  ["film:dark-knight", "regista:Christopher Nolan", "diretto"],
  ["film:dark-knight", "genere:Dramma", "appartiene"],
  ["film:dark-knight", "persona:Sara", "ama"],
  ["persona:Marco", "film:dune", "ama"],
  ["persona:Marco", "film:joker", "ama"],
  ["persona:Marco", "genere:Dramma", "ama"],
  ["persona:Marco", "film:lotr", "ama"],
  ["persona:Sara", "film:dune", "ama"],
  ["persona:Sara", "film:lotr", "ama"],
  ["persona:Sara", "film:fastx", "ama"],
  ["persona:Sara", "genere:Fantasy", "ama"],
  ["film:dune", "genere:Fantascienza", "appartiene"],
  ["film:dune", "attore:Timothée Chalamet", "recita"],
  ["film:joker", "genere:Dramma", "appartiene"],
  ["film:lotr", "genere:Fantasy", "appartiene"]
];

const ROOT = "persona:Tu";
const type = (id) => id.slice(0, id.indexOf(":"));
const edgeKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);

const ADJ = new Map();
for (const [a, b, kind] of EDGES) {
  if (!ADJ.has(a)) ADJ.set(a, []);
  if (!ADJ.has(b)) ADJ.set(b, []);
  ADJ.get(a).push({ id: b, kind });
  ADJ.get(b).push({ id: a, kind });
}

// ─── PARAMETRI DELLO SPAZIO ──────────────────────────────────────────────────

const F = 560;                               // focale: più bassa = prospettiva più forte
const DEPTH = [-30, 70, 260, 440, 600];      // z per 0,1,2,3,4+ salti dal nodo attivo
const OPAC  = [1, 1, .6, .34, .2];           // stessa scala di .dna-h0..h4
const LABEL_MIN_SCALE = .62;                 // sotto, l'etichetta sarebbe illeggibile
const Z_MIN = -520, Z_MAX = 170;             // pinch: quanto allontanarsi/avvicinarsi
const RADIUS = 126;                          // stesso raggio del ventaglio del DNA
const MIN_GAP = 94;
const MAX_TILT = 0.14;                       // ~8°
const DRAG_THRESHOLD = 8;

// ─── STATO ───────────────────────────────────────────────────────────────────

let nodes, edges, linked, focusId;
const cam = { x: 0, y: 0, z: 0, tx: 0, ty: 0, tz: 0, yaw: 0, pitch: 0, tyaw: 0, tpitch: 0, vx: 0, vy: 0 };
let depthOn = true, tiltOn = true;
let W = 0, H = 0;
let dragged = false;

const el = (id) => document.getElementById(id);
const stage = el("labStage");
const nodesEl = el("labNodes");
const edgesEl = el("labEdges");

function reset() {
  nodes = new Map();
  edges = [];
  linked = new Set();
  addNode(ROOT, null, 0, 0);
  focusId = ROOT;
  Object.assign(cam, { x: 0, y: 0, z: 0, tx: 0, ty: 0, tz: 0, yaw: 0, pitch: 0, tyaw: 0, tpitch: 0, vx: 0, vy: 0 });
  nodesEl.innerHTML = "";
  edgesEl.innerHTML = "";
  ensureDom(nodes.get(ROOT));
  retarget();
  for (const n of nodes.values()) n.h = n.th;
  refreshUi();
  kick();
}

function addNode(id, parent, x, y) {
  const n = { id, parent, x, y, expanded: false, h: 4, th: 4, grow: parent ? 0 : 1, dom: null };
  nodes.set(id, n);
  return n;
}

// ─── RETE: apri / chiudi (stessa forma di dna.js::expand/collapse) ───────────

function expand(id) {
  const src = nodes.get(id);
  src.expanded = true;
  const limit = H >= 340 ? 5 : 4;
  // Prima i "ponti" (nodi già in rete): aprirli chiude un anello.
  const cands = (ADJ.get(id) || [])
    .filter(c => !linked.has(edgeKey(id, c.id)))
    .map((c, i) => ({ ...c, i, bridge: nodes.has(c.id) ? 1 : 0 }))
    .sort((a, b) => b.bridge - a.bridge || a.i - b.i)
    .slice(0, limit);

  const added = cands.filter(c => !nodes.has(c.id)).map(c => c.id);
  layoutChildren(src, added);
  for (const c of cands) {
    linked.add(edgeKey(id, c.id));
    edges.push({ a: id, b: c.id, kind: c.kind, dom: null });
  }
  return added;
}

function degree(id) { return edges.reduce((n, e) => n + (e.a === id || e.b === id), 0); }

function collapse(id) {
  nodes.get(id).expanded = false;
  let changed = true;
  while (changed) {
    changed = false;
    for (const n of [...nodes.values()]) {
      if (n.id === ROOT || n.expanded || !n.parent || !nodes.has(n.parent)) continue;
      if (nodes.get(n.parent).expanded || degree(n.id) > 1) continue;
      n.dom?.remove();
      nodes.delete(n.id);
      for (let i = edges.length - 1; i >= 0; i--) {
        const e = edges[i];
        if (e.a === n.id || e.b === n.id) { e.dom?.remove(); linked.delete(edgeKey(e.a, e.b)); edges.splice(i, 1); }
      }
      changed = true;
    }
  }
}

// Ventaglio radiale come nel DNA: la radice a giro completo, gli altri a 180°
// dalla parte opposta al genitore. Una volta piazzato, un nodo non si muove.
function layoutChildren(parent, ids) {
  if (!ids.length) return;
  const gp = parent.parent && nodes.get(parent.parent);
  const base = gp ? Math.atan2(parent.y - gp.y, parent.x - gp.x) : -Math.PI / 2;
  const spread = parent.id === ROOT ? Math.PI * 2 * (ids.length - 1) / ids.length : Math.PI;
  const start = base - spread / 2;
  const step = ids.length > 1 ? spread / (ids.length - 1) : 0;
  ids.forEach((id, i) => {
    const p = place(parent, start + step * i);
    addNode(id, parent.id, p.x, p.y);
  });
}

function tooClose(x, y) {
  for (const n of nodes.values()) if (Math.hypot(n.x - x, n.y - y) < MIN_GAP) return true;
  return false;
}

function place(parent, angle) {
  for (let i = 0; i < 40; i++) {
    const a = angle + Math.ceil(i / 2) * 0.26 * (i % 2 ? 1 : -1);
    const r = RADIUS + Math.floor(i / 8) * 34;
    const x = parent.x + Math.cos(a) * r, y = parent.y + Math.sin(a) * r;
    if (!tooClose(x, y)) return { x, y };
  }
  return { x: parent.x + Math.cos(angle) * RADIUS * 2, y: parent.y + Math.sin(angle) * RADIUS * 2 };
}

function hopsFrom(start) {
  const adj = new Map();
  for (const e of edges) {
    (adj.get(e.a) || adj.set(e.a, []).get(e.a)).push(e.b);
    (adj.get(e.b) || adj.set(e.b, []).get(e.b)).push(e.a);
  }
  const hops = new Map([[start, 0]]);
  const prev = new Map();
  const q = [start];
  while (q.length) {
    const cur = q.shift();
    for (const nx of adj.get(cur) || []) {
      if (hops.has(nx)) continue;
      hops.set(nx, hops.get(cur) + 1);
      prev.set(nx, cur);
      q.push(nx);
    }
  }
  return { hops, prev };
}

// Ogni cambio di focus: nuova profondità bersaglio per tutti.
function retarget() {
  const { hops } = hopsFrom(focusId);
  for (const n of nodes.values()) n.th = Math.min(hops.get(n.id) ?? 4, 4);
}

// ─── DOM: stesso markup di dna-view.js::nodeButton/nodeInner ─────────────────

function initials(name) {
  return name.trim().split(/\s+/).map(w => w[0]).join("").slice(0, 2).toUpperCase();
}

function nodeInner(id) {
  const t = type(id), d = NODES[id];
  if (t === "persona") return avatarHtml(d.label, 52);
  if (t === "film") return `<span class="dna-node__poster" style="background-image:url('${POSTER}${d.poster}')"></span>`;
  if (t === "regista") return `<span class="dna-node__director">${escapeHtml(initials(d.label))}</span>`;
  if (t === "attore") return `<span class="dna-node__actor">${escapeHtml(initials(d.label))}</span>`;
  return `<span class="dna-node__genre">${escapeHtml(d.label.slice(0, 3).toUpperCase())}</span>`;
}

function ensureDom(n) {
  if (n.dom) return;
  const b = document.createElement("button");
  b.type = "button";
  b.className = `dna-node dna-node--${type(n.id)}`;
  b.dataset.node = n.id;
  b.setAttribute("aria-label", NODES[n.id].label);
  b.innerHTML = `${nodeInner(n.id)}<span class="dna-node__label">${escapeHtml(NODES[n.id].label)}</span>`;
  nodesEl.appendChild(b);
  n.dom = b;
}

function ensureEdgeDom(e) {
  if (e.dom) return;
  e.dom = document.createElementNS("http://www.w3.org/2000/svg", "line");
  e.dom.setAttribute("class", `dna-edge dna-edge--${e.kind}`);
  edgesEl.appendChild(e.dom);
}

// Classi di stato (focus, radice, aperto): le stesse del DNA.
function refreshUi() {
  for (const n of nodes.values()) {
    ensureDom(n);
    n.dom.classList.toggle("is-focus", n.id === focusId);
    n.dom.classList.toggle("is-root", n.id === ROOT);
    n.dom.classList.toggle("is-open", n.expanded);
  }
  for (const e of edges) {
    ensureEdgeDom(e);
    e.dom.classList.toggle("is-focus", e.a === focusId || e.b === focusId);
  }
  el("labHint").classList.toggle("hidden", nodes.size > 1);
  renderCrumbs();
  renderPanel();
}

function renderCrumbs() {
  const { prev } = hopsFrom(ROOT);
  const path = [focusId];
  while (prev.has(path[0])) path.unshift(prev.get(path[0]));
  el("labCrumbs").innerHTML = path.map((id, i) =>
    `${i ? `<span class="lab-crumb-sep">›</span>` : ""}<button type="button" class="lab-crumb${id === focusId ? " is-here" : ""}" data-go="${escapeHtml(id)}">${escapeHtml(NODES[id].label)}</button>`
  ).join("");
  el("labCrumbs").lastElementChild?.scrollIntoView({ inline: "end", block: "nearest" });
}

function renderPanel() {
  const n = nodes.get(focusId), d = NODES[focusId], t = type(focusId);
  const vicini = (ADJ.get(focusId) || []).length;
  const icon = t === "persona" ? avatarHtml(d.label, 30)
    : t === "film" ? "" : `<span class="dna-chip dna-chip--${t}">${escapeHtml(t === "genere" ? d.label.slice(0, 3).toUpperCase() : initials(d.label))}</span>`;
  const tipo = { persona: "Persona", film: "Film", genere: "Genere", regista: "Regista", attore: "Attore" }[t];
  el("labPanel").innerHTML = `
    <div class="dna-panel__head">${icon}<strong>${escapeHtml(d.label)}${d.year ? ` (${d.year})` : ""}</strong></div>
    <p class="dna-panel__line">${tipo} · ${vicini} collegamenti (dati fittizi)</p>
    <span class="dna-panel__hint">${n.expanded ? "Toccalo di nuovo per richiudere" : "Toccalo per aprire i collegamenti"}</span>`;
}

// ─── CAMERA ──────────────────────────────────────────────────────────────────

const lerpTable = (tab, h) => {
  const i = Math.max(0, Math.min(tab.length - 1, h));
  const lo = Math.floor(i), hi = Math.min(tab.length - 1, lo + 1);
  return tab[lo] + (tab[hi] - tab[lo]) * (i - lo);
};
const depthOf = (h) => (depthOn ? lerpTable(DEPTH, h) : 0);
const focusPlane = () => depthOf(0);
const scaleAt = (z) => F / Math.max(1, F + z - cam.z);

// Dove va la camera dopo un tocco: sul nodo, o sul riquadro nodo + figli nuovi
// (come il DNA, spostamento limitato a un raggio).
function aimAt(id, newIds = []) {
  const f = nodes.get(id);
  let minX = f.x, maxX = f.x, minY = f.y, maxY = f.y;
  for (const nid of newIds) {
    const n = nodes.get(nid);
    minX = Math.min(minX, n.x); maxX = Math.max(maxX, n.x);
    minY = Math.min(minY, n.y); maxY = Math.max(maxY, n.y);
  }
  const clamp = (v, c) => Math.max(c - RADIUS, Math.min(c + RADIUS, v));
  cam.tx = clamp((minX + maxX) / 2, f.x);
  cam.ty = clamp((minY + maxY) / 2, f.y);
  cam.tz = 0;
  cam.vx = cam.vy = 0;
}

function panBounds() {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const n of nodes.values()) {
    minX = Math.min(minX, n.x); maxX = Math.max(maxX, n.x);
    minY = Math.min(minY, n.y); maxY = Math.max(maxY, n.y);
  }
  return { minX: minX - 60, maxX: maxX + 60, minY: minY - 60, maxY: maxY + 60 };
}

function clampCam() {
  const b = panBounds();
  cam.tx = Math.max(b.minX, Math.min(b.maxX, cam.tx));
  cam.ty = Math.max(b.minY, Math.min(b.maxY, cam.ty));
}

// ─── LOOP DI ANIMAZIONE (gira solo mentre qualcosa si muove) ─────────────────

let raf = 0, last = 0, pointersDown = 0;
let fpsFrames = 0, fpsT0 = 0;

function kick() { if (!raf) { last = performance.now(); fpsT0 = last; fpsFrames = 0; raf = requestAnimationFrame(frame); } }

function approach(cur, target, dt, tau) { return cur + (target - cur) * (1 - Math.exp(-dt / tau)); }

function frame(now) {
  const dt = Math.min(48, now - last);
  last = now;
  let moving = pointersDown > 0;

  // Inerzia leggera dopo il rilascio.
  if (!pointersDown && (Math.abs(cam.vx) + Math.abs(cam.vy) > 0.002)) {
    cam.tx += cam.vx * dt; cam.ty += cam.vy * dt;
    const k = Math.exp(-dt / 260);
    cam.vx *= k; cam.vy *= k;
    clampCam();
    moving = true;
  }

  const ease = (key, tkey, tau, eps) => {
    const v = approach(cam[key], cam[tkey], dt, tau);
    if (Math.abs(v - cam[tkey]) > eps) moving = true;
    cam[key] = Math.abs(v - cam[tkey]) > eps ? v : cam[tkey];
  };
  ease("x", "tx", pointersDown ? 30 : 120, 0.05);
  ease("y", "ty", pointersDown ? 30 : 120, 0.05);
  ease("z", "tz", 90, 0.1);
  if (!pointersDown) { cam.tyaw = 0; cam.tpitch = 0; }
  ease("yaw", "tyaw", 160, 0.0005);
  ease("pitch", "tpitch", 160, 0.0005);

  for (const n of nodes.values()) {
    const h = approach(n.h, n.th, dt, 140);
    n.h = Math.abs(h - n.th) > 0.002 ? h : n.th;
    const g = approach(n.grow, 1, dt, 120);
    n.grow = 1 - g < 0.002 ? 1 : g;
    if (n.h !== n.th || n.grow !== 1) moving = true;
  }

  draw();

  fpsFrames++;
  if (now - fpsT0 > 500) {
    el("labFps").textContent = `${Math.round(fpsFrames * 1000 / (now - fpsT0))} fps`;
    fpsFrames = 0; fpsT0 = now;
  }

  raf = moving ? requestAnimationFrame(frame) : 0;
}

// Proiezione: camera sul piano del nodo attivo, scena ruotata di pochi gradi
// attorno a quel piano (inclinazione), poi prospettiva semplice.
function project(n) {
  const p = n.parent && nodes.get(n.parent);
  const e = 1 - Math.pow(1 - n.grow, 3);
  const wx = p ? p.x + (n.x - p.x) * e : n.x;
  const wy = p ? p.y + (n.y - p.y) * e : n.y;
  let dx = wx - cam.x, dy = wy - cam.y, dz = depthOf(n.h) - focusPlane();
  if (cam.yaw) {
    const c = Math.cos(cam.yaw), s = Math.sin(cam.yaw);
    [dx, dz] = [dx * c + dz * s, -dx * s + dz * c];
  }
  if (cam.pitch) {
    const c = Math.cos(cam.pitch), s = Math.sin(cam.pitch);
    [dy, dz] = [dy * c + dz * s, -dy * s + dz * c];
  }
  const z = focusPlane() + dz;
  const s = scaleAt(z);
  return { x: W / 2 + dx * s, y: H * 0.47 + dy * s, s, z };
}

function draw() {
  const proj = new Map();
  for (const n of nodes.values()) {
    const p = project(n);
    proj.set(n.id, p);
    const o = lerpTable(OPAC, n.h) * Math.min(1, n.grow * 1.6);
    n.dom.style.setProperty("--t", `translate3d(${p.x.toFixed(1)}px,${p.y.toFixed(1)}px,0) translate(-50%,-50%) scale(${p.s.toFixed(3)})`);
    n.dom.style.opacity = o.toFixed(3);
    n.dom.style.zIndex = String(2000 - Math.round(p.z));
    n.dom.classList.toggle("no-label", p.s < LABEL_MIN_SCALE);
  }
  for (const e of edges) {
    const a = proj.get(e.a), b = proj.get(e.b);
    if (!a || !b) continue;
    const na = nodes.get(e.a), nb = nodes.get(e.b);
    const focus = e.a === focusId || e.b === focusId;
    e.dom.setAttribute("x1", a.x.toFixed(1)); e.dom.setAttribute("y1", a.y.toFixed(1));
    e.dom.setAttribute("x2", b.x.toFixed(1)); e.dom.setAttribute("y2", b.y.toFixed(1));
    e.dom.style.strokeWidth = ((focus ? 4 : 2.6) * Math.min(a.s, b.s)).toFixed(2);
    e.dom.style.opacity = (lerpTable(OPAC, Math.max(na.h, nb.h)) * Math.min(na.grow, nb.grow)).toFixed(3);
  }
}

// ─── INPUT ───────────────────────────────────────────────────────────────────

function onTapNode(id) {
  const n = nodes.get(id);
  let added = [];
  if (id === focusId) {
    if (n.expanded) collapse(id);
    else added = expand(id);
  } else if (!n.expanded) {
    added = expand(id);
  }
  focusId = id;
  retarget();
  aimAt(id, added);
  refreshUi();
  kick();
}

nodesEl.addEventListener("click", e => {
  const b = e.target.closest(".dna-node");
  if (!b || dragged) return;
  onTapNode(b.dataset.node);
});

el("labCrumbs").addEventListener("click", e => {
  const b = e.target.closest("[data-go]");
  if (!b || !nodes.has(b.dataset.go)) return;
  focusId = b.dataset.go;
  retarget();
  aimAt(focusId);
  refreshUi();
  kick();
});

// Un dito: camera (con parallax e inclinazione). Due dita: profondità.
const pts = new Map();
let gesture = null;

stage.addEventListener("pointerdown", e => {
  if (e.button > 0) return;
  pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
  pointersDown = pts.size;
  if (pts.size === 1) {
    dragged = false;
    gesture = { mode: "pan", x0: e.clientX, y0: e.clientY, cx: cam.tx, cy: cam.ty, lx: e.clientX, ly: e.clientY, lt: performance.now() };
    cam.vx = cam.vy = 0;
  } else if (pts.size === 2) {
    const [p, q] = [...pts.values()];
    dragged = true;
    gesture = { mode: "pinch", d0: Math.hypot(p.x - q.x, p.y - q.y) || 1, z0: cam.tz };
    try { stage.setPointerCapture(e.pointerId); } catch {}
  }
  kick();
});

stage.addEventListener("pointermove", e => {
  if (!pts.has(e.pointerId) || !gesture) return;
  pts.set(e.pointerId, { x: e.clientX, y: e.clientY });

  if (gesture.mode === "pinch" && pts.size >= 2) {
    const [p, q] = [...pts.values()];
    const d = Math.hypot(p.x - q.x, p.y - q.y);
    cam.tz = Math.max(Z_MIN, Math.min(Z_MAX, gesture.z0 + (d / gesture.d0 - 1) * F * 0.9));
    kick();
    return;
  }
  if (gesture.mode !== "pan") return;

  const dx = e.clientX - gesture.x0, dy = e.clientY - gesture.y0;
  if (!dragged) {
    if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    dragged = true;
    try { stage.setPointerCapture(e.pointerId); } catch {}
  }
  // Il piano del nodo attivo segue il dito 1:1; i piani dietro scorrono più
  // piano da soli, per la prospettiva: è quello il parallax.
  const s = scaleAt(focusPlane());
  cam.tx = gesture.cx - dx / s;
  cam.ty = gesture.cy - dy / s;
  clampCam();

  const now = performance.now(), dtm = Math.max(1, now - gesture.lt);
  const vxs = (e.clientX - gesture.lx) / dtm, vys = (e.clientY - gesture.ly) / dtm;
  cam.vx = cam.vx * 0.6 + (-vxs / s) * 0.4;
  cam.vy = cam.vy * 0.6 + (-vys / s) * 0.4;
  if (tiltOn) {
    cam.tyaw = Math.max(-MAX_TILT, Math.min(MAX_TILT, -vxs * 0.09));
    cam.tpitch = Math.max(-MAX_TILT, Math.min(MAX_TILT, vys * 0.09));
  }
  gesture.lx = e.clientX; gesture.ly = e.clientY; gesture.lt = now;
  kick();
});

function endPointer(e) {
  if (!pts.has(e.pointerId)) return;
  pts.delete(e.pointerId);
  try { stage.releasePointerCapture(e.pointerId); } catch {}
  pointersDown = pts.size;
  if (pts.size === 1 && gesture?.mode === "pinch") {
    // Da due dita a una: si riprende il trascinamento da dov'è il dito.
    const [p] = [...pts.values()];
    gesture = { mode: "pan", x0: p.x, y0: p.y, cx: cam.tx, cy: cam.ty, lx: p.x, ly: p.y, lt: performance.now() };
    cam.vx = cam.vy = 0;
  } else if (!pts.size) {
    gesture = null;
    // Il click arriva dopo il pointerup: il flag deve sopravvivere fino a lì.
    if (dragged) setTimeout(() => { dragged = false; }, 0);
  }
  kick();
}
stage.addEventListener("pointerup", endPointer);
stage.addEventListener("pointercancel", endPointer);

stage.addEventListener("wheel", e => {
  e.preventDefault();
  cam.tz = Math.max(Z_MIN, Math.min(Z_MAX, cam.tz - e.deltaY * 0.6));
  kick();
}, { passive: false });

// ─── INTERRUTTORI DI CONFRONTO ───────────────────────────────────────────────

function bindToggle(id, get, set) {
  const b = el(id);
  b.addEventListener("click", () => {
    set(!get());
    b.classList.toggle("is-on", get());
    b.setAttribute("aria-pressed", get() ? "true" : "false");
    kick();
  });
}
bindToggle("labDepth", () => depthOn, v => { depthOn = v; });
bindToggle("labTilt", () => tiltOn, v => { tiltOn = v; });
el("labReset").addEventListener("click", reset);

function measure() {
  W = stage.clientWidth;
  H = stage.clientHeight;
  kick();
}
window.addEventListener("resize", measure);
measure();
reset();
