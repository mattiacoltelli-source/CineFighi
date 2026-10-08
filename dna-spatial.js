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

import { hopsFrom } from "./dna.js?v=b166ddb";

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
const NODE_K = 1.4;                          // in orbita la grandezza dei nodi parte da qui (solo la grandezza, non le posizioni)
// La grandezza dei nodi in 3D resta vicina a quella della vista Piatta (1 = com'è
// lì), qualunque sia la profondità o lo zoom per far stare i collegamenti: la
// prospettiva sposta le posizioni, non rimpicciolisce i nodi lontani. Solo
// avvicinandosi con lo zoom i nodi crescono.
const NODE_MIN = 1, NODE_MAX = 1.15, NODE_ZOOM_MAX = 1.8;
const SPIN_TAU = 380;                        // ms: quanto dura la rotazione che continua dopo aver staccato il dito
const ORBIT_K = 0.008;                       // radianti per pixel di trascinamento (~0,46°)
const NEAR = 140;                            // sotto questa distanza un nodo è "dietro la camera"
// LABORATORIO 3D "Sfera": i collegamenti di un nodo si dispongono su una sfera
// (un po' schiacciata in profondità) attorno a lui, dalla parte opposta al
// nodo da cui si arriva. Le posizioni sono SOLO per la vista 3D: la rete vera
// (node.x/node.y) resta quella di sempre, e le altre viste non cambiano.
const N_DIREZIONI = 120;                     // direzioni candidate sulla sfera
const Z_SCHIACCIATA = 1.7;                   // la sfera si allunga in profondità (z) molto più che sullo schermo: è lì che c'è spazio
const PESO_Z = 0.3;                          // quanto conta la distanza in profondità nello scegliere dove mettere un nodo
const OPAC = [1, 1, .6, .34, .2];            // = .dna-h0..h4: panoramica e rete piatta
const OPAC_ZONA = [1, 1, .5, .1, 0];         // a zoom normale: la tua zona, il resto nella nebbia
const FOG_Z = 380;                           // quanto allontanarsi per diradare la nebbia
const FLATTEN = 0.75;                        // in panoramica la profondità si appiattisce di tanto
const LABEL_MIN_SCALE = .62;                 // sotto, l'etichetta sarebbe illeggibile
const Z_MIN = -1500, Z_MAX = 170;
const Z_MAX_ORBIT = 700;                     // in orbita ci si può avvicinare molto: scala fino a ~2,5x (i nodi restano al tetto S_MAX_ORBIT)
const Z_MIN_ORBIT = -3600;                   // in orbita si può allontanarsi molto di più: la veduta d insieme
const MARGINE_X = 94, MARGINE_Y = 175;        // spazio da lasciare ai bordi (e al pannello in basso)
const LONG_MS = 420;                          // tocco lungo su un nodo = ci si vola sopra
const DIP_MAX = 340;                         // quanto si allarga la camera a metà di un volo tra nodi
const RAGGI = [0.9, 1.2, 1.55];             // lunghezze dell'arco provate: il nodo va dove c'è più spazio, anche più lontano
const PESO_LUNGHEZZA = 0.12;                 // piccolo costo per gli archi più lunghi: a parità di spazio vince il più corto
const PESO_BARICENTRO = 0.25;                // quanto i nuovi nodi preferiscono i vuoti vicino al centro della rete
const S_TARGET = 0.8;                        // scala a cui devono stare i collegamenti di un nodo (grandezza quasi normale)
const S_FIT_MIN_PIATTA = 0.4;                 // "3D" usa il layout piatto di dna.js, che non si può comprimere: lì ci si allarga di più
const S_FIT_TUTTI = 0.62;                    // limite dell'allargamento per vedere TUTTI i collegamenti di un nodo
const S_FIT_MIN = 0.55;                      // quanto si può rimpicciolire per far stare un nodo aperto per intero
const RAGGIO_SFERA = 1.7;                    // la sfera si apre più larga del ventaglio piatto
const MAX_TILT = 0.14;                       // ~8°
const DRAG_THRESHOLD = 8;                    // come la vista piatta
const CULL_MARGIN = 90;

// Rotazione della scena come quaternione [w,x,y,z] (trackball: i gesti ruotano
// attorno agli assi dello SCHERMO, da qualunque inclinazione). La matrice 3x3
// (riga per riga) porta un vettore del mondo nel sistema della camera.
const Q_ID = [1, 0, 0, 0];
const qMul = (a, b) => [
  a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
  a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
  a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
  a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0]
];
const qNorm = (q) => { const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1; return [q[0] / l, q[1] / l, q[2] / l, q[3] / l]; };
const qAsseX = (a) => [Math.cos(a / 2), Math.sin(a / 2), 0, 0];
const qAsseY = (a) => [Math.cos(a / 2), 0, Math.sin(a / 2), 0];
const qSlerp = (a, b, t) => {
  let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  if (d < 0) { b = [-b[0], -b[1], -b[2], -b[3]]; d = -d; }   // la via più breve
  if (d > 0.9995) return qNorm([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, a[3] + (b[3] - a[3]) * t]);
  const th = Math.acos(d), sa = Math.sin((1 - t) * th) / Math.sin(th), sb = Math.sin(t * th) / Math.sin(th);
  return [a[0] * sa + b[0] * sb, a[1] * sa + b[1] * sb, a[2] * sa + b[2] * sb, a[3] * sa + b[3] * sb];
};
const qMat = ([w, x, y, z]) => [
  1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y),
  2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x),
  2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)
];
// Gli stessi due angoli (yaw, pitch) della vista Spaziale: matrice equivalente.
const eulerMat = (yaw, pitch) => {
  const c = Math.cos(yaw), s = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
  return [c, 0, s, -sp * s, cp, sp * c, -cp * s, -sp, cp * c];
};

// Curva morbida (Catmull-Rom) per la camera del tour: passa per tutti i punti dati
// ed è percorsa in proporzione alla distanza, così la velocità non cambia da un
// tratto all'altro. P = [{x,y,cz}], almeno due punti. Restituisce e∈[0,1] -> punto.
function creaCurva(P) {
  const L = [0];
  for (let i = 1; i < P.length; i++) L.push(L[i - 1] + Math.hypot(P[i].x - P[i - 1].x, P[i].y - P[i - 1].y, P[i].cz - P[i - 1].cz));
  const tot = L[L.length - 1] || 1;
  const cr = (a, b, c, d, t) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t * t + (-a + 3 * b - 3 * c + d) * t * t * t);
  return (e) => {
    const f = Math.max(0, Math.min(1, e)) * tot;
    let i = 1;
    while (i < P.length - 1 && L[i] < f) i++;
    const t = (f - L[i - 1]) / ((L[i] - L[i - 1]) || 1);
    const p0 = P[Math.max(0, i - 2)], p1 = P[i - 1], p2 = P[i], p3 = P[Math.min(P.length - 1, i + 1)];
    return { x: cr(p0.x, p1.x, p2.x, p3.x, t), y: cr(p0.y, p1.y, p2.y, p3.y, t), cz: cr(p0.cz, p1.cz, p2.cz, p3.cz, t) };
  };
}

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
  const cam = { x: 0, y: 0, z: 0, tx: 0, ty: 0, tz: 0, cz: 0, tcz: 0, yaw: 0, pitch: 0, tyaw: 0, tpitch: 0, wyaw: 0, wpitch: 0, vx: 0, vy: 0, q: Q_ID, tq: Q_ID, M: eulerMat(0, 0), spin: 0, viaggio: null };
  let W = 0, H = 0;
  let dragged = false;

  // ─── profondità e nebbia ───────────────────────────────────────────────────
  function nebbia() { return Math.max(0, Math.min(1, -cam.z / FOG_Z)); }
  const depthOf = (h) => lerpTable(orbit ? DEPTH_ORBIT : DEPTH, h) * (1 - FLATTEN * nebbia());
  const focusPlane = () => depthOf(0);
  const scaleAt = (z) => F / Math.max(1, F + z - cam.z);
  const zMin = () => (orbit ? Z_MIN_ORBIT : Z_MIN);
  const zMax = () => (orbit ? Z_MAX_ORBIT : Z_MAX);
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
    if (W < 100 || H < 100) return;   // non ancora misurato: l'ellissoide dipende dalla misura
    if (!pos3.has(net.rootId)) pos3.set(net.rootId, { x: 0, y: 0, z: 0 });
    const R = radius() * RAGGIO_SFERA;
    // La sfera è un ellissoide adattato allo schermo: ai lati c'è poco posto
    // (telefono in verticale), sopra e sotto molto di più. I collegamenti di un
    // nodo stanno così dentro lo schermo a grandezza normale, senza rimpicciolirli.
    const kx = Math.max(0.8, Math.min(1, (W / 2 - MARGINE_X) / S_TARGET / R));
    // In verticale c'è molto più posto che in larghezza: la sfera si allunga (fino a 1,5x).
    const ky = Math.max(0.8, Math.min(1.5, (H / 2 - MARGINE_Y) / S_TARGET / R));
    const cen = { x: 0, y: 0, z: 0 };
    for (const q of pos3.values()) { cen.x += q.x; cen.y += q.y; cen.z += q.z; }
    const nn = Math.max(1, pos3.size);
    cen.x /= nn; cen.y /= nn; cen.z /= nn;
    for (const n of net.nodes.values()) {
      if (pos3.has(n.id)) continue;
      const pp = pos3.get(n.parent) || pos3.get(net.rootId);
      const gp = n.parent ? pos3.get(net.nodes.get(n.parent)?.parent) : null;
      let fuori = null;
      if (gp) {
        const ox = pp.x - gp.x, oy = pp.y - gp.y, oz = pp.z - gp.z, l = Math.hypot(ox, oy, oz) || 1;
        fuori = [ox / l, oy / l, oz / l];
      }
      let best = null, bestD = -Infinity;
      for (const rm of RAGGI) for (const d of DIREZIONI) {
        if (fuori && d[0] * fuori[0] + d[1] * fuori[1] + d[2] * fuori[2] < -0.75) continue;   // solo non tornare indietro verso il nonno
        const x = pp.x + d[0] * R * rm * kx, y = pp.y + d[1] * R * rm * ky, z = pp.z + d[2] * R * rm * Z_SCHIACCIATA;
        let m = Infinity;
        // Conta soprattutto la distanza SULLO SCHERMO (x,y): due nodi a profondità
        // diverse ma sulla stessa linea di vista si sovrapporrebbero comunque.
        const sx = F_ORBIT / Math.max(300, F_ORBIT + z - cen.z);
        for (const q of pos3.values()) {
          // Distanza come la vedrebbe l'occhio (proiettata, con la prospettiva) e
          // distanza vera nello spazio: la prima evita le sovrapposizioni che si
          // vedono, la seconda tiene i nodi larghi anche quando si ruota.
          const sq = F_ORBIT / Math.max(300, F_ORBIT + q.z - cen.z);
          const vis_ = Math.hypot(q.x * sq - x * sx, q.y * sq - y * sx);
          const vero = Math.hypot(q.x - x, q.y - y, (q.z - z) * PESO_Z * 2);
          const dd = 0.65 * vis_ + 0.35 * vero;
          if (dd < m) m = dd;
        }
        // Leggera attrazione verso il baricentro della rete: i nuovi nodi
        // riempiono i vuoti attorno invece di allungarla a striscia.
        m -= PESO_BARICENTRO * Math.hypot(x - cen.x, y - cen.y, z - cen.z) + PESO_LUNGHEZZA * (rm - 1) * R;
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
        line.dataset.k = k;
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
      if (k && !orbit) { sx /= k + 1; sy /= k + 1; sz /= k + 1; } else { sx = sy = sz = 0; }
      // In orbita il nodo attivo è il fulcro: sta esattamente al centro, e la
      // rotazione gira attorno a lui.
      const l = Math.hypot(sx, sy, sz), cap = r * 0.5, f2 = l > cap ? cap / l : 1;
      cam.tx = q.x + sx * f2; cam.ty = q.y + sy * f2; cam.tcz = q.z + sz * f2;
      cam.tz = 0; cam.vx = cam.vy = 0;
      if (orbit) inquadra(id);
      return;
    }
    cam.tcz = 0;
    if (orbit) { cam.tx = f.x; cam.ty = f.y; cam.tz = 0; cam.vx = cam.vy = 0; inquadra(id); return; }
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

  // In orbita il nodo aperto deve vedersi INTERO, con tutti i suoi collegamenti
  // (figli e genitore): se non ci stanno allo zoom normale, la camera si
  // allontana quel tanto che basta (mai oltre S_FIT_MIN, per non ridurli a
  // puntini). Calcolato sulla camera di destinazione, senza aspettare l'animazione.
  // true se tutti gli id, proiettati con la camera di destinazione e zoom tz,
  // stanno nel riquadro (con i margini).
  function entrano(ids, tz) {
    const mx = W / 2 - MARGINE_X, my = H / 2 - MARGINE_Y;
    const T = orbit ? qMat(cam.tq) : eulerMat(cam.tyaw, cam.tpitch);
    const fp = focusPlane();
    for (const nid of ids) {
      const w = worldPos(nid);
      if (!w) continue;
      let dx = w.x - cam.tx, dy = w.y - cam.ty;
      let dz = sfera ? w.z - cam.tcz : lerpTable(DEPTH_ORBIT, vis.get(nid)?.th ?? 2) - fp;
      [dx, dy, dz] = [T[0] * dx + T[1] * dy + T[2] * dz, T[3] * dx + T[4] * dy + T[5] * dz, T[6] * dx + T[7] * dy + T[8] * dz];
      const den = F + (sfera ? 0 : fp) + dz - tz;
      if (den < NEAR) return false;
      const sc = Math.min(F / den, S_MAX_ORBIT);
      if (Math.abs(dx) * sc > mx || Math.abs(dy) * sc > my) return false;
    }
    return true;
  }
  // Tocco su un nodo: si devono vedere BENE tutti i suoi collegamenti (tutti i
  // film di un genere o di un regista). Prima si prova con tutti, allargando la
  // camera fino a S_FIT_TUTTI; se nemmeno così ci stanno (un nodo di un altro
  // ramo, lontanissimo) si inquadrano solo quelli vicini, a una grandezza decente.
  function inquadra(id) {
    const f = net.nodes.get(id);
    if (!f) return;
    const tutti = [id], vicini = [id];
    const wf = worldPos(id), lim = radius() * RAGGIO_SFERA * 1.5 * Z_SCHIACCIATA;
    for (const e of net.edges) {
      const o = e.a === id ? e.b : e.b === id ? e.a : null;
      if (!o) continue;
      tutti.push(o);
      const wo = worldPos(o);
      if (!(wf && wo && Math.hypot(wo.x - wf.x, wo.y - wf.y, wo.z - wf.z) > lim)) vicini.push(o);
    }
    if (tutti.length < 2) return;
    const tzDi = (smin) => F + focusPlane() - F / smin;   // tz a cui la scala del fulcro scende a smin
    const cerca = (ids, smin) => {
      const limite = Math.max(zMin(), tzDi(smin));
      let tz = cam.tz;
      while (!entrano(ids, tz) && tz > limite) tz -= 40;
      return entrano(ids, tz) ? tz : null;
    };
    if (sfera) {
      const t1 = cerca(tutti, S_FIT_TUTTI);
      if (t1 !== null) { cam.tz = t1; return; }
      const t2 = cerca(vicini, S_FIT_MIN);
      cam.tz = t2 !== null ? t2 : Math.max(zMin(), tzDi(S_FIT_MIN));
      return;
    }
    const t = cerca(tutti, S_FIT_MIN_PIATTA);
    cam.tz = t !== null ? t : Math.max(zMin(), tzDi(S_FIT_MIN_PIATTA));
  }

  // Posizione "nel mondo" di un nodo, nelle stesse coordinate della camera.
  function worldPos(id) {
    if (sfera) return pos3.get(id) || null;
    const n = net.nodes.get(id);
    return n && n.x !== null ? { x: n.x, y: n.y, z: 0 } : null;
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
    const m = orbit ? 240 : 60;   // in orbita più respiro: il bordo non deve "frenare" il gesto
    cam.tx = Math.max(b.minX - m, Math.min(b.maxX + m, cam.tx));
    cam.ty = Math.max(b.minY - m, Math.min(b.maxY + m, cam.ty));
  }

  function overview() {
    const b = bounds();
    const sFit = Math.min((W - 24) / (b.maxX - b.minX + 110), (H - 24) / (b.maxY - b.minY + 120), 1);
    cam.tx = (b.minX + b.maxX) / 2;
    cam.ty = (b.minY + b.maxY) / 2;
    cam.tcz = (b.minZ + b.maxZ) / 2;
    // A nebbia diradata il piano del nodo attivo è a z = DEPTH[0] * (1 - FLATTEN).
    cam.tz = Math.max(zMin(), Math.min(-FOG_Z, F + DEPTH[0] * (1 - FLATTEN) - F / sFit));
    cam.vx = cam.vy = 0;
    if (orbit) {
      cam.tq = Q_ID; cam.wyaw = cam.wpitch = 0;   // la panoramica è una mappa: di fronte
      // Zoom il più vicino possibile che fa stare tutta la rete nel riquadro.
      const ids = [...net.nodes.keys()];
      let tz = Z_MAX;
      while (!entrano(ids, tz) && tz > zMin()) tz -= 40;
      cam.tz = Math.max(zMin(), Math.min(-FOG_Z, tz));
    }
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
    // Viaggio del tour: la camera si sposta in modo continuo (partenza e arrivo
    // dolci) dal punto in cui è fino al nodo di destinazione, quindi le locandine
    // che stanno in mezzo le scorrono davanti. Scrive sia la posizione sia il suo
    // obiettivo, così gli smorzamenti qui sotto non la rincorrono.
    if (cam.viaggio) {
      const v = cam.viaggio, u = Math.max(0, Math.min(1, (now - v.t0) / v.dur));
      const e = u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2;
      const pt = v.curva ? v.curva(e) : { x: v.a.x + (v.b.x - v.a.x) * e, y: v.a.y + (v.b.y - v.a.y) * e, cz: v.a.cz + (v.b.cz - v.a.cz) * e };
      cam.tx = cam.x = pt.x;
      cam.ty = cam.y = pt.y;
      cam.tcz = cam.cz = pt.cz;
      cam.tz = cam.z = v.a.z + (v.b.z - v.a.z) * e;
      // L'orientazione si muove insieme alla camera: si arriva "di lato".
      if (v.qa) { cam.q = cam.tq = qSlerp(v.qa, v.qb, e); }
      moving = true;
      if (u >= 1) { const fine = v.fine; cam.viaggio = null; fine?.(); }
    }
    for (const [id, f] of enfasi) {
      if (f.k !== f.kT) {
        const k = approach(f.k, f.kT, dt, 520);
        f.k = Math.abs(k - f.kT) > 0.004 ? k : f.kT;
        moving = true;
      }
      if (f.k === 0 && f.kT === 0) enfasi.delete(id);
    }
    if (nodeK !== nodeKT) {
      const k = approach(nodeK, nodeKT, dt, 350);
      nodeK = Math.abs(k - nodeKT) > 0.003 ? k : nodeKT;
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
    ease("z", "tz", orbit && pointersDown ? 30 : 90, 0.1);
    ease("cz", "tcz", pointersDown ? 30 : 120, 0.05);
    if (!pointersDown && !orbit) { cam.tyaw = 0; cam.tpitch = 0; }
    const tauRot = orbit && pointersDown ? 45 : 160;   // in orbita segue il dito da vicino
    if (orbit) {
      // Scia: la rotazione continua attorno agli assi dello schermo e rallenta.
      if (!pointersDown && (Math.abs(cam.wyaw) + Math.abs(cam.wpitch) > 0.00004)) {
        cam.tq = qNorm(qMul(qMul(qAsseX(cam.wpitch * dt), qAsseY(cam.wyaw * dt)), cam.tq));
        const k = Math.exp(-dt / SPIN_TAU);
        cam.wyaw *= k; cam.wpitch *= k;
        moving = true;
      }
      // Rotazione del tour: velocità fissa (rad/ms), senza smorzamento.
      if (cam.spin) { cam.tq = qNorm(qMul(qAsseY(cam.spin * dt), cam.tq)); moving = true; }
      // La rotazione mostrata insegue quella di destinazione lungo la via più breve.
      const d = Math.abs(cam.q[0] * cam.tq[0] + cam.q[1] * cam.tq[1] + cam.q[2] * cam.tq[2] + cam.q[3] * cam.tq[3]);
      if (d < 0.9999999) {
        cam.q = qNorm(qSlerp(cam.q, cam.tq, 1 - Math.exp(-dt / tauRot)));
        moving = true;
      } else cam.q = cam.tq;
      cam.M = qMat(cam.q);
    } else {
      ease("yaw", "tyaw", tauRot, 0.0005);
      ease("pitch", "tpitch", tauRot, 0.0005);
      cam.M = eulerMat(cam.yaw, cam.pitch);
    }

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
    const M = cam.M;
    [dx, dy, dz] = [M[0] * dx + M[1] * dy + M[2] * dz, M[3] * dx + M[4] * dy + M[5] * dz, M[6] * dx + M[7] * dy + M[8] * dz];
    const z = (sfera ? 0 : focusPlane()) + dz;
    const denom = F + z - cam.z;
    const nodeZoom = Math.min(NODE_ZOOM_MAX, Math.max(1, F / Math.max(1, F + focusPlane() - cam.z)));
    if (denom < NEAR) return { x: 0, y: 0, s: 0, z, dietro: true };   // dietro la camera
    const s = F / denom;
    // La posizione segue la prospettiva piena; la GRANDEZZA del nodo ha un tetto
    // in orbita: un nodo molto vicino non deve coprire quelli attorno.
    return { x: W / 2 + dx * s, y: H / 2 + dy * s, s: orbit ? Math.max(NODE_MIN, Math.min(NODE_MAX, Math.min(s, S_MAX_ORBIT) * NODE_K)) * nodeZoom * nodeK : s, z };
  }

  function draw() {
    const proj = new Map();
    for (const [id, v] of vis) {
      const n = net.nodes.get(id);
      const p = project(n, v);
      const fuori = p.dietro || p.x < -CULL_MARGIN || p.x > W + CULL_MARGIN || p.y < -CULL_MARGIN || p.y > H + CULL_MARGIN;
      let o = fuori ? 0 : opacityAt(v.h) * Math.min(1, v.grow * 1.6);
      const ef = enfasi.get(id);
      if (ef && ef.k > 0) {
        if (o === 0 && !fuori) o = 0.05;
        o = o + (1 - o) * ef.k;                 // esce dalla nebbia
        if (!fuori) p.s *= 1 + 0.32 * ef.k;      // e cresce
        p.z -= 2000 * ef.k;                     // e passa davanti a tutti
      }
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
      setIf(c, "tf", !!ef && ef.k > 0.5, x => { v.dom.classList.toggle("is-tour-focus", x); });
      setIf(c, "nl", p.s < LABEL_MIN_SCALE && !(ef && ef.k > 0.3), x => { v.dom.classList.toggle("no-label", x); });
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

  // Tour (vedi dna-view.js): viaggio continuo della camera fra i nodi e rotazione
  // finale. Il copione è di dna-view; qui solo come si muove la camera.
  // Il nodo su cui sta andando il tour emerge mentre la camera si avvicina: in
  // primo piano, pieno, un po' più grande, con un alone. id -> { k (attuale), kT (destinazione) }.
  const enfasi = new Map();
  let nodeK = 1, nodeKT = 1; // grandezza dei nodi nel giro finale del tour (più piccoli: la rete intera è fitta), corrente e di destinazione
  let viaggio = 0;
  function volo(px, py, pz) {
    const dist = Math.hypot(cam.tx - px, cam.ty - py, sfera ? cam.tcz - pz : 0);
    const dip = Math.min(DIP_MAX, dist * 0.45);
    if (dip <= 30) return;
    const tzFinale = cam.tz, gettone = ++viaggio;
    cam.tz = Math.max(zMin(), tzFinale - dip);
    setTimeout(() => { if (gettone === viaggio) { cam.tz = tzFinale; kick(); } }, 260);
  }
  // Tocco lungo su un nodo (orbita): ci voli sopra senza aprirlo, e da lì
  // ruoti e navighi. Il tocco breve resta quello di sempre.
  let longTimer = 0;
  const finePressione = () => { clearTimeout(longTimer); longTimer = 0; };
  function voloSu(id) {
    const w = worldPos(id);
    if (!w) return;
    const px = cam.tx, py = cam.ty, pz = cam.tcz;
    cam.tx = w.x; cam.ty = w.y; if (sfera) cam.tcz = w.z;
    cam.vx = cam.vy = 0;
    clampCam();
    volo(px, py, pz);
    try { navigator.vibrate?.(12); } catch {}
    kick();
  }
  const pts = new Map();
  let gesture = null, ultimoTocco = 0;

  // Un dito: in orbita ruota la scena attorno al nodo attivo, altrimenti sposta
  // la camera (con parallax e lieve inclinazione, come sempre).
  const nuovoGesto = (x, y) => orbit
    ? { mode: "orbit", x0: x, y0: y, lx: x, ly: y, lt: performance.now() }
    : { mode: "pan", x0: x, y0: y, cx: cam.tx, cy: cam.ty, lx: x, ly: y, lt: performance.now() };

  container.addEventListener("pointerdown", e => {
    if (e.button > 0 || !net || !active || e.target.closest(".dna-spatial__tour")) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    pointersDown = pts.size;
    if (pts.size === 1) {
      dragged = false;
      gesture = nuovoGesto(e.clientX, e.clientY);
      gesture.nodo = orbit ? e.target.closest?.(".dna-node")?.dataset.node || null : null;
      cam.vx = cam.vy = 0;
      cam.wyaw = cam.wpitch = 0;   // un tocco ferma la rotazione che stava continuando
      finePressione();
      if (gesture.nodo && gesture.nodo !== focusId) {
        const g = gesture;
        longTimer = setTimeout(() => {
          longTimer = 0;
          if (gesture !== g || g.nodo === null || dragged) return;
          dragged = true; g.lungo = true;    // sopprime il click che segue
          voloSu(g.nodo); g.nodo = null;
        }, LONG_MS);
      }
    } else if (pts.size === 2) {
      const [p, q] = [...pts.values()];
      dragged = true;
      const r0 = container.getBoundingClientRect();
      finePressione();
      gesture = { mode: "pinch", d0: Math.hypot(p.x - q.x, p.y - q.y) || 1, s0: scaleAtCam(cam.tz),
        mx0: (p.x + q.x) / 2, my0: (p.y + q.y) / 2, tx0: cam.tx, ty0: cam.ty, rx: r0.left + W / 2, ry: r0.top + H / 2 };
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
      cam.tz = Math.max(zMin(), Math.min(zMax(), F + focusPlane() - F / Math.max(0.05, sNew)));
      if (orbit) {
        // In orbita due dita spostano anche il centro (un dito è occupato a ruotare):
        // approssimato sul piano della rete, meno efficace se la scena è molto girata.
        // Lo zoom va verso le dita: il punto della rete sotto di loro resta lì
        // (e se le dita si spostano, la rete le segue). t = t0 + o0/s0 - o/s,
        // con o = scostamento delle dita dal centro dello schermo.
        const sc = scaleAtCam(cam.tz);
        const mx = (p.x + q.x) / 2 - gesture.rx, my = (p.y + q.y) / 2 - gesture.ry;
        const m0x = gesture.mx0 - gesture.rx, m0y = gesture.my0 - gesture.ry;
        // Spostamento sullo schermo -> spostamento della camera nel mondo, con
        // l'inversa della rotazione corrente (segno incluso: da dietro è
        // specchiato, ed è giusto così). Se la scena è vista di taglio non
        // diventa infinito: il denominatore ha un minimo.
        const vx = m0x / gesture.s0 - mx / sc, vy = m0y / gesture.s0 - my / sc;
        // Dal mondo allo schermo, per un punto sul piano del fulcro, è la parte 2x2
        // in alto a sinistra della matrice di rotazione: la si inverte (con un
        // minimo al determinante, per la scena vista di taglio).
        const T = qMat(cam.tq);
        let det = T[0] * T[4] - T[1] * T[3];
        det = (det < 0 ? -1 : 1) * Math.max(0.2, Math.abs(det));
        const ntx = gesture.tx0 + (T[4] * vx - T[1] * vy) / det, nty = gesture.ty0 + (-T[3] * vx + T[0] * vy) / det;
        const tnow = performance.now(), dtp = Math.max(1, tnow - (gesture.pt || tnow - 16));
        // Velocità del centro (unità del mondo per ms): al rilascio la vista continua a scivolare.
        cam.vx = cam.vx * 0.6 + ((ntx - cam.tx) / dtp) * 0.4;
        cam.vy = cam.vy * 0.6 + ((nty - cam.ty) / dtp) * 0.4;
        gesture.pt = tnow;
        cam.tx = ntx; cam.ty = nty;
        clampCam();
      }
      kick();
      return;
    }
    if (gesture.mode === "orbit") {
      if (net.nodes.size <= 1 || gesture.lungo) return;   // un nodo solo: niente da girare
      const ox = e.clientX - gesture.x0, oy = e.clientY - gesture.y0;
      if (!dragged) {
        if (Math.hypot(ox, oy) < DRAG_THRESHOLD) return;
        finePressione();
        dragged = true;
        gesture.lx = gesture.x0; gesture.ly = gesture.y0; gesture.lt = performance.now() - 16;   // i pixel della soglia contano: la rotazione è proporzionale al dito
        cam.wyaw = cam.wpitch = 0; cam.vx = cam.vy = 0;
        try { container.setPointerCapture(e.pointerId); } catch {}
      }
      // Trackball: ogni movimento del dito ruota la scena attorno agli assi dello
      // schermo (a destra = attorno al verticale, su/giù = attorno all'orizzontale),
      // a incrementi: nessun salto alla soglia, nessun limite, nessun "verso"
      // che cambia quando la scena è inclinata o capovolta. Più si è vicini,
      // più la rotazione è lenta e precisa; da lontano è più rapida.
      const now = performance.now();
      const ddx = e.clientX - gesture.lx, ddy = e.clientY - gesture.ly, dtm = Math.max(1, now - gesture.lt);
      const zoom = scaleAtCam(cam.tz);
      const K = ORBIT_K * Math.max(0.45, Math.min(1.5, Math.pow(zoom, -0.6)));
      const ay = ddx * K, ax = ddy * K;
      cam.tq = qNorm(qMul(qMul(qAsseX(ax), qAsseY(ay)), cam.tq));
      // Velocità angolare (rad/ms) per la scia al rilascio, con media mobile.
      cam.wyaw = cam.wyaw * 0.6 + (ay / dtm) * 0.4;
      cam.wpitch = cam.wpitch * 0.6 + (ax / dtm) * 0.4;
      gesture.lx = e.clientX; gesture.ly = e.clientY; gesture.lt = now;
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
    finePressione();
    try { container.releasePointerCapture(e.pointerId); } catch {}
    pointersDown = pts.size;
    if (pts.size === 1 && gesture?.mode === "pinch") {
      const [p] = [...pts.values()];
      if (orbit && performance.now() - (gesture.pt || 0) > 90) cam.vx = cam.vy = 0;   // dita ferme: niente scia
      gesture = nuovoGesto(p.x, p.y);
      if (!orbit) cam.vx = cam.vy = 0;   // in orbita la scia dello spostamento a due dita si tiene
    } else if (!pts.size) {
      if (gesture?.mode === "pinch" && performance.now() - (gesture.pt || 0) > 90) cam.vx = cam.vy = 0;   // dita ferme: niente scia
      // Dito fermo prima di staccarlo: nessuna scia di rotazione.
      if (gesture?.mode === "orbit" && performance.now() - gesture.lt > 90) cam.wyaw = cam.wpitch = 0;
      gesture = null;
      // Il click arriva dopo il pointerup: il flag deve sopravvivere fino a lì.
      if (dragged) setTimeout(() => { dragged = false; }, 0);
      else if (!e.target.closest(".dna-node, .dna-spatial__tour") && net.nodes.size > 1) doppioTocco();
    }
    kick();
  }
  container.addEventListener("pointerup", endPointer);
  container.addEventListener("pointercancel", endPointer);

  container.addEventListener("wheel", e => {
    if (!net || !active) return;
    e.preventDefault();
    const sNew = scaleAtCam(cam.tz) * Math.exp(-e.deltaY * 0.0015);
    cam.tz = Math.max(zMin(), Math.min(zMax(), F + focusPlane() - F / sNew));
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
      const prevFocus = focusId, prevTx = cam.tx, prevTy = cam.ty, prevTcz = cam.tcz;
      focusId = nextFocusId;
      measure();
      sync(snap);
      if (snap) {
        const f = sfera ? (pos3.get(focusId) || { x: 0, y: 0, z: 0 }) : net.nodes.get(focusId);
        const fz = sfera ? f.z : 0;
        Object.assign(cam, { x: f.x, y: f.y, z: 0, cz: fz, tx: f.x, ty: f.y, tz: 0, tcz: fz, yaw: 0, pitch: 0, tyaw: 0, tpitch: 0, vx: 0, vy: 0, q: Q_ID, tq: Q_ID, wyaw: 0, wpitch: 0, M: eulerMat(0, 0) });
      }
      aimAt(focusId, newIds || []);
      // Volo da un nodo all'altro: a metà strada la camera si allarga un po'
      // (si vede dove si va) e poi si riavvicina, invece di scivolare in piano.
      if (orbit && !snap && prevFocus !== focusId) volo(prevTx, prevTy, prevTcz);
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
      if (!orbit) { cam.tyaw = cam.tpitch = 0; cam.yaw = cam.pitch = 0; cam.M = eulerMat(0, 0); }
      cam.q = cam.tq = Q_ID; cam.wyaw = cam.wpitch = 0;
      for (const v of vis.values()) v.cache = {};
      risistema();
      kick();
    },
    // ── Tour ──
    // Viaggia (piano, in `ms`) fino al nodo e inquadra i suoi collegamenti, senza
    // aprirlo né farlo diventare attivo. Risolve all'arrivo.
    // `via`: id dei nodi da sorvolare lungo i collegamenti, nell'ordine; `yaw`/`pitch`:
    // la leggera rotazione con cui si arriva; `lato`: da che parte curva il volo diretto.
    tourVai(id, ms, { via = [], yaw = 0, pitch = 0, lato = 1 } = {}) {
      const w = worldPos(id);
      if (!w) return Promise.resolve();
      // Quello di prima si spegne, quello di arrivo emerge man mano che ci si avvicina.
      for (const f of enfasi.values()) f.kT = 0;
      enfasi.set(id, { k: enfasi.get(id)?.k ?? 0, kT: 1 });
      return new Promise(risolvi => {
        const da = { x: cam.x, y: cam.y, cz: cam.cz, z: cam.z };
        // Dove arriva la camera e con che zoom (calcolato sulla destinazione).
        cam.tx = w.x; cam.ty = w.y; if (sfera) cam.tcz = w.z;
        cam.vx = cam.vy = 0; cam.spin = 0; cam.wyaw = cam.wpitch = 0;
        cam.tz = 0;
        clampCam();
        inquadra(id);
        const a = { x: da.x, y: da.y, cz: da.cz, z: da.z };
        const b = { x: cam.tx, y: cam.ty, cz: cam.tcz, z: cam.tz };
        cam.tx = a.x; cam.ty = a.y; cam.tcz = a.cz; cam.tz = a.z;   // si parte da dove si è
        // Se si è già lì (la prima tappa è il tuo nodo, dove la camera sta già) non
        // serve aspettare un intero viaggio.
        const lontano = Math.hypot(b.x - a.x, b.y - a.y, b.cz - a.cz) + Math.abs(b.z - a.z) * 0.5;
        // Percorso: la camera sorvola i nodi intermedi (se ce ne sono); altrimenti il
        // volo diretto fa un arco leggero di lato invece di una retta.
        const punti = [a];
        for (const vid of via) { const q = worldPos(vid); if (q) punti.push({ x: q.x, y: q.y, cz: sfera ? q.z : 0 }); }
        if (punti.length === 1 && lontano >= 40) {
          const dx = b.x - a.x, dy = b.y - a.y, dl = Math.hypot(dx, dy) || 1, len = Math.hypot(dx, dy, b.cz - a.cz);
          punti.push({ x: (a.x + b.x) / 2 + (dy / dl) * len * 0.16 * lato, y: (a.y + b.y) / 2 - (dx / dl) * len * 0.16 * lato, cz: (a.cz + b.cz) / 2 });
        }
        punti.push({ x: b.x, y: b.y, cz: b.cz });
        const durata = lontano < 40 ? Math.min(ms, 600) : ms * (1 + Math.min(0.9, 0.45 * via.length));
        cam.viaggio = {
          a, b, t0: performance.now(), dur: durata, fine: risolvi,
          curva: punti.length > 2 ? creaCurva(punti) : null,
          qa: cam.tq, qb: qNorm(qMul(qAsseX(pitch), qAsseY(yaw)))
        };
        kick();
      });
    },
    // Panoramica sulla rete intera e un giro completo attorno, in `ms`.
    tourRuota(ms) {
      for (const f of enfasi.values()) f.kT = 0;
      cam.vx = cam.vy = 0; cam.wyaw = cam.wpitch = 0;
      // Durante il giro la rete deve stare dentro lo schermo da ogni lato: si
      // inquadra la SFERA che la contiene (raggio massimo dal centro), non la
      // sua forma di fronte, che cambia girando.
      const b = bounds();
      const c = { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2, z: (b.minZ + b.maxZ) / 2 };
      let r = 1;
      for (const id of net.nodes.keys()) {
        const w = worldPos(id);
        if (w) r = Math.max(r, Math.hypot(w.x - c.x, w.y - c.y, w.z - c.z));
      }
      const sNec = Math.max(0.12, Math.min(1, (Math.min(W, H * 0.8) / 2 - 34) / (r * 1.1)));
      const a = { x: cam.x, y: cam.y, cz: cam.cz, z: cam.z };
      cam.viaggio = { a, b: { x: c.x, y: c.y, cz: c.z, z: Math.max(zMin(), F - F / sNec) }, t0: performance.now(), dur: Math.min(2200, ms * 0.3), fine: null };
      nodeKT = 0.6;
      cam.spin = (2 * Math.PI) / ms;
      kick();
    },
    // Fine del tour. `torna`: la camera rientra piano sul nodo attivo; altrimenti
    // resta dov'è (si è presa la mano), senza scatti.
    tourFine(torna = true) {
      for (const f of enfasi.values()) f.kT = 0;
      cam.spin = 0; nodeKT = 1;
      cam.viaggio = null;
      cam.tq = cam.q;   // si resta com'è, senza scatti
      cam.tx = cam.x; cam.ty = cam.y; cam.tcz = cam.cz; cam.tz = cam.z;
      if (torna && net) {
        const w = worldPos(focusId);
        if (w) {
          const a = { x: cam.x, y: cam.y, cz: cam.cz, z: cam.z };
          cam.tx = w.x; cam.ty = w.y; if (sfera) cam.tcz = w.z;
          cam.tz = 0; clampCam(); inquadra(focusId);
          const b = { x: cam.tx, y: cam.ty, cz: cam.tcz, z: cam.tz };
          cam.tx = a.x; cam.ty = a.y; cam.tcz = a.cz; cam.tz = a.z;
          cam.viaggio = { a, b, t0: performance.now(), dur: 1700, fine: null, qa: cam.tq, qb: Q_ID };
        }
      }
      kick();
    },
    show() { active = true; container.classList.remove("hidden"); measure(); },
    // Nascosta si svuota: tornando a Spaziale riparte allineata alla rete,
    // senza tenere in memoria un DOM che nessuno vede.
    hide() { active = false; container.classList.add("hidden"); clear(); },
    clear
  };
}
