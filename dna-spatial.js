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

const F_BASE = 560;                          // focale: più bassa = prospettiva più forte
const F_ORBIT = 1400;                        // in orbita la prospettiva è più dolce: a 60° i nodi vicini non esplodono
const S_MAX_ORBIT = 1.45;                    // e nessun nodo diventa più di così più grande di com'è (altrimenti copre gli altri)
let F = F_BASE;
// z per 0,1,2,3,4+ salti dal nodo attivo. Il nodo attivo e i suoi vicini
// stanno sul piano z=0, cioè a scala 1: grandi esattamente come nella vista
// piatta (stesso nodo, stesse distanze). La profondità comincia dai nodi a 2
// salti, quelli che devono sembrare più lontani.
const DEPTH = [0, 0, 200, 380, 540];
// LABORATORIO 3D: in orbita la profondità per salto è più larga, così girando
// la scena i livelli si vedono davvero. Il piano 0 (nodo attivo e vicini) resta
// a scala 1 come nella vista Spaziale.
const DEPTH_ORBIT = [0, 0, 260, 480, 680];
const PITCH_MAX = 1.25;                      // ~72°: oltre, la rete si vedrebbe di taglio
const ORBIT_K = 0.008;                       // radianti per pixel di trascinamento (~0,46°)
const NEAR = 140;                            // sotto questa distanza un nodo è "dietro la camera"
// LABORATORIO 3D "Sfera": i collegamenti di un nodo si dispongono su una sfera
// (un po' schiacciata in profondità) attorno a lui, dalla parte opposta al
// nodo da cui si arriva. Le posizioni sono SOLO per la vista 3D: la rete vera
// (node.x/node.y) resta quella di sempre, e le altre viste non cambiano.
const N_DIREZIONI = 72;                      // direzioni candidate sulla sfera
const Z_SCHIACCIATA = 0.8;                   // la profondità è l'80% del raggio: meno nodi uno sull'altro
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
  let orbit = false;            // laboratorio 3D: un dito ruota la scena
  let sfera = false;            // laboratorio 3D: posizioni sulla sfera invece che sul piano
  const pos3 = new Map();       // id -> { x, y, z }: posizioni della vista Sfera
  const vis = new Map();        // id -> { h, th, grow, dom, cache }
  const edgeDom = new Map();    // "a|b" -> <line>
  const cam = { x: 0, y: 0, z: 0, tx: 0, ty: 0, tz: 0, cz: 0, tcz: 0, yaw: 0, pitch: 0, tyaw: 0, tpitch: 0, vx: 0, vy: 0 };
  let W = 0, H = 0;
  let dragged = false;

  // ─── profondità e nebbia ───────────────────────────────────────────────────
  function nebbia() { return Math.max(0, Math.min(1, -cam.z / FOG_Z)); }
  const depthOf = (h) => lerpTable(orbit ? DEPTH_ORBIT : DEPTH, h) * (1 - FLATTEN * nebbia());
  const focusPlane = () => depthOf(0);
  const scaleAt = (z) => F / Math.max(1, F + z - cam.z);
  const scaleAtCam = (tz) => F / Math.max(1, F + focusPlane() - tz);
  function opacityAt(h) {
    const f = nebbia();
    return lerpTable(OPAC_ZONA, h) * (1 - f) + lerpTable(OPAC, h) * f;
  }

  // ─── allineamento alla rete ────────────────────────────────────────────────
  function clear() {
    vis.clear(); edgeDom.clear(); pos3.clear();
    nodesEl.innerHTML = ""; edgesEl.innerHTML = "";
    net = null;
  }

  // ─── disposizione sferica ──────────────────────────────────────────────────
  // Ogni nodo nuovo va nella direzione (fra N_DIREZIONI, sull'emisfero lontano dal
  // nodo da cui si arriva) che lo tiene più lontano da tutti gli altri: niente
  // casualità, e un nodo piazzato non si muove più. Si riparte sempre dall'ordine
  // di creazione dei nodi, quindi cambiare vista e tornare dà lo stesso risultato.
  const DIREZIONI = Array.from({ length: N_DIREZIONI }, (_, i) => {
    const y = 1 - 2 * (i + 0.5) / N_DIREZIONI, r = Math.sqrt(1 - y * y), a = i * 2.399963229728653;
    return [Math.cos(a) * r, y, Math.sin(a) * r];
  });

  function layout3d() {
    if (!pos3.has(net.rootId)) pos3.set(net.rootId, { x: 0, y: 0, z: 0 });
    const R = radius();
    for (const n of net.nodes.values()) {
      if (pos3.has(n.id)) continue;
      const pp = pos3.get(n.parent) || pos3.get(net.rootId);
      const gp = n.parent ? pos3.get(net.nodes.get(n.parent)?.parent) : null;
      let fuori = null;
      if (gp) {
        const ox = pp.x - gp.x, oy = pp.y - gp.y, oz = pp.z - gp.z, l = Math.hypot(ox, oy, oz) || 1;
        fuori = [ox / l, oy / l, oz / l];
      }
      let best = null, bestD = -1;
      for (const d of DIREZIONI) {
        if (fuori && d[0] * fuori[0] + d[1] * fuori[1] + d[2] * fuori[2] < -0.1) continue;
        const x = pp.x + d[0] * R, y = pp.y + d[1] * R, z = pp.z + d[2] * R * Z_SCHIACCIATA;
        let m = Infinity;
        for (const q of pos3.values()) { const dd = Math.hypot(q.x - x, q.y - y, q.z - z); if (dd < m) m = dd; }
        if (m > bestD) { bestD = m; best = { x, y, z }; }
      }
      pos3.set(n.id, best || { x: pp.x + R, y: pp.y, z: pp.z });
    }
  }

  // Dopo un cambio di modalità le coordinate della camera cambiano significato
  // (piano <-> sfera): si riparte dal nodo attivo.
  function risistema() {
    if (!net) return;
    if (sfera) layout3d();
    aimAt(focusId);
    cam.x = cam.tx; cam.y = cam.ty; cam.cz = cam.tcz; cam.z = cam.tz = 0;
  }

  function sync(snap) {
    if (sfera) layout3d();
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
    if (sfera) {
      // Il centro dell'inquadratura è il nodo attivo, spostato verso i figli
      // appena nati ma al massimo di mezzo raggio.
      layout3d();
      const q = pos3.get(id);
      if (!q) return;
      let sx = 0, sy = 0, sz = 0, k = 0;
      for (const nid of newIds) { const m = pos3.get(nid); if (m) { sx += m.x - q.x; sy += m.y - q.y; sz += m.z - q.z; k++; } }
      if (k) { sx /= k + 1; sy /= k + 1; sz /= k + 1; }
      const l = Math.hypot(sx, sy, sz), cap = r * 0.5, f2 = l > cap ? cap / l : 1;
      cam.tx = q.x + sx * f2; cam.ty = q.y + sy * f2; cam.tcz = q.z + sz * f2;
      cam.tz = 0; cam.vx = cam.vy = 0;
      return;
    }
    cam.tcz = 0;
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
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
    if (sfera) {
      for (const q of pos3.values()) {
        minX = Math.min(minX, q.x); maxX = Math.max(maxX, q.x);
        minY = Math.min(minY, q.y); maxY = Math.max(maxY, q.y);
        minZ = Math.min(minZ, q.z); maxZ = Math.max(maxZ, q.z);
      }
      return { minX, maxX, minY, maxY, minZ, maxZ };
    }
    for (const n of net.nodes.values()) {
      if (n.x === null) continue;
      minX = Math.min(minX, n.x); maxX = Math.max(maxX, n.x);
      minY = Math.min(minY, n.y); maxY = Math.max(maxY, n.y);
    }
    return { minX, maxX, minY, maxY, minZ: 0, maxZ: 0 };
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
    cam.tcz = (b.minZ + b.maxZ) / 2;
    // A nebbia diradata il piano del nodo attivo è a z = DEPTH[0] * (1 - FLATTEN).
    cam.tz = Math.max(Z_MIN, Math.min(-FOG_Z, F + DEPTH[0] * (1 - FLATTEN) - F / sFit));
    cam.vx = cam.vy = 0;
    if (orbit) { cam.tyaw = giroPiuVicino(cam.tyaw); cam.tpitch = 0; }   // la panoramica è una mappa: di fronte
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
    ease("cz", "tcz", pointersDown ? 30 : 120, 0.05);
    if (!pointersDown && !orbit) { cam.tyaw = 0; cam.tpitch = 0; }
    const tauRot = orbit && pointersDown ? 45 : 160;   // in orbita segue il dito da vicino
    ease("yaw", "tyaw", tauRot, 0.0005);
    ease("pitch", "tpitch", tauRot, 0.0005);

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
    let wx, wy, dz;
    if (sfera) {
      const q = pos3.get(n.id), pq = p && pos3.get(p.id);
      if (!q) return { x: 0, y: 0, s: 0, z: 0, dietro: true };
      wx = pq ? pq.x + (q.x - pq.x) * e : q.x;
      wy = pq ? pq.y + (q.y - pq.y) * e : q.y;
      dz = (pq ? pq.z + (q.z - pq.z) * e : q.z) - cam.cz;      // la profondità è la posizione vera
    } else {
      wx = p && p.x !== null ? p.x + (n.x - p.x) * e : n.x;
      wy = p && p.y !== null ? p.y + (n.y - p.y) * e : n.y;
      dz = depthOf(v.h) - focusPlane();
    }
    let dx = wx - cam.x, dy = wy - cam.y;
    if (cam.yaw) {
      const c = Math.cos(cam.yaw), s = Math.sin(cam.yaw);
      [dx, dz] = [dx * c + dz * s, -dx * s + dz * c];
    }
    if (cam.pitch) {
      const c = Math.cos(cam.pitch), s = Math.sin(cam.pitch);
      [dy, dz] = [dy * c + dz * s, -dy * s + dz * c];
    }
    const z = (sfera ? 0 : focusPlane()) + dz;
    const denom = F + z - cam.z;
    if (denom < NEAR) return { x: 0, y: 0, s: 0, z, dietro: true };   // dietro la camera
    const s = F / denom;
    // La posizione segue la prospettiva piena; la GRANDEZZA del nodo ha un tetto
    // in orbita: un nodo molto vicino non deve coprire quelli attorno.
    return { x: W / 2 + dx * s, y: H / 2 + dy * s, s: orbit ? Math.min(s, S_MAX_ORBIT) : s, z };
  }

  function draw() {
    const proj = new Map();
    for (const [id, v] of vis) {
      const n = net.nodes.get(id);
      const p = project(n, v);
      const fuori = p.dietro || p.x < -CULL_MARGIN || p.x > W + CULL_MARGIN || p.y < -CULL_MARGIN || p.y > H + CULL_MARGIN;
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
      // Ordine di sovrapposizione per profondità vera (anche ruotando), non per
      // salto: più lontano = sotto.
      setIf(c, "z", String(Math.max(1, 5000 - Math.round(p.z))), x => { st.zIndex = x; });
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
    aggiornaFrontale();
  }

  // "Frontale": compare solo in orbita, quando la scena è girata.
  const frontBtn = container.querySelector(".dna-spatial__front");
  const giroPiuVicino = (a) => Math.round(a / (2 * Math.PI)) * 2 * Math.PI;
  let frontMostrato = null;
  function aggiornaFrontale() {
    if (!frontBtn) return;
    const girata = orbit && (Math.abs(cam.tyaw - giroPiuVicino(cam.tyaw)) > 0.06 || Math.abs(cam.tpitch) > 0.06);
    if (girata !== frontMostrato) { frontMostrato = girata; frontBtn.classList.toggle("hidden", !girata); }
  }
  frontBtn?.addEventListener("click", () => { cam.tyaw = giroPiuVicino(cam.tyaw); cam.tpitch = 0; kick(); });

  // ─── gesti ─────────────────────────────────────────────────────────────────
  nodesEl.addEventListener("click", e => {
    const b = e.target.closest(".dna-node");
    if (!b || dragged || !net) return;
    if (e.target.closest(".dna-node__more")) onMore(b.dataset.node);
    else onTap(b.dataset.node);
  });

  const pts = new Map();
  let gesture = null, ultimoTocco = 0;

  // Un dito: in orbita ruota la scena attorno al nodo attivo, altrimenti sposta
  // la camera (con parallax e lieve inclinazione, come sempre).
  const nuovoGesto = (x, y) => orbit
    ? { mode: "orbit", x0: x, y0: y, yaw0: cam.tyaw, pitch0: cam.tpitch }
    : { mode: "pan", x0: x, y0: y, cx: cam.tx, cy: cam.ty, lx: x, ly: y, lt: performance.now() };

  container.addEventListener("pointerdown", e => {
    if (e.button > 0 || !net || !active || e.target.closest(".dna-spatial__front")) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    pointersDown = pts.size;
    if (pts.size === 1) {
      dragged = false;
      gesture = nuovoGesto(e.clientX, e.clientY);
      cam.vx = cam.vy = 0;
    } else if (pts.size === 2) {
      const [p, q] = [...pts.values()];
      dragged = true;
      gesture = { mode: "pinch", d0: Math.hypot(p.x - q.x, p.y - q.y) || 1, s0: scaleAtCam(cam.tz),
        mx0: (p.x + q.x) / 2, my0: (p.y + q.y) / 2, tx0: cam.tx, ty0: cam.ty };
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
      if (orbit) {
        // In orbita due dita spostano anche il centro (un dito è occupato a ruotare):
        // approssimato sul piano della rete, meno efficace se la scena è molto girata.
        const sc = scaleAt(focusPlane());
        const mx = (p.x + q.x) / 2, my = (p.y + q.y) / 2;
        cam.tx = gesture.tx0 - (mx - gesture.mx0) / sc * Math.max(0.35, Math.cos(cam.tyaw));
        cam.ty = gesture.ty0 - (my - gesture.my0) / sc * Math.max(0.35, Math.cos(cam.tpitch));
        clampCam();
      }
      kick();
      return;
    }
    if (gesture.mode === "orbit") {
      if (net.nodes.size <= 1) return;   // un nodo solo: niente da girare
      const ox = e.clientX - gesture.x0, oy = e.clientY - gesture.y0;
      if (!dragged) {
        if (Math.hypot(ox, oy) < DRAG_THRESHOLD) return;
        dragged = true;
        try { container.setPointerCapture(e.pointerId); } catch {}
      }
      cam.tyaw = gesture.yaw0 - ox * ORBIT_K;
      cam.tpitch = Math.max(-PITCH_MAX, Math.min(PITCH_MAX, gesture.pitch0 - oy * ORBIT_K));
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
      gesture = nuovoGesto(p.x, p.y);
      cam.vx = cam.vy = 0;
    } else if (!pts.size) {
      gesture = null;
      // Il click arriva dopo il pointerup: il flag deve sopravvivere fino a lì.
      if (dragged) setTimeout(() => { dragged = false; }, 0);
      else if (!e.target.closest(".dna-node, .dna-spatial__front") && net.nodes.size > 1) doppioTocco();
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
        const f = sfera ? (pos3.get(focusId) || { x: 0, y: 0, z: 0 }) : net.nodes.get(focusId);
        const fz = sfera ? f.z : 0;
        Object.assign(cam, { x: f.x, y: f.y, z: 0, cz: fz, tx: f.x, ty: f.y, tz: 0, tcz: fz, yaw: 0, pitch: 0, tyaw: 0, tpitch: 0, vx: 0, vy: 0 });
      }
      aimAt(focusId, newIds || []);
      if (snap) { cam.x = cam.tx; cam.y = cam.ty; cam.cz = cam.tcz; draw(); }
      kick();
    },
    // Laboratorio 3D: attiva/disattiva l'orbita. Lo zoom riparte da zero, perché
    // la focale cambia e la scala di prima non vorrebbe più dire la stessa cosa.
    setModo({ orbita, sfera: sf }) {
      orbit = !!orbita;
      sfera = orbit && !!sf;
      F = orbit ? F_ORBIT : F_BASE;
      cam.z = cam.tz = 0;
      if (!orbit) { cam.tyaw = cam.tpitch = 0; cam.yaw = cam.pitch = 0; }
      for (const v of vis.values()) v.cache = {};
      risistema();
      kick();
    },
    show() { active = true; container.classList.remove("hidden"); measure(); },
    // Nascosta si svuota: tornando a Spaziale riparte allineata alla rete,
    // senza tenere in memoria un DOM che nessuno vede.
    hide() { active = false; container.classList.add("hidden"); clear(); },
    clear
  };
}
