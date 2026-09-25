// ─── dna-view.js ─────────────────────────────────────────────────────────────
// Disegna la rete costruita da dna.js. Tutta la logica di "chi si collega a
// chi" sta là: qui ci sono solo geometria, DOM e camera.
//
// Come è disegnata: i nodi sono <button> in position:absolute su un piano
// virtuale illimitato, gli archi sono <line> dentro un unico <svg> con
// overflow:visible (così le coordinate negative si vedono lo stesso). Nessuna
// libreria, nessun canvas, nessuna simulazione a forze: con al massimo 5 figli
// per nodo un layout radiale calcolato una volta sola basta, costa nulla e
// soprattutto non fa ballare i nodi già piazzati ad ogni apertura.

import {
  buildIndex, createNetwork, expand, collapse, hopsFrom, sharedCountOf, LIKE_THRESHOLD
} from "./dna.js?v=60a7184";
import { escapeHtml } from "./cine-core.js?v=60a7184";
import { avatarHtml, haptic } from "./ui.js?v=60a7184";

// Quanti vicini apre un tap, e a che distanza dal genitore. Il tetto e' sempre
// stato una questione di spazio, non di gusto: con cinque figli su un ventaglio
// di 180 gradi gli adiacenti distano 2*R*sin(22.5 gradi), che sotto i 123px
// violerebbe MIN_GAP — e a quel raggio il ventaglio chiede ~340px di riquadro
// per non uscire dall'inquadratura. Dove quello spazio c'e' (riquadro
// dell'esplorazione su un telefono normale) i rami sono cinque, dove non c'e'
// restano quattro, com'era prima. Il pannello qui sotto racconta comunque tutto
// quello che un nodo in piu' avrebbe mostrato.
const NEIGHBOURS_WIDE = 5;
const NEIGHBOURS_NARROW = 4;
const STAGE_FOR_WIDE = 340;   // altezza del riquadro che serve al ventaglio da 5

function ramiPerTap() {
  return (el("dnaStage")?.clientHeight || 0) >= STAGE_FOR_WIDE ? NEIGHBOURS_WIDE : NEIGHBOURS_NARROW;
}
function raggio() {
  return ramiPerTap() === NEIGHBOURS_WIDE ? 126 : 112;
}

// Budget DOM: oltre questi limiti (misurati DALLA camera, non dalla radice,
// altrimenti esplorando in profondità sparirebbe tutto) i nodi lontani escono
// dal DOM. Restano comunque in memoria nella rete: tornando indietro
// ricompaiono identici, stesse posizioni.
// L'etichetta ora arriva fin dove arriva il DOM: un nodo a quattro salti era
// un pallino anonimo, e col riquadro grande il nome ci sta. Resta la sfumatura
// per profondità (depthClass) a dire quanto è lontano. Lo stadio intermedio
// "nodo senza etichetta" (.is-far) non si verifica con questi due valori
// uguali, ma il meccanismo resta valido se il budget DOM si allarga.
const MAX_DOM_NODES = 32;
const LABEL_MAX_HOPS = 4;
const DOM_MAX_HOPS = 4;

const MIN_GAP = 94;         // distanza minima tra due nodi qualsiasi (nodo 62px + etichetta)
const PLACE_TRIES = 24;

// posterUrl() di cine-core serve immagini w500: qui i poster stanno in un
// nodo da 48px e possono essercene decine a schermo. w154 è circa dieci volte
// più leggero e a questa dimensione indistinguibile.
const DNA_POSTER = "https://image.tmdb.org/t/p/w185";

let index = null;
let net = null;
let focusId = null;
let signature = "";
let bound = false;

// Chi sta dentro la rete. null = tutto il gruppo, cioè esattamente il
// comportamento di sempre. Quando invece è una lista, quei nomi vengono
// passati a buildIndex, che scarta i voti di tutti gli altri PRIMA di
// costruire il grafo: film, generi e registi si ricalcolano su quelle
// persone soltanto. Non è un filtro grafico sui nodi già disegnati — la rete
// è proprio un'altra rete, costruita dallo stesso identico motore.
let selectedPeople = null;

// L'ultimo contesto passato da app.js, così il selettore può ridisegnare da
// solo senza farsi ripassare db/users/currentUser ad ogni interazione.
let ctx = null;
let sheetOpen = false;

// Spostamento manuale della camera rispetto al nodo attivo (vedi il
// trascinamento in fondo al file). Si azzera ad ogni tap su un nodo: toccare
// un nodo ricentra sempre, quindi non ci si perde mai fuori dalla rete.
let panX = 0;
let panY = 0;
let shownIds = [];          // i nodi davvero nel DOM all'ultimo render

// Oltre questa distanza in pixel un trascinamento non è più un tap. Sotto,
// il dito che si muove di poco mentre tocca non deve aprire niente per
// sbaglio, ma nemmeno sembrare che l'app non abbia sentito il tocco.
const DRAG_THRESHOLD = 8;
const PAN_MARGIN = 48;      // quanto si può andare oltre l'ultimo nodo

const el = (id) => document.getElementById(id);

// ─── COSTRUZIONE / RICOSTRUZIONE ─────────────────────────────────────────────

// La rete si ricostruisce solo se sono cambiati l'utente o i voti: altrimenti
// tornando sulla schermata si perderebbe tutto quello che si è esplorato.
function librarySignature(db, currentUser) {
  // Somma dei voti oltre al loro numero: così cambia anche quando un voto
  // viene solo modificato (8 → 5 toglie un film dalla rete, e il conteggio
  // da solo non se ne accorgerebbe).
  let n = 0, sum = 0;
  for (const t of db) {
    for (const v of Object.values(t.votes || {})) { n++; sum += Number(v?.vote) || 0; }
  }
  // La selezione entra nella firma: cambiarla deve ricostruire la rete, non
  // riusare quella di prima.
  const chi = selectedPeople ? selectedPeople.join(",") : "*";
  return `${currentUser}|${chi}|${db.length}|${n}|${sum}`;
}

// Quanti titoli ha amato ciascuno, su TUTTA la libreria: è una proprietà
// della persona, non della selezione, quindi nel selettore il numero non
// deve ballare a seconda di chi è spuntato.
function likedCounts(db) {
  const conta = new Map();
  for (const t of db || []) {
    for (const [nome, v] of Object.entries(t.votes || {})) {
      if (Number(v?.vote) >= LIKE_THRESHOLD) conta.set(nome, (conta.get(nome) || 0) + 1);
    }
  }
  return conta;
}

// Da dove parte la rete. Normalmente da te; se però la selezione non ti
// include, si parte da chi, fra i selezionati, ha amato più titoli — è la
// persona da cui la rete racconta di più, e la scelta resta deterministica
// (a parità di titoli vince il nome in ordine alfabetico).
function rootUserFor(persone, me) {
  if (persone.includes(me) && index.byPerson.get(me)?.length) return me;
  const ordinati = persone
    .map(u => ({ u, n: index.byPerson.get(u)?.length || 0 }))
    .filter(x => x.n > 0)
    .sort((a, b) => b.n - a.n || a.u.localeCompare(b.u));
  return ordinati[0]?.u || null;
}

export function showDna({ db, users, currentUser }) {
  const stage = el("dnaStage");
  if (!stage) return;
  ctx = { db, users, currentUser };

  // La spiegazione estesa (vedi bindIntroToggle) non resta aperta da una
  // visita alla schermata all'altra: chi l'ha già letta non se la ritrova
  // ancora lì la volta dopo, occupando spazio per niente.
  const introToggle = el("dnaIntroToggle");
  const introFull = el("dnaIntroFull");
  if (introToggle && introFull) {
    introToggle.setAttribute("aria-expanded", "false");
    introFull.hidden = true;
  }

  if (!db || !db.length) {
    renderMessage("Sto caricando la libreria…");
    return;
  }

  // Una selezione che nel frattempo non esiste più (utente rimosso dal
  // gruppo) torna semplicemente a "Tutti" invece di svuotare la rete.
  if (selectedPeople) {
    const vive = selectedPeople.filter(u => users.includes(u));
    selectedPeople = vive.length ? vive : null;
  }
  const persone = selectedPeople || users;

  const sig = librarySignature(db, currentUser);
  if (sig !== signature || !net) {
    signature = sig;
    index = buildIndex(db, persone);
    const radice = rootUserFor(persone, currentUser);
    if (!radice) {
      net = null;
      renderPeopleControl();
      renderMessage(selectedPeople
        ? "Nessuno dei selezionati ha ancora votato un titolo 7 o più."
        : "Vota almeno un titolo con 7 o più: la rete parte da lì.");
      return;
    }
    net = createNetwork(index, radice);
    focusId = net.rootId;
    panX = 0; panY = 0;
    const root = net.nodes.get(net.rootId);
    root.x = 0;
    root.y = 0;
    // E qui la rete si ferma: un nodo solo, il tuo, e basta.
    //
    // Le versioni precedenti aprivano gia' qualcosa — prima i tuoi vicini,
    // poi un ponte verso un'altra persona, poi il titolo che unisce tutto il
    // gruppo — e ogni volta la schermata arrivava gia' piena, prima ancora
    // che tu avessi toccato niente. Con sette persone attorno a un titolo
    // erano nove nodi al primo sguardo, e da li' bastavano pochi tocchi per
    // renderla illeggibile. Adesso tutto quello che c'e' dentro ce l'hai
    // messo tu, un tocco alla volta.
  }

  renderPeopleControl();
  render();
}

// ─── SELETTORE DELLE PERSONE ─────────────────────────────────────────────────

// Etichetta discreta sul pulsante: dice lo stato senza occupare una riga in
// più. "Tutti" quando non c'è filtro, il nome quando è una sola. Con 2-3
// persone (la modalità condivisa, vedi dna.js::isModalitaCondivisa) i nomi
// separati da "+" invece del conteggio: è lo stesso posto in cui prima si
// leggeva "2 persone", ma dice CHI, non solo quanti — coerente col fatto che
// da qui in poi la rete racconta il loro incontro, non una lista.
function peopleLabel() {
  if (!selectedPeople) return "Tutti";
  if (selectedPeople.length === 1) return selectedPeople[0];
  if (selectedPeople.length <= 3) {
    return selectedPeople.map(u => u === ctx?.currentUser ? "Tu" : u).join(" + ");
  }
  return `${selectedPeople.length} persone`;
}

function renderPeopleControl() {
  const btn = el("dnaPeopleBtn");
  const label = el("dnaPeopleLabel");
  if (!btn || !label) return;
  label.textContent = peopleLabel();
  btn.classList.toggle("is-active", !!selectedPeople);
  btn.setAttribute("aria-expanded", sheetOpen ? "true" : "false");

  // Con un filtro attivo "almeno una persona" sarebbe ambiguo: la nota deve
  // dire che il conto è fatto solo su chi è stato scelto.
  const nota = el("dnaNote");
  if (nota) {
    nota.textContent = selectedPeople
      ? `Nella rete ci sono solo i titoli votati 7 o più da ${selectedPeople.length === 1 ? selectedPeople[0] : "almeno una delle persone scelte"}.`
      : "Nella rete ci sono solo i titoli votati 7 o più da almeno una persona.";
  }

  // Solo in modalità condivisa (2 o 3 persone): un numero secco, non una
  // percentuale — il denominatore di un "% di affinità" sarebbe arbitrario e
  // sembrerebbe un punteggio inventato. Stesso criterio di isMeetingPoint,
  // solo aggregato invece che per nodo. Con 3 persone il numero è fisiologicamente
  // più piccolo (intersezione più severa), ma sui dati reali del gruppo non è mai
  // zero: resta un dato interessante, non un vuoto imbarazzante.
  const affinity = el("dnaAffinity");
  if (affinity) {
    const n = selectedPeople?.length;
    let insieme = 0;
    if ((n === 2 || n === 3) && index) {
      for (const f of index.films.values()) if (f.fans.length === n) insieme++;
    }
    const chi = n === 2 ? "da entrambi" : "da tutti e tre";
    affinity.textContent = insieme > 0 ? `${insieme} ${insieme === 1 ? "titolo amato" : "titoli amati"} ${chi}.` : "";
  }
}

function renderPeopleSheet() {
  const lista = el("dnaPeopleList");
  if (!lista || !ctx) return;
  const conta = likedCounts(ctx.db);
  const tutti = !selectedPeople;

  const riga = (nome, attiva, meta, avatar) => `
    <button type="button" class="dna-sheet__row${attiva ? " is-active" : ""}" data-user="${escapeHtml(nome)}">
      ${avatar}
      <span class="dna-sheet__name">${escapeHtml(nome === "*" ? "Tutti" : nome)}</span>
      <span class="dna-sheet__meta">${escapeHtml(meta)}</span>
      <span class="dna-sheet__dot"></span>
    </button>`;

  lista.innerHTML = [
    riga("*", tutti, `${ctx.users.length} persone`, `<span class="dna-sheet__all">∗</span>`),
    ...ctx.users.map(u => {
      const n = conta.get(u) || 0;
      return riga(u, !tutti && selectedPeople.includes(u), `${n} amati`, avatarHtml(u, 26));
    })
  ].join("");
}

function togglePerson(nome) {
  if (nome === "*") { selectedPeople = null; return; }
  const attuale = selectedPeople ? [...selectedPeople] : [];
  const i = attuale.indexOf(nome);
  if (i === -1) attuale.push(nome);
  else attuale.splice(i, 1);
  // Deselezionare l'ultima persona non lascia una rete vuota: si torna a
  // "Tutti", che è anche il modo più veloce per rimettere tutto a posto.
  if (!attuale.length) { selectedPeople = null; return; }
  // Ordine stabile (quello del gruppo): la firma della rete non deve
  // cambiare solo perché ho spuntato gli stessi nomi in un ordine diverso.
  selectedPeople = ctx.users.filter(u => attuale.includes(u));
}

function openSheet(apri) {
  const sheet = el("dnaPeopleSheet");
  if (!sheet) return;
  sheetOpen = apri;
  if (apri) renderPeopleSheet();
  sheet.classList.toggle("hidden", !apri);
  renderPeopleControl();
}

// ─── ESPORTA RETE COME IMMAGINE ───────────────────────────────────────────────
// Solo in modalità condivisa (2 o 3 persone) e solo quando la rete è già
// grande abbastanza da valere la pena portarsela via: sotto la soglia il
// tasto sarebbe solo un'icona in più senza un motivo per esistere. Il file è
// ridisegnato da zero su un <canvas> dalle stesse posizioni x/y già calcolate
// per lo schermo — non è uno screenshot del DOM — e i numeri sotto sono
// esattamente quelli già calcolati altrove in questo file (dnaAffinity e la
// stessa intersezione, letta per genere): zero chiamate esterne, zero AI.
const EXPORT_MIN_NODES = 10;

function updateExportButton() {
  const btn = el("dnaExportBtn");
  if (!btn) return;
  const n = selectedPeople?.length;
  const condivisa = n === 2 || n === 3;
  const aperti = net ? [...net.nodes.values()].filter(x => x.x !== null).length : 0;
  btn.classList.toggle("hidden", !(condivisa && aperti >= EXPORT_MIN_NODES));
}

function personLabel(name) {
  return name === ctx?.currentUser ? "Tu" : name;
}

function exportCaptionData() {
  const persone = selectedPeople || [];
  const n = persone.length;
  const nomi = persone.map(personLabel);
  const peopleLine = nomi.length <= 1 ? nomi.join("") : `${nomi.slice(0, -1).join(", ")} & ${nomi[nomi.length - 1]}`;

  let insieme = 0;
  if ((n === 2 || n === 3) && index) {
    for (const f of index.films.values()) if (f.fans.length === n) insieme++;
  }
  const chi = n === 2 ? "da entrambi" : "da tutti e tre";
  const affinityLine = insieme > 0 ? `${insieme} ${insieme === 1 ? "titolo amato" : "titoli amati"} ${chi}.` : "";

  // Stessa intersezione di dnaAffinity, letta per genere invece che in totale.
  let genreTop = null;
  if ((n === 2 || n === 3) && index) {
    const tally = new Map();
    for (const f of index.films.values()) {
      if (f.fans.length !== n) continue;
      for (const g of f.genres) tally.set(g, (tally.get(g) || 0) + 1);
    }
    const top = [...tally.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    if (top) genreTop = { name: top[0], count: top[1] };
  }

  const nodeCount = net ? [...net.nodes.values()].filter(x => x.x !== null).length : 0;
  const dateLine = new Date().toLocaleDateString("it-IT", { day: "numeric", month: "long", year: "numeric" });

  return { peopleLine, affinityLine, genreTop, nodeCount, dateLine };
}

const EXPORT_COLORS = {
  bg: "#06090e", surface2: "#141d2a",
  text: "#f0f6fc", text2: "#a3b8cc", text3: "#62788e",
  border: "rgba(255,255,255,.10)",
  cyan: "#38bdf8", orange: "#ff9d4d", orange2: "#ffc48a",
  green: "#3ec97a", gold: "#ffd166",
  edgeAma: "rgba(56,189,248,.34)", edgeAppartiene: "rgba(255,157,77,.26)", edgeDiretto: "rgba(56,189,248,.22)",
  edgeShared: "rgba(62,201,122,.5)"
};

// Stessi criteri visivi della rete vera (is-shared verde, is-loved oro,
// is-root arancio, vedi styles.css) — qui come colore del bordo invece che
// come classe, perché il canvas non ha CSS.
function exportNodeRing(n) {
  if (isMeetingPoint(n)) return EXPORT_COLORS.green;
  if (lovedLevel(n)) return EXPORT_COLORS.gold;
  if (n.id === net.rootId) return EXPORT_COLORS.orange;
  return "rgba(255,255,255,.16)";
}

function exportNodeRadius(n) {
  if (n.type === "persona") return n.id === net.rootId ? 17 : 14;
  if (n.type === "film") return 11;
  return 9; // genere, regista
}

function roundRect(c, x, y, w, h, r) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

async function exportNetworkImage() {
  if (!net) return;
  const btn = el("dnaExportBtn");
  if (btn) btn.disabled = true;
  try {
    // I font sono già quelli dell'app (caricati da styles.css): questa
    // attesa serve solo a non disegnare testo prima che siano pronti.
    await (document.fonts?.ready || Promise.resolve());

    const W = 1080, H = 1560, PAD = 56;
    const canvas = document.createElement("canvas");
    canvas.width = W; canvas.height = H;
    const c = canvas.getContext("2d");

    c.fillStyle = EXPORT_COLORS.bg;
    c.fillRect(0, 0, W, H);
    const g1 = c.createRadialGradient(W * 0.5, 0, 0, W * 0.5, 0, W * 0.75);
    g1.addColorStop(0, "rgba(56,189,248,.10)"); g1.addColorStop(1, "rgba(56,189,248,0)");
    c.fillStyle = g1; c.fillRect(0, 0, W, H);
    const g2 = c.createRadialGradient(W, H, 0, W, H, W * 0.75);
    g2.addColorStop(0, "rgba(255,157,77,.09)"); g2.addColorStop(1, "rgba(255,157,77,0)");
    c.fillStyle = g2; c.fillRect(0, 0, W, H);

    const brandGrad = c.createLinearGradient(PAD, 0, PAD + 260, 0);
    brandGrad.addColorStop(0.15, EXPORT_COLORS.cyan); brandGrad.addColorStop(1, EXPORT_COLORS.orange);
    c.fillStyle = brandGrad;
    c.font = "900 40px Outfit, system-ui, sans-serif";
    c.textBaseline = "alphabetic";
    c.fillText("CineFighi", PAD, PAD + 34);
    c.fillStyle = EXPORT_COLORS.text3;
    c.font = "600 21px Outfit, system-ui, sans-serif";
    c.fillText("DNA condiviso", PAD, PAD + 66);

    const data = exportCaptionData();
    const captionTop = H - 360;
    const netTop = PAD + 96, netBottom = captionTop - 24;
    const netBox = { x: PAD, y: netTop, w: W - PAD * 2, h: netBottom - netTop };
    roundRect(c, netBox.x, netBox.y, netBox.w, netBox.h, 20);
    c.fillStyle = "rgba(255,255,255,.02)";
    c.fill();

    const placed = [...net.nodes.values()].filter(n => n.x !== null);
    if (placed.length) {
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (const n of placed) {
        minX = Math.min(minX, n.x); maxX = Math.max(maxX, n.x);
        minY = Math.min(minY, n.y); maxY = Math.max(maxY, n.y);
      }
      const spanX = Math.max(maxX - minX, 1), spanY = Math.max(maxY - minY, 1);
      // Il tetto evita solo il caso patologico (nodi quasi allineati, spanX o
      // spanY vicino a 0): senza, una rete appena sopra soglia riempirebbe
      // il riquadro con pochi puntini sparsi al centro.
      const margin = 48;
      const scale = Math.min((netBox.w - margin * 2) / spanX, (netBox.h - margin * 2) / spanY, 3.4);
      const cx = netBox.x + netBox.w / 2, cy = netBox.y + netBox.h / 2;
      const midX = (minX + maxX) / 2, midY = (minY + maxY) / 2;
      const toX = (x) => cx + (x - midX) * scale;
      const toY = (y) => cy + (y - midY) * scale;

      c.save();
      roundRect(c, netBox.x, netBox.y, netBox.w, netBox.h, 20);
      c.clip();

      for (const e of net.edges) {
        const a = net.nodes.get(e.a), b = net.nodes.get(e.b);
        if (!a || !b || a.x === null || b.x === null) continue;
        const shared = isMeetingPoint(a) || isMeetingPoint(b);
        c.strokeStyle = shared ? EXPORT_COLORS.edgeShared
          : e.kind === "ama" ? EXPORT_COLORS.edgeAma
          : e.kind === "appartiene" ? EXPORT_COLORS.edgeAppartiene
          : EXPORT_COLORS.edgeDiretto;
        c.lineWidth = shared ? 3.4 : 2.2;
        c.setLineDash(e.kind === "diretto" ? [5, 7] : []);
        c.beginPath();
        c.moveTo(toX(a.x), toY(a.y)); c.lineTo(toX(b.x), toY(b.y));
        c.stroke();
      }
      c.setLineDash([]);

      for (const n of placed) {
        const r = exportNodeRadius(n);
        c.beginPath();
        c.arc(toX(n.x), toY(n.y), r, 0, Math.PI * 2);
        c.fillStyle = EXPORT_COLORS.surface2;
        c.fill();
        c.lineWidth = 2.4;
        c.strokeStyle = exportNodeRing(n);
        c.stroke();
      }
      c.restore();
    }

    c.strokeStyle = EXPORT_COLORS.border;
    c.lineWidth = 1;
    c.beginPath();
    c.moveTo(PAD, captionTop); c.lineTo(W - PAD, captionTop);
    c.stroke();

    let ty = captionTop + 46;
    c.fillStyle = EXPORT_COLORS.text;
    c.font = "800 32px Outfit, system-ui, sans-serif";
    c.fillText(data.peopleLine, PAD, ty);

    if (data.affinityLine) {
      ty += 40;
      c.fillStyle = EXPORT_COLORS.green;
      c.font = "600 23px Inter, system-ui, sans-serif";
      c.fillText(data.affinityLine, PAD, ty);
    }

    if (data.genreTop) {
      ty += 38;
      c.font = "400 21px Inter, system-ui, sans-serif";
      c.fillStyle = EXPORT_COLORS.text2;
      const prefix = "Il genere che vi unisce di più: ";
      c.fillText(prefix, PAD, ty);
      const prefixW = c.measureText(prefix).width;
      c.font = "600 21px Inter, system-ui, sans-serif";
      c.fillStyle = EXPORT_COLORS.orange2;
      c.fillText(data.genreTop.name, PAD + prefixW, ty);
      const nameW = c.measureText(data.genreTop.name).width;
      c.font = "400 21px Inter, system-ui, sans-serif";
      c.fillStyle = EXPORT_COLORS.text2;
      c.fillText(` (${data.genreTop.count} in comune)`, PAD + prefixW + nameW, ty);
    }

    ty = H - 46;
    c.font = "600 18px Outfit, system-ui, sans-serif";
    c.fillStyle = EXPORT_COLORS.text3;
    c.fillText(`${data.nodeCount} nodi esplorati · ${data.dateLine}`, PAD, ty);
    const foot = "CineFighi";
    const footW = c.measureText(foot).width;
    c.fillText(foot, W - PAD - footW, ty);

    const blob = await new Promise(res => canvas.toBlob(res, "image/png"));
    if (!blob) return;
    const slug = (selectedPeople || []).join("-").toLowerCase()
      .normalize("NFD").replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `cinefighi-dna-${slug || "gruppo"}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  } finally {
    if (btn) btn.disabled = false;
  }
}

function bindExport() {
  const btn = el("dnaExportBtn");
  btn?.addEventListener("click", () => { haptic(8); exportNetworkImage(); });
}

function renderMessage(text) {
  const nodes = el("dnaNodes");
  const edges = el("dnaEdges");
  const panel = el("dnaPanel");
  if (edges) edges.innerHTML = "";
  if (nodes) nodes.innerHTML = "";
  if (panel) panel.innerHTML = `<p class="dna-hint">${escapeHtml(text)}</p>`;
}

// ─── LAYOUT RADIALE ──────────────────────────────────────────────────────────

// I figli si aprono a ventaglio dalla parte opposta al genitore: così un ramo
// cresce verso l'esterno invece di ripiegarsi su quello da cui è arrivato.
function baseAngleFor(node) {
  if (!node.parent) return -Math.PI / 2;          // radice: si parte verso l'alto
  const p = net.nodes.get(node.parent);
  if (!p || p.x === null) return -Math.PI / 2;
  return Math.atan2(node.y - p.y, node.x - p.x);
}

function tooClose(x, y, ignoreId) {
  for (const n of net.nodes.values()) {
    if (n.id === ignoreId || n.x === null) continue;
    if (Math.hypot(n.x - x, n.y - y) < MIN_GAP) return true;
  }
  return false;
}

// Una posizione occupata non si libera mai: un nodo piazzato non si muove più
// (niente jitter ad ogni apertura). Se il posto ideale è occupato si ruota di
// poco, alternando i due versi, e solo dopo si allarga il raggio.
function place(parent, angle) {
  for (let i = 0; i < PLACE_TRIES; i++) {
    const step = Math.ceil(i / 2) * 0.26 * (i % 2 ? 1 : -1);
    const r = raggio() + Math.floor(i / 8) * 34;
    const x = parent.x + Math.cos(angle + step) * r;
    const y = parent.y + Math.sin(angle + step) * r;
    if (!tooClose(x, y, parent.id)) return { x, y };
  }
  const r = raggio() + PLACE_TRIES * 3;
  return { x: parent.x + Math.cos(angle) * r, y: parent.y + Math.sin(angle) * r };
}

function layoutChildren(parentId, childIds) {
  const parent = net.nodes.get(parentId);
  if (!parent || !childIds.length) return;

  const base = baseAngleFor(parent);
  // La radice si apre a giro completo, tutti gli altri su un ventaglio di 180°
  // centrato sulla direzione di crescita.
  const spread = parentId === net.rootId ? Math.PI * 2 * (childIds.length - 1) / childIds.length : Math.PI;
  const start = base - spread / 2;
  const step = childIds.length > 1 ? spread / (childIds.length - 1) : 0;

  childIds.forEach((id, i) => {
    const node = net.nodes.get(id);
    if (!node || node.x !== null) return;   // già piazzato: non si tocca
    const pos = place(parent, start + step * i);
    node.x = pos.x;
    node.y = pos.y;
  });
}

// ─── APERTURA / CHIUSURA ─────────────────────────────────────────────────────

function expandNode(id, focus = true) {
  const added = expand(net, index, id, ramiPerTap());
  layoutChildren(id, added);
  if (focus) focusId = id;
  return added;
}

// Aprendo un nodo la camera non si ferma sul nodo ma sul baricentro fra lui e
// i figli appena nati: così i nuovi nodi entrano nell'inquadratura invece di
// spuntare mezzi fuori dal bordo. Lo spostamento è al massimo un raggio, e la
// prima trascinata dell'utente riparte semplicemente da qui.
function centraSuiFigli(id, added) {
  const p = net.nodes.get(id);
  if (!p || !added.length) { panX = 0; panY = 0; return; }
  let sx = p.x, sy = p.y, n = 1;
  for (const c of added) {
    const nodo = net.nodes.get(c);
    if (!nodo || nodo.x === null) continue;
    sx += nodo.x; sy += nodo.y; n++;
  }
  panX = p.x - sx / n;
  panY = p.y - sy / n;
}

// ─── RENDER ──────────────────────────────────────────────────────────────────

function initials(name) {
  return name.trim().split(/\s+/).map(w => w[0]).join("").slice(0, 2).toUpperCase();
}

function nodeInner(node) {
  if (node.type === "persona") return avatarHtml(node.label, 52);
  if (node.type === "film") {
    const src = node.meta.poster_path ? `${DNA_POSTER}${node.meta.poster_path}` : "";
    return src
      ? `<span class="dna-node__poster" style="background-image:url('${src}')"></span>`
      : `<span class="dna-node__poster dna-node__poster--empty">🎬</span>`;
  }
  if (node.type === "regista") {
    return `<span class="dna-node__director">${escapeHtml(initials(node.label))}</span>`;
  }
  return `<span class="dna-node__genre">${escapeHtml(node.label.slice(0, 3).toUpperCase())}</span>`;
}

// I vicini di quello che stai guardando restano pieni; più ci si allontana,
// più si spengono. Quattro livelli bastano: oltre, i nodi escono comunque dal
// DOM (DOM_MAX_HOPS).
function depthClass(h) { return Math.min(h ?? 0, 4); }

// Un nodo è un "punto d'incontro" quando lo amano TUTTE le persone che stai
// guardando — non una parte di loro. Solo in modalità condivisa (2-3
// selezionati), e solo film/genere/regista: una persona non può essere un
// punto d'incontro di se stessa. È lo stesso sharedCountOf che ordina i
// candidati in dna.js, qui usato per decidere l'evidenza visiva invece
// dell'ordine — la stessa informazione, letta in due punti diversi.
function isMeetingPoint(n) {
  if (!index?.shared || !selectedPeople) return false;
  if (n.type !== "film" && n.type !== "genere" && n.type !== "regista") return false;
  return sharedCountOf(index, n.id) === selectedPeople.length;
}

// Quanto è amato un film, in due gradini (0 = niente, 1 = leggero, 2 =
// forte): sul numero di fan che lo hanno votato 7+, sulla scala di un
// gruppo di poche persone. Solo film — persone, generi e registi non hanno
// questo effetto — e solo fuori dalla modalità condivisa: lì il segnale che
// conta è già il verde di isMeetingPoint, e i due non devono mai accendersi
// sullo stesso nodo.
function lovedLevel(n) {
  if (n.type !== "film" || index?.shared) return 0;
  const fan = (n.meta.fans || []).length;
  if (fan >= 5) return 2;
  if (fan >= 3) return 1;
  return 0;
}

function render() {
  const nodesEl = el("dnaNodes");
  const edgesEl = el("dnaEdges");
  const canvas = el("dnaCanvas");
  if (!nodesEl || !edgesEl || !canvas) return;

  const hops = hopsFrom(net, focusId);

  // Budget: prima i più vicini alla camera, a parità l'id (ordine stabile).
  const visible = [...net.nodes.values()]
    .filter(n => n.x !== null && (hops.get(n.id) ?? Infinity) <= DOM_MAX_HOPS)
    .sort((a, b) => (hops.get(a.id) - hops.get(b.id)) || a.id.localeCompare(b.id))
    .slice(0, MAX_DOM_NODES);
  const shown = new Set(visible.map(n => n.id));

  edgesEl.innerHTML = net.edges
    .filter(e => shown.has(e.a) && shown.has(e.b))
    .map(e => {
      const a = net.nodes.get(e.a);
      const b = net.nodes.get(e.b);
      const suFocus = e.a === focusId || e.b === focusId ? " is-focus" : "";
      // Un arco è lontano quanto il più lontano dei suoi due estremi.
      const h = Math.max(hops.get(e.a) ?? 0, hops.get(e.b) ?? 0);
      // Un arco fra due punti d'incontro (o fra una persona e un punto
      // d'incontro) è il tratto che racconta l'incrocio: più spesso, non un
      // colore nuovo — lo stesso trattamento già riservato a is-focus.
      const suIncontro = isMeetingPoint(a) || isMeetingPoint(b) ? " is-shared" : "";
      return `<line x1="${a.x.toFixed(1)}" y1="${a.y.toFixed(1)}" x2="${b.x.toFixed(1)}" y2="${b.y.toFixed(1)}" class="dna-edge dna-edge--${e.kind} dna-h${depthClass(h)}${suFocus}${suIncontro}"/>`;
    })
    .join("");

  nodesEl.innerHTML = visible.map(n => {
    const h = hops.get(n.id);
    const withLabel = h <= LABEL_MAX_HOPS;
    const cls = [
      "dna-node",
      `dna-node--${n.type}`,
      // Profondità dalla camera: è già calcolata per il budget DOM, qui
      // diventa anche visibile. Senza, un nodo a quattro salti pesa
      // all'occhio quanto il vicino di quello attivo, ed è il motivo per
      // cui una rete molto aperta diventa illeggibile.
      `dna-h${depthClass(h)}`,
      n.id === focusId ? "is-focus" : "",
      n.id === net.rootId ? "is-root" : "",
      n.expanded ? "is-open" : "",
      withLabel ? "" : "is-far",
      // Punto d'incontro: lo ama ognuna delle persone che stai guardando.
      // Solo in modalità condivisa — vedi isMeetingPoint.
      isMeetingPoint(n) ? "is-shared" : "",
      // "Molto amato": vedi lovedLevel. Mai insieme a is-shared (si escludono
      // a vicenda sulla modalità condivisa).
      lovedLevel(n) ? `is-loved-${lovedLevel(n)}` : ""
    ].filter(Boolean).join(" ");
    return `<button type="button" class="${cls}" data-node="${escapeHtml(n.id)}"
      style="left:${n.x.toFixed(1)}px;top:${n.y.toFixed(1)}px"
      aria-label="${escapeHtml(n.label)}">
      ${nodeInner(n)}
      ${withLabel ? `<span class="dna-node__label">${escapeHtml(n.label)}</span>` : ""}
    </button>`;
  }).join("");

  shownIds = visible.map(n => n.id);
  applyCamera();

  // Con un nodo solo il riquadro sarebbe una scatola quasi vuota: finche' non
  // si apre niente, una riga dice cosa fare. Sparisce al primo tocco.
  const esplorando = net.nodes.size > 1;
  el("dnaStartHint")?.classList.toggle("hidden", esplorando);

  // Stessa condizione, altro effetto: appena la rete si apre la pagina si fa
  // da parte e quello spazio diventa riquadro (vedi .dna-esplorazione in
  // styles.css). Non è uno stato in più da tenere sincronizzato — "sto
  // esplorando" è già scritto nella rete: chiudi tutto, o premi Ricomincia,
  // e la schermata torna identica a tutte le altre.
  el("app")?.classList.toggle("dna-esplorazione", esplorando);

  updateExportButton();
  renderPanel(net.nodes.get(focusId));
}

// Il pannello è il posto dove sta l'informazione: la rete mostra i
// collegamenti, qui si legge chi, quanto e perché. È il motivo per cui un tap
// apre pochi rami — quello che non diventa un nodo si legge qui sotto.
// Unico punto in cui si muove la camera: posizione del nodo attivo più lo
// spostamento manuale. È una sola translate sul contenitore, non un
// riposizionamento dei nodi, quindi il telefono la anima sul compositor.
function applyCamera(animata = true) {
  const canvas = el("dnaCanvas");
  if (!canvas || !net) return;
  const focus = net.nodes.get(focusId) || net.nodes.get(net.rootId);
  canvas.classList.toggle("is-dragging", !animata);
  canvas.style.transform = `translate(${(-focus.x + panX).toFixed(1)}px, ${(-focus.y + panY).toFixed(1)}px)`;
}

// Fin dove si può trascinare: quanto basta a portare al centro qualunque
// nodo a schermo, e non un pixel di più. Così non si finisce mai nel vuoto
// senza sapere come tornare indietro.
function panLimits() {
  const focus = net?.nodes.get(focusId);
  if (!focus) return { minX: 0, maxX: 0, minY: 0, maxY: 0 };
  let dxMin = 0, dxMax = 0, dyMin = 0, dyMax = 0;
  for (const id of shownIds) {
    const n = net.nodes.get(id);
    if (!n || n.x === null) continue;
    dxMin = Math.min(dxMin, n.x - focus.x); dxMax = Math.max(dxMax, n.x - focus.x);
    dyMin = Math.min(dyMin, n.y - focus.y); dyMax = Math.max(dyMax, n.y - focus.y);
  }
  return {
    minX: -dxMax - PAN_MARGIN, maxX: -dxMin + PAN_MARGIN,
    minY: -dyMax - PAN_MARGIN, maxY: -dyMin + PAN_MARGIN
  };
}

function renderPanel(node) {
  const panel = el("dnaPanel");
  if (!panel || !node) return;

  const chiudi = node.expanded
    ? `<span class="dna-panel__hint">Toccalo di nuovo per richiudere</span>`
    : `<span class="dna-panel__hint">Toccalo per aprire i collegamenti</span>`;

  // "Scheda →" sta nella riga del titolo e non in fondo: su un telefono
  // piccolo un bottone in coda al pannello finisce dietro la barra di
  // navigazione, e la scheda è la cosa che si vuole raggiungere subito.
  const scheda = node.type === "film"
    ? `<button type="button" class="dna-panel__scheda open-detail" data-id="${escapeHtml(node.meta.id)}">Scheda →</button>`
    : "";

  panel.innerHTML = `
    <div class="dna-panel__head">${panelIcon(node)}<strong>${escapeHtml(panelTitle(node))}</strong>${scheda}</div>
    ${panelBody(node)}
    ${chiudi}`;
}

function panelIcon(node) {
  if (node.type === "persona") return avatarHtml(node.label, 30);
  if (node.type === "regista") return `<span class="dna-chip dna-chip--regista">${escapeHtml(initials(node.label))}</span>`;
  if (node.type === "genere") return `<span class="dna-chip dna-chip--genere">${escapeHtml(node.label.slice(0, 3).toUpperCase())}</span>`;
  return "";
}

function panelTitle(node) {
  if (node.type === "film" && node.meta.year) return `${node.label} (${node.meta.year})`;
  return node.label;
}

function fansHtml(fans) {
  return `<div class="dna-fans">${fans
    .slice()
    .sort((a, b) => b.vote - a.vote || a.name.localeCompare(b.name))
    .map(f => `<span class="dna-fan">${avatarHtml(f.name, 22)}<span class="dna-fan__name">${escapeHtml(f.name)}</span><span class="dna-fan__vote">${f.vote.toFixed(1)}</span></span>`)
    .join("")}</div>`;
}

function pillsHtml(items) {
  return `<div class="dna-pills">${items.map(t => `<span class="dna-pill">${escapeHtml(t)}</span>`).join("")}</div>`;
}

function panelBody(node) {
  const m = node.meta;

  // Una riga sola, e solo quando conta davvero: non "chi lo ama" (i nomi
  // sono già nella lista fan o nel conteggio persone qui sotto), ma se è
  // TUTTI quelli che stai guardando o solo una parte — un confronto che
  // altrimenti il lettore dovrebbe fare a mente contando le teste.
  const incontro = isMeetingPoint(node)
    ? `<p class="dna-panel__line dna-panel__line--shared">Punto d'incontro: piace a ${selectedPeople.length === 2 ? "entrambi" : "tutti e tre"}.</p>`
    : "";

  if (node.type === "persona") {
    const n = m.liked || 0;
    // Non "sei la radice" ma "sei tu": con un filtro attivo la rete può
    // partire da qualcun altro, e dargli del "tu" sarebbe sbagliato.
    const io = node.label === ctx?.currentUser;
    const generi = (m.topGenres || []).length
      ? `<p class="dna-panel__line">Generi più presenti: ${m.topGenres.map(g => `${escapeHtml(g.genere)} (${g.film})`).join(" · ")}.</p>`
      : "";
    const registi = (m.topDirectors || []).length
      ? `<p class="dna-panel__line">Registi ricorrenti: ${m.topDirectors.map(d => `${escapeHtml(d.name)} (${d.film})`).join(" · ")}.</p>`
      : "";
    return `
      <p class="dna-panel__line">${io ? "Hai" : "Ha"} amato ${n} ${n === 1 ? "titolo" : "titoli"} (voto 7 o più).</p>
      ${generi}
      ${registi}`;
  }

  if (node.type === "film") {
    const tipo = m.media_type === "tv" ? "Serie" : "Film";
    const regia = m.director ? `Regia di ${escapeHtml(m.director)}` : "";
    const fans = m.fans || [];
    return `
      ${incontro}
      <p class="dna-panel__line">${tipo}${regia ? ` · ${regia}` : ""}</p>
      <p class="dna-panel__line dna-panel__label">Chi l'ha amato (${fans.length})</p>
      ${fansHtml(fans)}
      ${(m.genres || []).length ? pillsHtml(m.genres) : ""}`;
  }

  if (node.type === "regista") {
    const titoli = (m.titoli || []).length
      ? `<p class="dna-panel__line">Nella rete: ${m.titoli.map(t => escapeHtml(t)).join(" · ")}${m.films > m.titoli.length ? ` e altri ${m.films - m.titoli.length}` : ""}.</p>`
      : "";
    return `
      ${incontro}
      <p class="dna-panel__line">${m.films} ${m.films === 1 ? "film amato" : "film amati"} nel gruppo, da ${m.people} ${m.people === 1 ? "persona" : "persone"} diverse.</p>
      ${titoli}`;
  }

  const c = m.count || 0;
  const chi = (m.topFans || []).length
    ? `<p class="dna-panel__line">Chi lo ama di più: ${m.topFans.map(f => `${escapeHtml(f.name)} (${f.film})`).join(" · ")}.</p>`
    : "";
  return `
    ${incontro}
    <p class="dna-panel__line">${c} ${c === 1 ? "titolo amato" : "titoli amati"} dal gruppo in questo genere.</p>
    ${chi}`;
}

// ─── EVENTI ──────────────────────────────────────────────────────────────────

export function initDnaView() {
  if (bound) return;
  bound = true;

  bindPan();
  bindPeople();
  bindIntroToggle();
  bindExport();

  const nodesEl = el("dnaNodes");
  if (nodesEl) {
    nodesEl.addEventListener("click", e => {
      const btn = e.target.closest(".dna-node");
      if (!btn) return;
      const id = btn.dataset.node;
      const node = net?.nodes.get(id);
      if (!node) return;
      if (dragged) return;   // era un trascinamento, non un tocco
      haptic(8);
      // Un tap su un nodo che non è quello attivo lo SELEZIONA soltanto: serve
      // a leggerne il pannello (chi l'ha votato, i generi, la regia) senza
      // toccare la rete. Apre o richiude solo il nodo già attivo, cioè quello
      // che il pannello sta già descrivendo — così guardare non è mai un'azione
      // distruttiva, e "richiudi" non capita mai per sbaglio.
      let nuovi = null;
      if (id === focusId) {
        if (node.expanded) collapse(net, id);
        else nuovi = expandNode(id, false);
      } else if (!node.expanded) {
        nuovi = expandNode(id, false);
      }
      focusId = id;
      // Toccare un nodo ricentra sempre; se ha appena figliato, la camera si
      // sposta quel tanto che basta a far entrare i nuovi nodi.
      if (nuovi) centraSuiFigli(id, nuovi);
      else { panX = 0; panY = 0; }
      render();
    });
  }
}

// Trascinamento a un dito per guardarsi intorno. 1:1, senza inerzia e senza
// pinch: un trascinamento diretto è già quello che il pollice si aspetta,
// mentre l'inerzia fatta male è la prima cosa che tradisce un finto nativo.
// Serve perché i nodi ai bordi del riquadro sono tagliati a metà e prima
// l'unico modo di raggiungerli era toccarli, cioè espanderli.
let dragged = false;

function bindPan() {
  const stage = el("dnaStage");
  if (!stage) return;

  let pid = null, x0 = 0, y0 = 0, baseX = 0, baseY = 0, lim = null;

  stage.addEventListener("pointerdown", e => {
    if (!net || pid !== null || e.button > 0) return;
    // Il selettore è dentro al riquadro: lì i tocchi sono suoi, non della rete.
    if (e.target.closest(".dna-sheet")) return;
    pid = e.pointerId;
    dragged = false;
    x0 = e.clientX; y0 = e.clientY;
    baseX = panX; baseY = panY;
    lim = panLimits();
  });

  stage.addEventListener("pointermove", e => {
    if (e.pointerId !== pid) return;
    const dx = e.clientX - x0, dy = e.clientY - y0;
    if (!dragged) {
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      dragged = true;
      stage.classList.add("is-panning");
      // Da qui in poi il gesto è nostro: il browser non deve più provare a
      // scrollare la pagina a metà trascinamento.
      try { stage.setPointerCapture(pid); } catch {}
    }
    panX = Math.min(lim.maxX, Math.max(lim.minX, baseX + dx));
    panY = Math.min(lim.maxY, Math.max(lim.minY, baseY + dy));
    applyCamera(false);   // niente transizione mentre il dito è giù: deve seguirlo
  });

  const fine = e => {
    if (e.pointerId !== pid) return;
    try { stage.releasePointerCapture(pid); } catch {}
    pid = null;
    stage.classList.remove("is-panning");
    applyCamera(true);
    // Il click arriva DOPO il pointerup: il flag deve sopravvivere fino a lì,
    // e sparire subito dopo, altrimenti il tap successivo verrebbe ignorato.
    if (dragged) setTimeout(() => { dragged = false; }, 0);
  };
  stage.addEventListener("pointerup", fine);
  stage.addEventListener("pointercancel", fine);
}

function bindPeople() {
  const btn = el("dnaPeopleBtn");
  const done = el("dnaPeopleDoneBtn");
  const lista = el("dnaPeopleList");

  btn?.addEventListener("click", () => { haptic(8); openSheet(!sheetOpen); });
  done?.addEventListener("click", () => { haptic(8); openSheet(false); });

  lista?.addEventListener("click", e => {
    const riga = e.target.closest(".dna-sheet__row");
    if (!riga || !ctx) return;
    haptic(8);
    togglePerson(riga.dataset.user);
    // Il foglio resta aperto: scegliere più persone è la cosa normale, e
    // richiuderlo ad ogni spunta obbligherebbe a riaprirlo ogni volta.
    renderPeopleSheet();
    // La rete si ricostruisce da zero con la nuova selezione: firma diversa,
    // quindi showDna ripassa da buildIndex (vedi librarySignature).
    resetDna();
    showDna(ctx);
  });
}

// La spiegazione estesa non sparisce, va solo a un tap di distanza: stato
// solo in memoria (nessun localStorage), si richiude ad ogni nuovo ingresso
// nella schermata — chi la vuole rileggere la riapre, senza che l'app debba
// ricordarselo per sempre su un dettaglio così minore.
function bindIntroToggle() {
  const toggle = el("dnaIntroToggle");
  const full = el("dnaIntroFull");
  if (!toggle || !full) return;
  toggle.addEventListener("click", () => {
    const aperta = toggle.getAttribute("aria-expanded") === "true";
    toggle.setAttribute("aria-expanded", aperta ? "false" : "true");
    full.hidden = aperta;
  });
}

// "Ricomincia": butta via l'esplorazione e riparte dal nodo persona. Il
// filtro delle persone NON si tocca — è una scelta, non uno stato temporaneo
// dell'esplorazione.
// Il prossimo showDna() ricostruisce tutto da zero (la firma non combacia più).
export function resetDna() {
  signature = "";
  net = null;
  panX = 0;
  panY = 0;
}
