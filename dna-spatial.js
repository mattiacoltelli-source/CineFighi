// ─── dna-spatial.js ──────────────────────────────────────────────────────────
// La vista "Spaziale" del DNA, alternativa a quella piatta di dna-view.js
// (interruttore Piatto/Spaziale nel riquadro). Disegna la STESSA rete — stessi
// nodi aperti, stesse posizioni, stesso nodo attivo, stesso markup dei nodi —
// cambia solo come la si guarda e la si attraversa. Nata come esperimento in
// lab/ (branch separato), Step 1-4.
//
// L'idea in breve:
//   - profondità = distanza in salti dal nodo attivo (la stessa che la vista
//     piatta usa solo per l'opacità): il nodo attivo davanti, i vicini subito
//     dietro, il resto più piccolo e lontano;
//   - "nebbia di distanza": a zoom normale si vede la propria zona, quello che
//     è più lontano svanisce nella profondità e ricompare avvicinandosi;
//   - toccare un nodo: la camera ci vola sopra e la rete si riordina attorno;
//   - trascinare: parallax (i piani lontani scorrono più piano) e una lieve
//     inclinazione; pinch: avanti/indietro nella profondità;
//   - doppio tocco sul vuoto: panoramica di tutta la rete aperta, con la
//     profondità appiattita come una mappa; di nuovo per tornare nella zona.
//
// Niente librerie: una proiezione prospettica calcolata a mano, applicata con
// transform/opacity, solo mentre qualcosa si muove, scrivendo nel DOM solo ciò
// che cambia (misurato: ~45-55 fps con CPU 4x più lenta e 50-110 nodi).
// Tutta la logica di "chi si collega a chi" resta in dna.js; aprire e
// richiudere resta in dna-view.js (onTap).

import { hopsFrom } from "./dna.js?v=ca2c25f";

const F = 560;                               // focale: più bassa = prospettiva più forte
// z per 0,1,2,3,4+ salti dal nodo attivo. Il nodo attivo e i suoi vicini
// stanno sul piano z=0, cioè a scala 1: grandi esattamente come nella vista
// piatta (stesso nodo, stesse distanze). La profondità comincia dai nodi a 2
// salti, quelli che devono sembrare più lontani.
const DEPTH = [0, 0, 200, 380, 540];
const OPAC = [1, 1, .6, .34, .2];            // = .dna-h0..h4: panoramica e rete piatta
const OPAC_ZONA = [1, 1, .5, .1, 0];         // a zoom normale: la tua zona, il resto nella nebbia
const FOG_Z = 380;                           // quanto allontanarsi per diradare la nebbia
const FLATTEN = 0.75;                        // in panoramica la profondità si appiattisce di tanto
const LABEL_MIN_SCALE = .62;                 // sotto, l'etichetta sarebbe illeggibile
const Z_MIN = -1500, Z_MAX = 170;
const MAX_TILT = 0.14;                       // ~8°
const DRAG_THRESHOLD = 8;                    // come la vista piatta
const CULL_MARGIN = 90;

const lerpTable = (tab, h) => {
  const i = Math.max(0, Math.min(tab.length - 1, h));
  const lo = Math.floor(i), hi = Math.min(tab.length - 1, lo + 1);
  return tab[lo] + (tab[hi] - tab[lo]) * (i - lo);
};
const approach = (cur, target, dt, tau) => cur + (target - cur) * (1 - Math.exp(-dt / tau));
const edgeKey = (e) => (e.a < e.b ? `${e.a}|${e.b}` : `${e.b}|${e.a}`);
// Scrive solo se il valore è cambiato dall'ultimo frame.
const setIf = (cache, key, value, write) => { if (cache[key] !== value) { cache[key] = value; write(value); } };

// container: il livello dentro al riquadro (#dnaSpatial).
// nodeShell(n) -> { cls, html }: classi fisse e contenuto del nodo, dalla
//   stessa funzione della vista piatta (stesso aspetto).
// edgeClass(e) -> classi dell'arco, idem.
// onTap(id): toccato un nodo (apri/chiudi/seleziona lo decide dna-view).
// onMore(id): toccato il "+N" di un nodo aperto (mostra altri collegamenti).
// radius(): il raggio del ventaglio, per inquadrare i figli appena aperti.
export function createSpatial({ container, nodeShell, edgeClass, onTap, onMore, radius }) {
  const edgesEl = container.querySelector(".dna-spatial__edges");
  const nodesEl = container.querySelector(".dna-spatial__nodes");

  let net = null, focusId = null, active = false;
  const vis = new Map();        // id -> { h, th, grow, dom, cache }
  const edgeDom = new Map();    // "a|b" -> <line>
  const cam = { x: 0, y: 0, z: 0, tx: 0, ty: 0, tz: 0, yaw: 0, pitch: 0, tyaw: 0, tpitch: 0, vx: 0, vy: 0 };
  let W = 0, H = 0;
  let dragged = false;

  // ─── profondità e nebbia ───────────────────────────────────────────────────
  function nebbia() { return Math.max(0, Math.min(1, -cam.z / FOG_Z)); }
  const depthOf = (h) => lerpTable(DEPTH, h) * (1 - FLATTEN * nebbia());
  const focusPlane = () => depthOf(0);
  const scaleAt = (z) => F / Math.max(1, F + z - cam.z);
  const scaleAtCam = (tz) => F / Math.max(1, F + focusPlane() - tz);
  function opacityAt(h) {
    const f = nebbia();
    return lerpTable(OPAC_ZONA, h) * (1 - f) + lerpTable(OPAC, h) * f;
  }

  // ─── allineamento alla rete ────────────────────────────────────────────────
  function clear() {
    vis.clear(); edgeDom.clear();
    nodesEl.innerHTML = ""; edgesEl.innerHTML = "";
    net = null;
  }

  function sync(snap) {
    for (const [id, v] of vis) {
      if (!net.nodes.has(id)) { v.dom.remove(); vis.delete(id); }
    }
    for (const n of net.nodes.values()) {
      if (n.x === null) continue;
      let v = vis.get(n.id);
      if (!v) {
        const parentVis = n.parent && vis.get(n.parent);
        const b = document.createElement("button");
        b.type = "button";
        b.dataset.node = n.id;
        b.setAttribute("aria-label", n.label);
        v = { h: snap || !parentVis ? 4 : parentVis.h, th: 4, grow: snap || !n.parent ? 1 : 0, dom: b, cache: {}, shell: "" };
        vis.set(n.id, v);
        nodesEl.appendChild(b);
      }
      // Contenuto e classi fisse dalla vista piatta (rifatti solo se cambiano:
      // cambiare persone ricostruisce la rete, non i singoli nodi).
      const s = nodeShell(n);
      if (v.shell !== s.cls + s.html) {
        v.shell = s.cls + s.html;
        v.dom.className = s.cls;
        v.dom.innerHTML = s.html;
        v.cache.nl = undefined;
      }
      v.dom.classList.toggle("is-focus", n.id === focusId);
      v.dom.classList.toggle("is-root", n.id === net.rootId);
      v.dom.classList.toggle("is-open", n.expanded);
    }
    const vivi = new Set(net.edges.map(edgeKey));
    for (const [k, line] of edgeDom) if (!vivi.has(k)) { line.remove(); edgeDom.delete(k); }
    for (const e of net.edges) {
      const k = edgeKey(e);
      let line = edgeDom.get(k);
      if (!line) {
        line = document.createElementNS("http://www.w3.org/2000/svg", "line");
        edgesEl.appendChild(line);
        edgeDom.set(k, line);
      }
      const cls = `${edgeClass(e)}${e.a === focusId || e.b === focusId ? " is-focus" : ""}`;
      if (line.getAttribute("class") !== cls) line.setAttribute("class", cls);
    }
    const hops = hopsFrom(net, focusId);
    for (const [id, v] of vis) {
      v.th = Math.min(hops.get(id) ?? 4, 4);
      if (snap) v.h = v.th;
    }
  }

  // ─── camera ────────────────────────────────────────────────────────────────
  // Dopo un tocco: sul nodo, o sul riquadro nodo + figli appena nati (come la
  // vista piatta), spostamento limitato a un raggio.
  function aimAt(id, newIds = []) {
    const f = net.nodes.get(id);
    if (!f || f.x === null) return;
    const r = radius();
    let minX = f.x, maxX = f.x, minY = f.y, maxY = f.y;
    for (const nid of newIds) {
      const n = net.nodes.get(nid);
      if (!n || n.x === null || Math.hypot(n.x - f.x, n.y - f.y) > r * 1.3) continue;
      minX = Math.min(minX, n.x); maxX = Math.max(maxX, n.x);
      minY = Math.min(minY, n.y); maxY = Math.max(maxY, n.y);
    }
    const clamp = (v, c) => Math.max(c - r, Math.min(c + r, v));
    cam.tx = clamp((minX + maxX) / 2, f.x);
    cam.ty = clamp((minY + maxY) / 2, f.y);
    cam.tz = 0;
    cam.vx = cam.vy = 0;
  }

  function bounds() {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const n of net.nodes.values()) {
      if (n.x === null) continue;
      minX = Math.min(minX, n.x); maxX = Math.max(maxX, n.x);
      minY = Math.min(minY, n.y); maxY = Math.max(maxY, n.y);
    }
    return { minX, maxX, minY, maxY };
  }

  function clampCam() {
    const b = bounds();
    cam.tx = Math.max(b.minX - 60, Math.min(b.maxX + 60, cam.tx));
    cam.ty = Math.max(b.minY - 60, Math.min(b.maxY + 60, cam.ty));
  }

  function overview() {
    const b = bounds();
    const sFit = Math.min((W - 24) / (b.maxX - b.minX + 110), (H - 24) / (b.maxY - b.minY + 120), 1);
    cam.tx = (b.minX + b.maxX) / 2;
    cam.ty = (b.minY + b.maxY) / 2;
    // A nebbia diradata il piano del nodo attivo è a z = DEPTH[0] * (1 - FLATTEN).
    cam.tz = Math.max(Z_MIN, Math.min(-FOG_Z, F + DEPTH[0] * (1 - FLATTEN) - F / sFit));
    cam.vx = cam.vy = 0;
  }

  // ─── animazione (gira solo mentre qualcosa si muove) ───────────────────────
  let raf = 0, last = 0, pointersDown = 0;

  function kick() {
    if (!raf && net && active) { last = performance.now(); raf = requestAnimationFrame(frame); }
  }

  function frame(now) {
    raf = 0;
    if (!net || !active) return;
    const dt = Math.min(48, now - last);
    last = now;
    let moving = pointersDown > 0;

    if (!pointersDown && Math.abs(cam.vx) + Math.abs(cam.vy) > 0.002) {   // inerzia leggera
      cam.tx += cam.vx * dt; cam.ty += cam.vy * dt;
      const k = Math.exp(-dt / 260);
      cam.vx *= k; cam.vy *= k;
      clampCam();
      moving = true;
    }
    const ease = (key, tkey, tau, eps) => {
      const v = approach(cam[key], cam[tkey], dt, tau);
      const lontano = Math.abs(v - cam[tkey]) > eps;
      if (lontano) moving = true;
      cam[key] = lontano ? v : cam[tkey];
    };
    ease("x", "tx", pointersDown ? 30 : 120, 0.05);
    ease("y", "ty", pointersDown ? 30 : 120, 0.05);
    ease("z", "tz", 90, 0.1);
    if (!pointersDown) { cam.tyaw = 0; cam.tpitch = 0; }
    ease("yaw", "tyaw", 160, 0.0005);
    ease("pitch", "tpitch", 160, 0.0005);

    for (const v of vis.values()) {
      const h = approach(v.h, v.th, dt, 140);
      v.h = Math.abs(h - v.th) > 0.002 ? h : v.th;
      const g = approach(v.grow, 1, dt, 120);
      v.grow = 1 - g < 0.002 ? 1 : g;
      if (v.h !== v.th || v.grow !== 1) moving = true;
    }

    draw();
    if (moving) raf = requestAnimationFrame(frame);
  }

  function project(n, v) {
    const p = n.parent && net.nodes.get(n.parent);
    const e = 1 - Math.pow(1 - v.grow, 3);            // i nuovi escono dal genitore
    const wx = p && p.x !== null ? p.x + (n.x - p.x) * e : n.x;
    const wy = p && p.y !== null ? p.y + (n.y - p.y) * e : n.y;
    let dx = wx - cam.x, dy = wy - cam.y, dz = depthOf(v.h) - focusPlane();
    if (cam.yaw) {
      const c = Math.cos(cam.yaw), s = Math.sin(cam.yaw);
      [dx, dz] = [dx * c + dz * s, -dx * s + dz * c];
    }
    if (cam.pitch) {
      const c = Math.cos(cam.pitch), s = Math.sin(cam.pitch);
      [dy, dz] = [dy * c + dz * s, -dy * s + dz * c];
    }
    const s = scaleAt(focusPlane() + dz);
    return { x: W / 2 + dx * s, y: H / 2 + dy * s, s };
  }

  function draw() {
    const proj = new Map();
    for (const [id, v] of vis) {
      const n = net.nodes.get(id);
      const p = project(n, v);
      const fuori = p.x < -CULL_MARGIN || p.x > W + CULL_MARGIN || p.y < -CULL_MARGIN || p.y > H + CULL_MARGIN;
      let o = fuori ? 0 : opacityAt(v.h) * Math.min(1, v.grow * 1.6);
      if (o < 0.04) o = 0;   // nella nebbia: né disegnato né toccabile
      p.o = o;
      proj.set(id, p);
      const c = v.cache, st = v.dom.style;
      // display:none e non visibility: ogni nodo ha un suo livello sul
      // compositor, e con 100+ nodi anche quelli invisibili pesano.
      setIf(c, "vis", o ? "" : "none", x => { st.display = x; });
      if (!o) continue;
      setIf(c, "t", `translate3d(${p.x.toFixed(1)}px,${p.y.toFixed(1)}px,0) translate(-50%,-50%) scale(${p.s.toFixed(3)})`, x => { st.transform = x; });
      setIf(c, "o", o.toFixed(2), x => { st.opacity = x; });
      setIf(c, "z", String(10 - Math.round(v.h)), x => { st.zIndex = x; });
      setIf(c, "nl", p.s < LABEL_MIN_SCALE, x => { v.dom.classList.toggle("no-label", x); });
    }
    for (const e of net.edges) {
      const a = proj.get(e.a), b = proj.get(e.b), line = edgeDom.get(edgeKey(e));
      if (!a || !b || !line) continue;
      const c = line.__c || (line.__c = {});
      const va = vis.get(e.a), vb = vis.get(e.b);
      const o = a.o && b.o ? opacityAt(Math.max(va.h, vb.h)) * Math.min(va.grow, vb.grow) : 0;
      setIf(c, "d", o ? "" : "none", x => { line.style.display = x; });
      if (!o) continue;
      const focus = e.a === focusId || e.b === focusId;
      setIf(c, "o", o.toFixed(2), x => { line.style.opacity = x; });
      setIf(c, "x1", a.x.toFixed(1), x => line.setAttribute("x1", x));
      setIf(c, "y1", a.y.toFixed(1), x => line.setAttribute("y1", x));
      setIf(c, "x2", b.x.toFixed(1), x => line.setAttribute("x2", x));
      setIf(c, "y2", b.y.toFixed(1), x => line.setAttribute("y2", x));
      setIf(c, "w", ((focus ? 4 : 2.6) * Math.min(a.s, b.s)).toFixed(1), x => { line.style.strokeWidth = x; });
    }
  }

  // ─── gesti ─────────────────────────────────────────────────────────────────
  nodesEl.addEventListener("click", e => {
    const b = e.target.closest(".dna-node");
    if (!b || dragged || !net) return;
    if (e.target.closest(".dna-node__more")) onMore(b.dataset.node);
    else onTap(b.dataset.node);
  });

  const pts = new Map();
  let gesture = null, ultimoTocco = 0;

  container.addEventListener("pointerdown", e => {
    if (e.button > 0 || !net || !active) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    pointersDown = pts.size;
    if (pts.size === 1) {
      dragged = false;
      gesture = { mode: "pan", x0: e.clientX, y0: e.clientY, cx: cam.tx, cy: cam.ty, lx: e.clientX, ly: e.clientY, lt: performance.now() };
      cam.vx = cam.vy = 0;
    } else if (pts.size === 2) {
      const [p, q] = [...pts.values()];
      dragged = true;
      gesture = { mode: "pinch", d0: Math.hypot(p.x - q.x, p.y - q.y) || 1, s0: scaleAtCam(cam.tz) };
      try { container.setPointerCapture(e.pointerId); } catch {}
    }
    kick();
  });

  container.addEventListener("pointermove", e => {
    if (!pts.has(e.pointerId) || !gesture) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (gesture.mode === "pinch" && pts.size >= 2) {
      // Proporzionale: la rete si ingrandisce quanto si allargano le dita.
      const [p, q] = [...pts.values()];
      const sNew = gesture.s0 * Math.hypot(p.x - q.x, p.y - q.y) / gesture.d0;
      cam.tz = Math.max(Z_MIN, Math.min(Z_MAX, F + focusPlane() - F / Math.max(0.05, sNew)));
      kick();
      return;
    }
    if (gesture.mode !== "pan" || net.nodes.size <= 1) return;

    const dx = e.clientX - gesture.x0, dy = e.clientY - gesture.y0;
    if (!dragged) {
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      dragged = true;
      try { container.setPointerCapture(e.pointerId); } catch {}
    }
    // Il piano del nodo attivo segue il dito 1:1; quelli dietro scorrono più
    // piano da soli, per la prospettiva: è quello il parallax.
    const s = scaleAt(focusPlane());
    cam.tx = gesture.cx - dx / s;
    cam.ty = gesture.cy - dy / s;
    clampCam();

    const now = performance.now(), dtm = Math.max(1, now - gesture.lt);
    const vxs = (e.clientX - gesture.lx) / dtm, vys = (e.clientY - gesture.ly) / dtm;
    cam.vx = cam.vx * 0.6 + (-vxs / s) * 0.4;
    cam.vy = cam.vy * 0.6 + (-vys / s) * 0.4;
    cam.tyaw = Math.max(-MAX_TILT, Math.min(MAX_TILT, -vxs * 0.09));
    cam.tpitch = Math.max(-MAX_TILT, Math.min(MAX_TILT, vys * 0.09));
    gesture.lx = e.clientX; gesture.ly = e.clientY; gesture.lt = now;
    kick();
  });

  // Doppio tocco sul vuoto: panoramica, e di nuovo per tornare nella zona.
  function doppioTocco() {
    const now = performance.now();
    if (now - ultimoTocco >= 320) { ultimoTocco = now; return; }
    ultimoTocco = 0;
    if (cam.tz < -FOG_Z / 2) aimAt(focusId);
    else overview();
    kick();
  }

  function endPointer(e) {
    if (!pts.has(e.pointerId)) return;
    pts.delete(e.pointerId);
    try { container.releasePointerCapture(e.pointerId); } catch {}
    pointersDown = pts.size;
    if (pts.size === 1 && gesture?.mode === "pinch") {
      const [p] = [...pts.values()];
      gesture = { mode: "pan", x0: p.x, y0: p.y, cx: cam.tx, cy: cam.ty, lx: p.x, ly: p.y, lt: performance.now() };
      cam.vx = cam.vy = 0;
    } else if (!pts.size) {
      gesture = null;
      // Il click arriva dopo il pointerup: il flag deve sopravvivere fino a lì.
      if (dragged) setTimeout(() => { dragged = false; }, 0);
      else if (!e.target.closest(".dna-node") && net.nodes.size > 1) doppioTocco();
    }
    kick();
  }
  container.addEventListener("pointerup", endPointer);
  container.addEventListener("pointercancel", endPointer);

  container.addEventListener("wheel", e => {
    if (!net || !active) return;
    e.preventDefault();
    const sNew = scaleAtCam(cam.tz) * Math.exp(-e.deltaY * 0.0015);
    cam.tz = Math.max(Z_MIN, Math.min(Z_MAX, F + focusPlane() - F / sNew));
    kick();
  }, { passive: false });

  // Schermo intero, rotazione: il riquadro cambia misura.
  const measure = () => { W = container.clientWidth; H = container.clientHeight; kick(); };
  if (typeof ResizeObserver === "function") new ResizeObserver(measure).observe(container);
  else window.addEventListener("resize", measure);

  return {
    // Ridisegna la rete di dna-view. newIds: i nodi appena aperti (la camera
    // li inquadra e loro escono dal genitore).
    update(nextNet, nextFocusId, newIds = null) {
      const nuova = nextNet !== net;
      if (nuova) clear();
      const snap = nuova || !vis.size;
      net = nextNet;
      focusId = nextFocusId;
      measure();
      sync(snap);
      if (snap) {
        const f = net.nodes.get(focusId);
        Object.assign(cam, { x: f.x, y: f.y, z: 0, tx: f.x, ty: f.y, tz: 0, yaw: 0, pitch: 0, tyaw: 0, tpitch: 0, vx: 0, vy: 0 });
      }
      aimAt(focusId, newIds || []);
      if (snap) { cam.x = cam.tx; cam.y = cam.ty; draw(); }
      kick();
    },
    show() { active = true; container.classList.remove("hidden"); measure(); },
    // Nascosta si svuota: tornando a Spaziale riparte allineata alla rete,
    // senza tenere in memoria un DOM che nessuno vede.
    hide() { active = false; container.classList.add("hidden"); clear(); },
    clear
  };
}
