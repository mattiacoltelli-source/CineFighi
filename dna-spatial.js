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

import { hopsFrom } from "./dna.js?v=3374161";

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
const RAGGIO_EXTRA = 2.0, RETE_FITTA = 28;   // con la rete già fitta (28+ nodi) si prova anche un anello più largo
const ROTAZIONI_ANELLO = [0, 0.5, 0.25, 0.75, 0.125, 0.375, 0.625, 0.875];   // rotazioni provate per l'anello dei figli, in frazioni del passo (la prima vince a parità)
const SPAZIO_OK_GRUPPO = 0.9;                // spazio (in raggi) oltre il quale un anello non migliora
const SPAZIO_MIN_GRUPPO = 0.65;              // se l'anello regolare non ha almeno questo spazio (in raggi) fra i nodi, si torna alla scelta nodo per nodo
const PESO_LUNGHEZZA = 0.12;                 // piccolo costo per gli archi più lunghi: a parità di spazio vince il più corto
const PESO_BARICENTRO = 0.25;                // quanto i nuovi nodi preferiscono i vuoti vicino al centro della rete
// Rilassamento: dopo che nodi nuovi sono stati piazzati, i nodi troppo vicini sullo schermo si
// respingono (la locandina è larga 62px più l'etichetta sotto) e si assestano con una piccola scivolata.
const SPAZIO_NODO = 100;                     // distanza minima voluta fra due nodi in orizzontale: la locandina è larga 62px (+ margine) e la camera di solito sta a scala ~0,7
const SPAZIO_ASPETTO = 0.8;                  // in verticale serve di più (c'è l'etichetta): 76 / 0.8
const SPAZIO_PESO_Z = 0.3;                   // la profondità conta meno dello schermo: più è piccolo, più si preferisce spostare in z
const RILASSA_PASSI = 40;
const RILASSA_FORZA = 0.55;                  // quanto del sovrapposto si corregge a ogni passo
const RILASSA_CASA = 0.05;                   // richiamo verso la posizione di partenza: la rete non si deforma troppo
const RILASSA_MAX = 1.0;                     // spostamento massimo di un nodo, in raggi
const SCIVOLA_TAU = 260;                     // ms: i nodi già visibili scivolano nella nuova posizione
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

// ─── sfondo: spazio profondo ───────────────────────────────────────────────
// Stelle a tre profondità e nubi lontane, FISSE nel cielo: ruotano con la camera (girando la rete scorrono come
// da una finestra) e si spostano un po' quando la camera vola (parallasse: le stelle vicine di più). Le nubi si
// disegnano una volta sola (rumore frattale) e poi si spostano soltanto. Si ridisegna solo quando la camera si
// muove: a vista ferma non costa niente.
const lerpS = (a, b, t) => a + (b - a) * t;
function rngSeme(a) { return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const dirNorm = (x, y, z) => { const l = Math.hypot(x, y, z); return [x / l, y / l, z / l]; };
const hash2 = (x, y, sd) => { let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(sd, 2147483647); h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };
const vnoise = (x, y, sd) => { const xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi, u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy); return lerpS(lerpS(hash2(xi, yi, sd), hash2(xi + 1, yi, sd), u), lerpS(hash2(xi, yi + 1, sd), hash2(xi + 1, yi + 1, sd), u), v); };
const fbm = (x, y, sd, oct) => { let a = 0.5, f = 1, t = 0, n = 0; for (let i = 0; i < oct; i++) { t += a * vnoise(x * f, y * f, sd + i * 7); n += a; a *= 0.5; f *= 2.03; } return t / n; };
// Una riga di pixel di una nube (rumore frattale). Gira in un Web Worker (fuori dal thread principale: calcolarla qui blocca
// l'app per 60-150 ms su un telefono di fascia media, e si sentiva alle prime aperture); se il worker non c'è, a fette.
function rigaNube(px, seed, c1, c2, size, y) {
  const h = size / 2;
  for (let x = 0; x < size; x++) {
    const nx = x / size * 3.4, ny = y / size * 3.4;
    const wx = fbm(nx + 5.2, ny + 1.3, seed, 3), wy = fbm(nx + 8.7, ny + 2.8, seed + 3, 3);   // le nubi si piegano su se stesse
    const v = fbm(nx + wx * 1.6, ny + wy * 1.6, seed + 11, 5);
    const d = Math.hypot(x - h, y - h) / h, fall = Math.max(0, 1 - d), fo = fall * fall * (3 - 2 * fall);
    const a = Math.min(1, Math.max(0, (v - 0.36) * 2.4)) * fo;
    const m = fbm(nx * 0.8 + 3, ny * 0.8, seed + 23, 3), o = (y * size + x) * 4;
    px[o] = lerpS(c1[0], c2[0], m); px[o + 1] = lerpS(c1[1], c2[1], m); px[o + 2] = lerpS(c1[2], c2[2], m); px[o + 3] = a * 235;
  }
}
let spazioWorker;   // undefined = non ancora provato, null = non disponibile
const spazioAttese = new Map();   // id -> { size, fine }
let spazioIdLavoro = 0;
function nubeSulCanvas(buf, size) {
  const cn = document.createElement("canvas"); cn.width = cn.height = size;
  cn.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(buf), size, size), 0, 0);
  return cn;
}
function nubeAFette(seed, c1, c2, size, fine) {   // ripiego: sul thread principale, 3 ms per volta
  const px = new Uint8ClampedArray(size * size * 4);
  let y = 0;
  const passo = () => {
    const limite = performance.now() + 3;
    while (y < size && performance.now() < limite) { rigaNube(px, seed, c1, c2, size, y); y++; }
    if (y < size) setTimeout(passo, 6); else fine(nubeSulCanvas(px.buffer, size));
  };
  passo();
}
function avviaWorkerSpazio() {
  try {
    const codice = `const lerpS=${lerpS};const hash2=${hash2};const vnoise=${vnoise};const fbm=${fbm};const rigaNube=${rigaNube};
onmessage=(e)=>{const m=e.data,px=new Uint8ClampedArray(m.size*m.size*4);for(let y=0;y<m.size;y++)rigaNube(px,m.seed,m.c1,m.c2,m.size,y);postMessage({id:m.id,buf:px.buffer},[px.buffer]);};`;
    const w = new Worker(URL.createObjectURL(new Blob([codice], { type: "text/javascript" })));
    w.onmessage = (e) => { const a = spazioAttese.get(e.data.id); if (!a) return; spazioAttese.delete(e.data.id); a.fine(nubeSulCanvas(e.data.buf, a.size)); };
    w.onerror = () => {   // il worker non parte: quello che restava si calcola a fette
      spazioWorker = null;
      for (const [id, a] of [...spazioAttese]) { spazioAttese.delete(id); nubeAFette(a.seed, a.c1, a.c2, a.size, a.fine); }
    };
    return w;
  } catch { return null; }
}
function disegnaNube(seed, c1, c2, size, fine) {
  if (spazioWorker === undefined || spazioWorker === null) { if (spazioWorker === undefined) spazioWorker = avviaWorkerSpazio(); }
  if (!spazioWorker) { nubeAFette(seed, c1, c2, size, fine); return; }
  const id = ++spazioIdLavoro;
  spazioAttese.set(id, { seed, c1, c2, size, fine });
  spazioWorker.postMessage({ id, seed, c1, c2, size });
}
const SPAZIO_FONDO = "#060910";
const SPAZIO_ACC = { cyan: [56, 189, 248], orange: [255, 157, 77], violet: [167, 139, 250], gold: [255, 209, 102] };
const SPAZIO_STELLE_COL = ["#ffffff", "#d6e8ff", "#ffeed8", "#c4dcff"];
const SPAZIO_PAR = [0.012, 0.03, 0.065];   // quanto scorrono le stelle dei tre livelli quando la camera si sposta
const SPAZIO_BASE = [   // i cinque disegni di base: colori e seme
  { pal: [[120, 60, 200], [30, 140, 220]], seed: 3 },
  { pal: [[255, 140, 80], [150, 60, 170]], seed: 17 },
  { pal: [[40, 110, 200], [90, 190, 220]], seed: 31 },
  { pal: [[170, 90, 220], [255, 170, 120]], seed: 47 },
  { pal: [[30, 150, 190], [110, 80, 210]], seed: 59 }
];
// Dove stanno nel cielo, ampiezza (rispetto allo schermo), rotazione, trasparenza: le prime davanti, le altre dietro.
const SPAZIO_NUBI = [
  { d: dirNorm(-0.35, -1.0, 1), si: 0, k: 1.7, rot: 0.4, a: 0.34 },
  { d: dirNorm(0.45, -0.25, 1), si: 1, k: 1.5, rot: 2.1, a: 0.28 },
  { d: dirNorm(-0.1, 0.65, 1), si: 2, k: 1.9, rot: 3.6, a: 0.28 },
  { d: dirNorm(0.35, 1.15, 1), si: 3, k: 1.4, rot: 5.0, a: 0.24 },
  { d: dirNorm(-0.5, 0.1, 1), si: 4, k: 1.6, rot: 1.2, a: 0.26 },
  { d: dirNorm(0.8, 0.2, -1), si: 0, k: 1.7, rot: 2.8, a: 0.3 },
  { d: dirNorm(-0.7, -0.4, -1), si: 3, k: 1.6, rot: 4.2, a: 0.28 },
  { d: dirNorm(0.2, 1.0, -0.8), si: 2, k: 1.8, rot: 0.9, a: 0.28 },
  { d: dirNorm(-0.3, -1.1, -1), si: 1, k: 1.6, rot: 5.6, a: 0.28 }
];
const SPAZIO_ACCENTO = { d: dirNorm(0.1, -0.05, 1), k: 1.9, rot: 0.9, a: 0.36 };   // la nube che prende il colore del nodo attivo
let spazioStelle = null;
function stelleSpazio() {
  if (spazioStelle) return spazioStelle;
  const rng = rngSeme(20261010);
  const dir = () => { let x, y, z, l; do { x = rng() * 2 - 1; y = rng() * 2 - 1; z = rng() * 2 - 1; l = x * x + y * y + z * z; } while (l > 1 || l < 0.05); l = Math.sqrt(l); return [x / l, y / l, z / l]; };
  spazioStelle = Array.from({ length: 1100 }, (_, i) => { const big = rng(); return { d: dir(), l: i % 3, a: 0.22 + rng() * 0.62, r: big < 0.03 ? 2.1 : big < 0.22 ? 1.6 : 1.1, c: SPAZIO_STELLE_COL[(rng() * 4) | 0] }; });
  return spazioStelle;
}
// I disegni delle nubi sono condivisi e si preparano una volta (in un worker, tutti insieme). `t*`: quando sono pronte (dissolvenza).
const spazioNubi = { base: [], accento: {}, tBase: [], tAcc: {}, avviata: false };
function preparaSpazio(quandoPronto) {
  if (spazioNubi.avviata) return;
  spazioNubi.avviata = true;
  SPAZIO_BASE.forEach((c, i) => disegnaNube(c.seed, c.pal[0], c.pal[1], 176, (cn) => { spazioNubi.base[i] = cn; spazioNubi.tBase[i] = performance.now(); quandoPronto(); }));
  Object.keys(SPAZIO_ACC).forEach((k, i) => { const c = SPAZIO_ACC[k]; disegnaNube(71 + i * 5, c, [Math.min(255, c[0] + 60), Math.min(255, c[1] + 60), Math.min(255, c[2] + 60)], 192, (cn) => { spazioNubi.accento[k] = cn; spazioNubi.tAcc[k] = performance.now(); quandoPronto(); }); });
}

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

  // ─── sfondo: spazio (vedi in cima: stelle e nubi lontane) ───
  const spaceCv = container.querySelector(".dna-spatial__space");
  const spaceCtx = spaceCv ? spaceCv.getContext("2d", { alpha: false }) : null;
  const spLayer = document.createElement("canvas"), spLx = spLayer.getContext("2d");   // fondo e nubi, a un quarto di risoluzione (sono morbide)
  const spAcc = { cyan: 1, orange: 0, violet: 0, gold: 0 };                            // quanto pesa il colore di ogni accento
  let spSig = null, spDpr = 1;
  function dimensionaSpazio() {
    if (!spaceCv) return;
    spDpr = 1;
    spaceCv.width = Math.max(2, Math.round(W * spDpr)); spaceCv.height = Math.max(2, Math.round(H * spDpr));
    spLayer.width = Math.max(2, Math.ceil(W / 4)); spLayer.height = Math.max(2, Math.ceil(H / 4));
    spSig = null;
  }
  // Ridisegna lo sfondo solo se la camera si è mossa. Ritorna true finché il colore dell'accento sta ancora cambiando.
  function drawSpace() {
    if (!spaceCtx || !sfera || W < 20 || H < 20) return false;
    const M = cam.M, nodoAttivo = net && net.nodes.get(focusId), tipo = nodoAttivo ? nodoAttivo.type : null;
    const key = tipo === "genere" ? "orange" : tipo === "attore" ? "violet" : tipo === "film" ? "gold" : "cyan";   // persona e regista: ciano
    let anim = false;
    for (const k in spAcc) { const t = k === key ? 1 : 0, v = spAcc[k] + (t - spAcc[k]) * 0.08; spAcc[k] = Math.abs(v - t) < 0.01 ? t : v; if (spAcc[k] !== t) anim = true; }
    const ora = performance.now(), DISS = 700;   // ogni nube compare con una dissolvenza (DISS ms) quando è pronta
    const fb = spazioNubi.tBase.map((t0) => Math.min(1, (ora - t0) / DISS)), fa = {};
    for (const k in spazioNubi.tAcc) fa[k] = Math.min(1, (ora - spazioNubi.tAcc[k]) / DISS);
    if (fb.some((v) => v < 1) || Object.values(fa).some((v) => v < 1)) anim = true;
    const sig = [M[0], M[1], M[2], M[3], M[4], M[5], M[6], M[7], M[8], cam.x, cam.y, cam.cz, cam.z, W, H, fb.reduce((a, v) => a + v, 0) + Object.values(fa).reduce((a, v) => a + v, 0), spAcc.cyan, spAcc.orange, spAcc.violet, spAcc.gold];
    if (spSig && sig.every((v, i) => v === spSig[i])) return anim;
    spSig = sig;
    const f = Math.max(W, H) * 0.36;
    // posizione della camera nel suo sistema: sposta lo sfondo in senso opposto, le stelle vicine di più
    const cpx = M[0] * cam.x + M[1] * cam.y + M[2] * cam.cz, cpy = M[3] * cam.x + M[4] * cam.y + M[5] * cam.cz;
    const roll = Math.atan2(M[3], M[0]), zf = 1 + (F / Math.max(1, F - cam.z) - 0.7) * 0.05;
    spLx.setTransform(0.25, 0, 0, 0.25, 0, 0); spLx.globalCompositeOperation = "source-over"; spLx.globalAlpha = 1;
    spLx.fillStyle = SPAZIO_FONDO; spLx.fillRect(0, 0, W, H);                              // fondo opaco: poi basta una sola copia a schermo intero
    spLx.globalCompositeOperation = "lighter";
    const nube = (c, sprite, alpha, par) => {
      if (!sprite) return;
      const rz = M[6] * c.d[0] + M[7] * c.d[1] + M[8] * c.d[2];
      if (rz < 0.2) return;
      const rx = M[0] * c.d[0] + M[1] * c.d[1] + M[2] * c.d[2], ry = M[3] * c.d[0] + M[4] * c.d[1] + M[5] * c.d[2];
      const size = c.k * f * 1.5 / Math.max(0.5, rz), sx = W / 2 + (rx / rz * f - cpx * par) * zf, sy = H / 2 + (ry / rz * f - cpy * par) * zf;
      if (sx < -size || sx > W + size || sy < -size || sy > H + size) return;
      spLx.globalAlpha = alpha * Math.min(1, (rz - 0.2) * 3);
      spLx.save(); spLx.translate(sx, sy); spLx.rotate(roll + c.rot); spLx.drawImage(sprite, -size / 2, -size / 2, size, size); spLx.restore();
    };
    for (const c of SPAZIO_NUBI) nube(c, spazioNubi.base[c.si], c.a * (fb[c.si] || 0), 0.02);
    for (const k in spAcc) if (spAcc[k] > 0.02) nube(SPAZIO_ACCENTO, spazioNubi.accento[k], SPAZIO_ACCENTO.a * spAcc[k] * (fa[k] || 0), 0.03);
    // vignettatura leggera ai bordi (sul livello a bassa risoluzione: un elemento in più nella pagina disturba i gesti)
    spLx.globalCompositeOperation = "source-over"; spLx.globalAlpha = 1;
    const vg = spLx.createRadialGradient(W / 2, H * 0.46, Math.min(W, H) * 0.3, W / 2, H * 0.46, Math.max(W, H) * 0.78);
    vg.addColorStop(0, "rgba(2,4,8,0)"); vg.addColorStop(1, "rgba(2,4,8,0.6)");
    spLx.fillStyle = vg; spLx.fillRect(0, 0, W, H);
    const g = spaceCtx;
    g.setTransform(spDpr, 0, 0, spDpr, 0, 0); g.globalCompositeOperation = "copy"; g.globalAlpha = 1;
    g.imageSmoothingEnabled = true; g.drawImage(spLayer, 0, 0, W, H);
    g.globalCompositeOperation = "lighter";
    for (const st of stelleSpazio()) {
      const rz = M[6] * st.d[0] + M[7] * st.d[1] + M[8] * st.d[2];
      if (rz < 0.12) continue;
      const rx = M[0] * st.d[0] + M[1] * st.d[1] + M[2] * st.d[2], ry = M[3] * st.d[0] + M[4] * st.d[1] + M[5] * st.d[2];
      const x = W / 2 + (rx / rz * f - cpx * SPAZIO_PAR[st.l]) * zf, y = H / 2 + (ry / rz * f - cpy * SPAZIO_PAR[st.l]) * zf;
      if (x < -2 || x > W + 2 || y < -2 || y > H + 2) continue;
      g.globalAlpha = st.a * Math.min(1, (rz - 0.12) * 4);
      g.fillStyle = st.c;
      if (st.r > 2) { g.beginPath(); g.arc(x, y, st.r, 0, 6.2832); g.fill(); } else g.fillRect(x - st.r / 2, y - st.r / 2, st.r, st.r);
    }
    g.globalAlpha = 1; g.globalCompositeOperation = "source-over";
    return anim;
  }

  let net = null, focusId = null, active = false;
  let orbit = false;            // laboratorio 3D: un dito ruota la scena
  let sfera = false;            // laboratorio 3D: posizioni sulla sfera invece che sul piano
  const pos3 = new Map();       // id -> { x, y, z }: posizioni della vista Sfera
  let viviPrima = new Set();    // i nodi presenti all'ultimo layout (per accorgersi di quelli che tornano dopo una chiusura)
  const spost = new Map();      // id -> { x, y, z }: scarto che si assorbe a vista dopo un rilassamento (mostrato = pos3 + spost)
  const vis = new Map();        // id -> { h, th, grow, dom, cache }
  const edgeDom = new Map();    // "a|b" -> <line>
  const cam = { x: 0, y: 0, z: 0, tx: 0, ty: 0, tz: 0, cz: 0, tcz: 0, yaw: 0, pitch: 0, tyaw: 0, tpitch: 0, wyaw: 0, wpitch: 0, vx: 0, vy: 0, q: Q_ID, tq: Q_ID, M: eulerMat(0, 0), spin: 0, viaggio: null, crescita: null, orienta: null };
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
    vis.clear(); edgeDom.clear(); pos3.clear(); spost.clear(); viviPrima = new Set();
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
    // Contano solo i nodi presenti: le posizioni di quelli chiusi restano memorizzate (riaprendoli
    // tornano dove stavano) ma non devono togliere posto agli altri.
    const vivi = [];
    for (const [id, q] of pos3) if (net.nodes.has(id)) vivi.push(q);
    const cen = { x: 0, y: 0, z: 0 };
    for (const q of vivi) { cen.x += q.x; cen.y += q.y; cen.z += q.z; }
    const nn = Math.max(1, vivi.length);
    cen.x /= nn; cen.y /= nn; cen.z /= nn;
    const nuovi = [];
    // Un ramo richiuso e riaperto ritrova le posizioni di prima, che nel frattempo possono essere state occupate: va ricontrollato.
    let tornati = false;
    for (const id of net.nodes.keys()) if (pos3.has(id) && !viviPrima.has(id)) { tornati = true; break; }
    const raggiProva = vivi.length >= RETE_FITTA ? [...RAGGI, RAGGIO_EXTRA] : RAGGI;
    // Distanza fra un punto e un altro come la vedrebbe l'occhio (proiettata, con la prospettiva) e
    // distanza vera nello spazio: la prima evita le sovrapposizioni che si vedono, la seconda tiene i
    // nodi larghi anche quando si ruota. Conta soprattutto lo schermo (x,y): due nodi a profondità
    // diverse ma sulla stessa linea di vista si sovrapporrebbero comunque.
    const distanza = (x, y, z, q) => {
      const sx = F_ORBIT / Math.max(300, F_ORBIT + z - cen.z), sq = F_ORBIT / Math.max(300, F_ORBIT + q.z - cen.z);
      const vis_ = Math.hypot(q.x * sq - x * sx, q.y * sq - y * sx);
      const vero = Math.hypot(q.x - x, q.y - y, (q.z - z) * PESO_Z * 2);
      return 0.65 * vis_ + 0.35 * vero;
    };
    const libero = (x, y, z) => { let m = Infinity; for (const q of vivi) m = Math.min(m, distanza(x, y, z, q)); return m; };
    const registra = (n, q) => { pos3.set(n.id, q); vivi.push(q); nuovi.push(n.id); };
    const padreDi = (n) => (n.parent && pos3.has(n.parent) ? n.parent : net.rootId);
    // Un nodo da solo: va nella direzione (fra N_DIREZIONI, lontano dal nonno) che lo tiene più lontano da tutti.
    const piazzaSingolo = (n) => {
      const pp = pos3.get(padreDi(n));
      const gp = n.parent ? pos3.get(net.nodes.get(n.parent)?.parent) : null;
      let fuori = null;
      if (gp) {
        const ox = pp.x - gp.x, oy = pp.y - gp.y, oz = pp.z - gp.z, l = Math.hypot(ox, oy, oz) || 1;
        fuori = [ox / l, oy / l, oz / l];
      }
      let best = null, bestD = -Infinity;
      for (const rm of raggiProva) for (const d of DIREZIONI) {
        if (fuori && d[0] * fuori[0] + d[1] * fuori[1] + d[2] * fuori[2] < -0.75) continue;   // solo non tornare indietro verso il nonno
        const x = pp.x + d[0] * R * rm * kx, y = pp.y + d[1] * R * rm * ky, z = pp.z + d[2] * R * rm * Z_SCHIACCIATA;
        // Leggera attrazione verso il baricentro della rete: i nuovi nodi riempiono i vuoti attorno invece di allungarla a striscia.
        const m = libero(x, y, z) - (PESO_BARICENTRO * Math.hypot(x - cen.x, y - cen.y, z - cen.z) + PESO_LUNGHEZZA * (rm - 1) * R);
        if (m > bestD) { bestD = m; best = { x, y, z }; }
      }
      registra(n, best || { x: pp.x + R, y: pp.y, z: pp.z });
    };
    // I figli aperti insieme di uno stesso nodo si dispongono in modo REGOLARE attorno a lui (come nel
    // Piatto): un anello attorno alla radice, un ventaglio verso l'esterno per gli altri, con un po'
    // di profondità alternata. Si prova qualche raggio e qualche rotazione e si sceglie quello che sta
    // più lontano dagli altri nodi; se non c'è posto (rete fitta) si torna alla scelta nodo per nodo.
    const piazzaGruppo = (padreId, figli) => {
      const k = figli.length;
      if (k < 2) return false;
      // Solo alla PRIMA apertura: i figli aggiunti dopo (il "+N") riempiono i vuoti fra quelli che ci sono già.
      for (const x of net.nodes.values()) if (x.parent === padreId && pos3.has(x.id)) return false;
      const pp = pos3.get(padreId);
      const nonnoId = net.nodes.get(padreId)?.parent;
      const gp = nonnoId ? pos3.get(nonnoId) : null;
      const passo = (2 * Math.PI) / k;
      let direzioni;
      if (!gp) {
        // Anello sul piano dello schermo, dall'alto in senso orario, con la profondità che alterna.
        // Gli angoli sono quelli dello SCHERMO: il punto sta sull'ellisse (kx, ky) esattamente a quell'angolo.
        // La prospettiva rimpicciolisce i nodi più lontani: il loro raggio si allarga di quel tanto, così
        // sullo schermo l'anello sembra regolare anche con la profondità alternata.
        direzioni = (rot, rm) => figli.map((_, i) => {
          const t = -Math.PI / 2 + rot + i * passo, c = Math.cos(t), sn = Math.sin(t);
          const rho = 1 / Math.hypot(c / (kx * 0.6), sn / ky);
          const dz = i % 2 ? 0.22 : -0.22;
          const f = (F_ORBIT + dz * R * rm * Z_SCHIACCIATA) / F_ORBIT;
          return [rho * c / kx * f, rho * sn / ky * f, dz];
        });
      } else {
        // Ventaglio a cono attorno alla direzione "verso l'esterno" (dal nonno al padre).
        let ox = pp.x - gp.x, oy = pp.y - gp.y, oz = pp.z - gp.z;
        const lo = Math.hypot(ox, oy, oz) || 1; ox /= lo; oy /= lo; oz /= lo;
        let ux = 0, uy = 1, uz = 0;                       // "su" dello schermo, reso perpendicolare a o
        const dot = uy * oy; ux -= dot * ox; uy -= dot * oy; uz -= dot * oz;
        let lu = Math.hypot(ux, uy, uz);
        if (lu < 1e-3) { ux = 1; uy = 0; uz = 0; const d2 = ux * ox; ux -= d2 * ox; uy -= d2 * oy; uz -= d2 * oz; lu = Math.hypot(ux, uy, uz) || 1; }
        ux /= lu; uy /= lu; uz /= lu;
        const vx = oy * uz - oz * uy, vy = oz * ux - ox * uz, vz = ox * uy - oy * ux;
        const alfa = k <= 2 ? 0.87 : k <= 4 ? 1.05 : 1.26;               // mezzo angolo del cono (50°, 60°, 72°)
        direzioni = (rot, rm) => figli.map((_, i) => {
          const b = rot + i * passo, ca = Math.cos(alfa), sa = Math.sin(alfa), cb = Math.cos(b), sb = Math.sin(b);
          return [ox * ca + (ux * cb + vx * sb) * sa, oy * ca + (uy * cb + vy * sb) * sa, oz * ca + (uz * cb + vz * sb) * sa];
        });
      }
      let migliore = null, bestScore = -Infinity, bestLibero = 0;
      for (const rm of raggiProva) for (const frazione of ROTAZIONI_ANELLO) {
        const pts = direzioni(frazione * passo, rm).map(d => ({ x: pp.x + d[0] * R * rm * kx, y: pp.y + d[1] * R * rm * ky, z: pp.z + d[2] * R * rm * Z_SCHIACCIATA }));
        let m = Infinity;
        for (const q of pts) m = Math.min(m, libero(q.x, q.y, q.z));
        for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) m = Math.min(m, distanza(pts[i].x, pts[i].y, pts[i].z, pts[j]));
        let dc = 0; for (const q of pts) dc += Math.hypot(q.x - cen.x, q.y - cen.y, q.z - cen.z);
        // Oltre un certo spazio non serve altro: a parità si preferisce l'anello più stretto (sta meglio nello schermo).
        const score = Math.min(m, SPAZIO_OK_GRUPPO * R) - (PESO_BARICENTRO * dc / k + PESO_LUNGHEZZA * (rm - 1) * R);
        if (score > bestScore) { bestScore = score; migliore = pts; bestLibero = m; }
      }
      if (!migliore || bestLibero < SPAZIO_MIN_GRUPPO * R) return false;
      figli.forEach((n, i) => registra(n, migliore[i]));
      return true;
    };
    const daPiazzare = [...net.nodes.values()].filter(n => !pos3.has(n.id));
    const fatti = new Set();
    for (const n of daPiazzare) {
      if (fatti.has(n.id) || pos3.has(n.id)) continue;
      const padreId = padreDi(n);
      const figli = daPiazzare.filter(x => !fatti.has(x.id) && !pos3.has(x.id) && padreDi(x) === padreId);
      for (const f of figli) fatti.add(f.id);
      if (!piazzaGruppo(padreId, figli)) for (const f of figli) piazzaSingolo(f);
    }
    if (nuovi.length || (tornati && viviPrima.size)) rilassa(R, cen.z);
    viviPrima = new Set(net.nodes.keys());
  }

  // Dopo aver piazzato nodi nuovi: quelli che sullo schermo (a vista frontale) restano troppo
  // vicini si respingono, come molle, finché c'è posto per tutti. Calcolo deterministico (stesso
  // ordine, nessun caso). La radice sta ferma; gli altri non si allontanano troppo da dove erano.
  // I nodi già visibili non scattano: lo scarto si assorbe a vista (spost).
  function rilassa(R, cz) {
    const ids = [...net.nodes.keys()].filter(id => pos3.has(id));
    const n = ids.length;
    if (n < 2) return;
    const P = ids.map(id => pos3.get(id));
    const casa = P.map(q => ({ x: q.x, y: q.y, z: q.z }));
    const prima = ids.map((id, i) => {
      const o = vis.has(id) ? spost.get(id) : null;
      return vis.has(id) ? { x: P[i].x + (o ? o.x : 0), y: P[i].y + (o ? o.y : 0), z: P[i].z + (o ? o.z : 0) } : null;
    });
    const fisso = ids.map(id => id === net.rootId);
    const sc = P.map(() => 1);
    const maxXY = R * RILASSA_MAX, maxZ = R * RILASSA_MAX * Z_SCHIACCIATA;
    for (let it = 0; it < RILASSA_PASSI; it++) {
      for (let i = 0; i < n; i++) sc[i] = F_ORBIT / Math.max(300, F_ORBIT + P[i].z - cz);
      for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
        let ux = P[i].x * sc[i] - P[j].x * sc[j];
        let uy = (P[i].y * sc[i] - P[j].y * sc[j]) * SPAZIO_ASPETTO;
        let uz = (P[i].z - P[j].z) * SPAZIO_PESO_Z;
        let d = Math.hypot(ux, uy, uz);
        if (d >= SPAZIO_NODO) continue;
        if (d < 1e-3) { const a = (i * 7 + j * 13) * 2.399963; ux = Math.cos(a); uy = Math.sin(a); uz = 0; d = 1; }
        const f = (SPAZIO_NODO - d) * RILASSA_FORZA;
        const nx = ux / d, ny = uy / d, nz = uz / d;
        const pi = fisso[i] ? 0 : fisso[j] ? 1 : 0.5, pj = fisso[j] ? 0 : fisso[i] ? 1 : 0.5;
        P[i].x += nx * f * pi / sc[i]; P[i].y += ny * f * pi / sc[i] / SPAZIO_ASPETTO; P[i].z += nz * f * pi / SPAZIO_PESO_Z;
        P[j].x -= nx * f * pj / sc[j]; P[j].y -= ny * f * pj / sc[j] / SPAZIO_ASPETTO; P[j].z -= nz * f * pj / SPAZIO_PESO_Z;
      }
      for (let i = 0; i < n; i++) {
        if (fisso[i]) continue;
        const q = P[i], c = casa[i];
        q.x += (c.x - q.x) * RILASSA_CASA; q.y += (c.y - q.y) * RILASSA_CASA; q.z += (c.z - q.z) * RILASSA_CASA;
        const dx = q.x - c.x, dy = q.y - c.y, l = Math.hypot(dx, dy);
        if (l > maxXY) { q.x = c.x + dx * maxXY / l; q.y = c.y + dy * maxXY / l; }
        q.z = c.z + Math.max(-maxZ, Math.min(maxZ, q.z - c.z));
      }
    }
    for (let i = 0; i < n; i++) {
      const a = prima[i];
      if (!a) continue;
      const o = { x: a.x - P[i].x, y: a.y - P[i].y, z: a.z - P[i].z };
      if (Math.hypot(o.x, o.y, o.z) > 1) spost.set(ids[i], o); else spost.delete(ids[i]);
    }
    if (spost.size) kick();
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
      for (const [id, q] of pos3) {
        if (net && !net.nodes.has(id)) continue;   // i nodi chiusi non contano
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
    // Crescita dal Piatto alla 3D: i nodi passano dalle posizioni piatte a quelle della
    // sfera, la camera (partita dalla vista del Piatto) li segue e la scena si inclina un
    // po' e si riassesta, così la profondità si vede nascere.
    if (cam.crescita) {
      const c = cam.crescita, u = Math.max(0, Math.min(1, (now - c.t0) / c.dur));
      const e = u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2;
      mixG = e;
      const f = mixPos(focusId);
      cam.tx = cam.x = f.x - (1 - e) * c.panX;
      cam.ty = cam.y = f.y - (1 - e) * c.panY;
      cam.tcz = cam.cz = f.z;
      cam.tz = cam.z = c.zStart + (c.tzFinale - c.zStart) * e;
      cam.q = cam.tq = qSlerp(Q_ID, c.swing, Math.sin(Math.PI * e));
      moving = true;
      if (u >= 1) { mixG = 1; cam.crescita = null; cam.q = cam.tq = Q_ID; c.fine?.(); }
    }
    // Assestamento della scena dopo l'arrivo a una tappa: ruota attorno al nodo, che sta
    // al centro, quindi resta fermo mentre i vicini gli girano attorno (si vede la profondità).
    if (cam.orienta) {
      const o = cam.orienta, u = Math.max(0, Math.min(1, (now - o.t0) / o.dur));
      const e = u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2;
      cam.q = cam.tq = qSlerp(o.qa, o.qb, e);
      moving = true;
      if (u >= 1) cam.orienta = null;
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
      // La profondità (avvicinarsi al piano del nodo) cambia la scala di tutto attorno al centro,
      // proprio come lo zoom: la si fa alla fine, quando il nodo è già al centro, altrimenti un
      // nodo dietro il piano sembra allontanarsi un attimo prima di arrivare.
      cam.tcz = cam.cz = v.a.cz + (v.b.cz - v.a.cz) * e * e * e;
      // Lo zoom: avvicinarsi ingrandisce tutto attorno al centro e allontanerebbe il nodo
      // di destinazione finché non è centrato, quindi si avvicina SOLO alla fine; allontanarsi
      // lo accorcia, quindi si fa subito. Così il nodo si avvicina al centro in modo costante.
      const ez = v.b.z > v.a.z ? e * e * e : 1 - Math.pow(1 - e, 3);
      let zv = v.a.z + (v.b.z - v.a.z) * ez;
      // Tappe lontane: a metà viaggio la camera si allontana (si vede la rete intorno) e poi rientra
      // nel nodo. È un fattore sulla scala, così funziona a qualunque livello di zoom, e vale 1 alle due estremità.
      if (v.dip < 1) {
        const campana = Math.pow(Math.sin(Math.PI * e), 1.4), sc = F / Math.max(1, F - zv) * (1 - (1 - v.dip) * campana);
        zv = Math.max(zMin(), F - F / sc);
      }
      cam.tz = cam.z = zv;
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

    for (const [id, o] of spost) {
      o.x = approach(o.x, 0, dt, SCIVOLA_TAU); o.y = approach(o.y, 0, dt, SCIVOLA_TAU); o.z = approach(o.z, 0, dt, SCIVOLA_TAU);
      if (Math.hypot(o.x, o.y, o.z) < 0.4) spost.delete(id);
      moving = true;
    }
    for (const v of vis.values()) {
      const h = approach(v.h, v.th, dt, 140);
      v.h = Math.abs(h - v.th) > 0.002 ? h : v.th;
      const g = approach(v.grow, 1, dt, 120);
      v.grow = 1 - g < 0.002 ? 1 : g;
      if (v.h !== v.th || v.grow !== 1) moving = true;
    }

    if (drawSpace()) moving = true;
    draw();
    if (moving) raf = requestAnimationFrame(frame);
  }

  // Posizione di un nodo mentre la rete "cresce" dal Piatto alla sfera: parte da dove
  // stava nel Piatto (x, y della rete piatta, a profondità zero) e arriva alla sua
  // posizione sulla sfera.
  function mostrata(id) {
    const q = pos3.get(id), o = spost.get(id);
    return q && o ? { x: q.x + o.x, y: q.y + o.y, z: q.z + o.z } : q;
  }
  function mixPos(id) {
    const n = net.nodes.get(id), q0 = mostrata(id) || { x: 0, y: 0, z: 0 };
    return n ? mixQ(n, q0) : q0;
  }
  function mixQ(nodo, q0) {
    if (mixG >= 1) return q0;
    const fx = nodo.x ?? q0.x, fy = nodo.y ?? q0.y;
    return { x: fx + (q0.x - fx) * mixG, y: fy + (q0.y - fy) * mixG, z: q0.z * mixG };
  }

  function project(n, v) {
    const p = n.parent && net.nodes.get(n.parent);
    const e = 1 - Math.pow(1 - v.grow, 3);            // i nuovi escono dal genitore
    let wx, wy, dz;
    if (sfera) {
      const q0 = mostrata(n.id);
      if (!q0) return { x: 0, y: 0, s: 0, z: 0, dietro: true };
      const q = mixQ(n, q0), pq0 = p && mostrata(p.id), pq = pq0 ? mixQ(p, pq0) : null;
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
    return { x: W / 2 + dx * s, y: H / 2 + dy * s, s: orbit ? dimensione(s, nodeZoom) : s, z };
  }

  // Grandezza del nodo in 3D; durante la crescita parte da quella del Piatto (la scala
  // dello zoom di allora) e arriva a quella normale.
  function dimensione(s, nodeZoom) {
    const normale = Math.max(NODE_MIN, Math.min(NODE_MAX, Math.min(s, S_MAX_ORBIT) * NODE_K)) * nodeZoom * nodeK;
    return mixG < 1 && cam.crescita ? cam.crescita.zoom + (normale - cam.crescita.zoom) * mixG : normale;
  }

  function draw() {
    const proj = new Map();
    for (const [id, v] of vis) {
      const n = net.nodes.get(id);
      const p = project(n, v);
      const fuori = p.dietro || p.x < -CULL_MARGIN || p.x > W + CULL_MARGIN || p.y < -CULL_MARGIN || p.y > H + CULL_MARGIN;
      let o = fuori ? 0 : opacityAt(v.h) * Math.min(1, v.grow * 1.6);
      const ef = enfasi.get(id);
      if (ef && ef.k > 0 && !fuori) {   // fuori campo (o dietro la camera) resta nascosto: la sua proiezione non è valida
        if (o === 0) o = 0.05;
        o = o + (1 - o) * ef.k;                 // esce dalla nebbia
        p.s *= 1 + 0.45 * ef.k;                  // e cresce
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
  // Dal Piatto alla 3D (vedi cresci): quanto la rete è già "3D" (0 = com'è nel Piatto,
  // 1 = sfera), e la sua animazione.
  let mixG = 1;
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
    if (e.button > 0 || !net || !active) return;
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
    cam.tz = Math.max(zMin(), Math.min(zMax(), F + focusPlane() - F / sNew));
    kick();
  }, { passive: false });

  // Schermo intero, rotazione: il riquadro cambia misura.
  const measure = () => { W = container.clientWidth; H = container.clientHeight; dimensionaSpazio(); kick(); };
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
    // Dal Piatto alla 3D con un effetto a crescita: la rete parte com'era nel Piatto
    // (stesse posizioni, stessa grandezza, stessa vista) e si apre in profondità fino
    // alla sfera. `pan`/`zoom`: la vista del Piatto da cui si parte. Risolve alla fine.
    cresci({ ms = 1700, panX = 0, panY = 0, zoom = 1 } = {}) {
      return new Promise(risolvi => {
        if (!net || !sfera) { risolvi(); return; }
        layout3d();
        // Dove arriverà la camera (zoom compreso), calcolato sulla sfera finale.
        const salva = { tx: cam.tx, ty: cam.ty, tcz: cam.tcz, tz: cam.tz, tq: cam.tq };
        const f3 = pos3.get(focusId) || { x: 0, y: 0, z: 0 };
        cam.tx = f3.x; cam.ty = f3.y; cam.tcz = f3.z; cam.tz = 0; cam.tq = Q_ID;
        inquadra(focusId);
        const tzFinale = cam.tz;
        Object.assign(cam, salva);
        cam.viaggio = null; cam.orienta = null; cam.spin = 0; cam.vx = cam.vy = 0; cam.wyaw = cam.wpitch = 0;
        const zStart = F - F / Math.max(0.1, zoom);
        cam.crescita = { t0: performance.now(), dur: ms, panX, panY, zoom, zStart, tzFinale, swing: qNorm(qMul(qAsseX(-0.2), qAsseY(0.55))), fine: risolvi };
        mixG = 0;
        // Primo fotogramma: identico al Piatto.
        const f = mixPos(focusId);
        cam.tx = cam.x = f.x - panX; cam.ty = cam.y = f.y - panY; cam.tcz = cam.cz = f.z;
        cam.tz = cam.z = zStart; cam.q = cam.tq = Q_ID; cam.M = qMat(Q_ID);
        draw();
        kick();
      });
    },
    // ── Tour ──
    // Viaggia (piano, in `ms`) fino al nodo e inquadra i suoi collegamenti, senza
    // aprirlo né farlo diventare attivo. Risolve all'arrivo.
    // `via`: id dei nodi da sorvolare lungo i collegamenti, nell'ordine; `yaw`/`pitch`:
    // la leggera rotazione con cui si arriva.
    tourVai(id, ms, { via = [], yaw = 0, pitch = 0 } = {}) {
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
        // L'inquadratura si calcola con l'orientazione con cui si ARRIVERÀ (la scena si
        // assesta dopo l'arrivo, vedi tourOrienta): così i collegamenti restano dentro.
        const tqPrima = cam.tq;
        cam.tq = qNorm(qMul(qAsseX(pitch), qAsseY(yaw)));
        inquadra(id);
        cam.tq = tqPrima;
        const a = { x: da.x, y: da.y, cz: da.cz, z: da.z };
        const b = { x: cam.tx, y: cam.ty, cz: cam.tcz, z: cam.tz };
        cam.tx = a.x; cam.ty = a.y; cam.tcz = a.cz; cam.tz = a.z;   // si parte da dove si è
        // Se si è già lì (la prima tappa è il tuo nodo, dove la camera sta già) non
        // serve aspettare un intero viaggio.
        const lontano = Math.hypot(b.x - a.x, b.y - a.y, b.cz - a.cz) + Math.abs(b.z - a.z) * 0.5;
        // Percorso: DIRITTO verso il nodo. La camera sorvola i nodi intermedi lungo i
        // collegamenti solo se stanno davvero sulla strada (fra partenza e arrivo, poco
        // lontani dalla retta): un nodo fuori mano farebbe sembrare che la camera
        // sbagli direzione. Niente archi laterali e niente rotazione durante il viaggio.
        const ab = { x: b.x - a.x, y: b.y - a.y, z: b.cz - a.cz };
        const len2 = ab.x * ab.x + ab.y * ab.y + ab.z * ab.z || 1;
        const sulla = [];
        for (const vid of via) {
          const q = worldPos(vid);
          if (!q) continue;
          const qa = { x: q.x - a.x, y: q.y - a.y, z: (sfera ? q.z : 0) - a.cz };
          const t = (qa.x * ab.x + qa.y * ab.y + qa.z * ab.z) / len2;
          const lat = Math.hypot(qa.x - t * ab.x, qa.y - t * ab.y, qa.z - t * ab.z);
          if (t > 0.08 && t < 0.92 && lat < 0.3 * Math.sqrt(len2)) sulla.push({ t, p: { x: q.x, y: q.y, cz: sfera ? q.z : 0 } });
        }
        sulla.sort((m, n) => m.t - n.t);
        const punti = [a, ...sulla.map(x => x.p), { x: b.x, y: b.y, cz: b.cz }];
        const durata = lontano < 40 ? Math.min(ms, 600) : ms * (1 + Math.min(0.9, 0.45 * sulla.length));
        // Se la tappa è lontana (rispetto a quanto si vede) il viaggio passa da uno zoom out leggero: più è lontana, più si apre.
        const visto = Math.min(W, H) / (F / Math.max(1, F - b.z)), rapporto = lontano / Math.max(1, visto);
        const dip = rapporto < 0.7 ? 1 : Math.max(0.4, Math.min(0.78, 0.84 - 0.12 * rapporto));
        cam.viaggio = {
          a, b, t0: performance.now(), dur: durata, fine: risolvi, dip,
          curva: punti.length > 2 ? creaCurva(punti) : null
        };
        kick();
      });
    },
    // Dopo l'arrivo: la scena si assesta (yaw, pitch) in `ms`, ruotando attorno al nodo centrato.
    tourOrienta(yaw, pitch, ms) {
      cam.orienta = { t0: performance.now(), dur: ms, qa: cam.tq, qb: qNorm(qMul(qAsseX(pitch), qAsseY(yaw))) };
      kick();
    },
    // Panoramica sulla rete intera e un giro completo attorno, in `ms`.
    tourRuota(ms) {
      cam.orienta = null;
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
      cam.orienta = null;
      for (const f of enfasi.values()) f.kT = 0;
      cam.spin = 0; nodeKT = 1;
      cam.viaggio = null;
      // Se ci si ferma durante la crescita Piatto→3D la si lascia finire (meno di 2 s): fermarla a
      // metà farebbe scattare la rete sulla posizione finale e non risolverebbe la promessa di cresci().
      if (cam.crescita) { kick(); return; }
      cam.tq = cam.q;   // si resta com'è, senza scatti
      cam.tx = cam.x; cam.ty = cam.y; cam.tcz = cam.cz; cam.tz = cam.z;
      if (torna && net) {
        const w = worldPos(focusId);
        if (w) {
          const a = { x: cam.x, y: cam.y, cz: cam.cz, z: cam.z };
          cam.tx = w.x; cam.ty = w.y; if (sfera) cam.tcz = w.z;
          // L'inquadratura si calcola con l'orientazione di ARRIVO (frontale), non con quella inclinata di ora.
          const tqOra = cam.tq;
          cam.tq = Q_ID;
          cam.tz = 0; clampCam(); inquadra(focusId);
          cam.tq = tqOra;
          const b = { x: cam.tx, y: cam.ty, cz: cam.tcz, z: cam.tz };
          cam.tx = a.x; cam.ty = a.y; cam.tcz = a.cz; cam.tz = a.z;
          cam.viaggio = { a, b, t0: performance.now(), dur: 1700, fine: null, qa: cam.tq, qb: Q_ID };
        }
      }
      kick();
    },
    show() { active = true; container.classList.remove("hidden"); preparaSpazio(() => { spSig = null; kick(); }); measure(); },
    // Nascosta si svuota: tornando a Spaziale riparte allineata alla rete,
    // senza tenere in memoria un DOM che nessuno vede.
    hide() { active = false; container.classList.add("hidden"); clear(); },
    clear
  };
}
