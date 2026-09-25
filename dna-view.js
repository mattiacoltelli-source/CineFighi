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
} from "./dna.js?v=b7f540b";
import { escapeHtml } from "./cine-core.js?v=b7f540b";
import { avatarHtml, haptic } from "./ui.js?v=b7f540b";

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

// ─── VEDI TUTTA LA RETE ───────────────────────────────────────────────────────
// Tre tentativi di ricostruire la rete su un <canvas> (pallini astratti, poi
// locandine vere ma senza etichette, poi un "meglio di" curato) non sono mai
// arrivati a essere davvero "la rete che ho aperto" — ognuno era un'altra
// approssimazione. Qui non si ricostruisce più niente: le STESSE funzioni che
// disegnano la rete sullo schermo (edgeLine/nodeButton, vedi RENDER più sotto)
// ridisegnano l'INTERA rete — senza il budget DOM né il ritaglio della
// camera — dentro un riquadro a schermo intero e scorrevole. Le stesse
// locandine, le stesse etichette, la stessa sfumatura per profondità: è la
// rete vera, solo srotolata invece che ritagliata. Da lì lo screenshot lo fa
// il telefono, non l'app.
//
// Due modi di guardarla, perché nessuno dei due va bene sempre:
//   INGRANDITA — si ingrandisce fino a riempire lo schermo e il resto si
//     scorre. È come la rete a schermo normale (che non "fa stare tutto":
//     ritaglia, ed è per questo che sembra sempre piena), quindi le locandine
//     restano grandi e leggibili. Su una rete enorme però lo screenshot la
//     prende solo a pezzi.
//   ADATTA — tutta in una schermata sola, a costo di rimpicciolirla: uno
//     screenshot solo e c'è dentro tutto. Su reti molto grandi le locandine
//     diventano francobolli (è il prezzo, dichiarato nell'etichetta del
//     tasto), su quelle medie si legge ancora bene.
const VIEW_ALL_MIN_NODES = 10;
// Mezza larghezza/altezza del nodo più ingombrante: il riquadro è 62px ma
// l'etichetta sotto arriva a 88px e sfora simmetrica (vedi .dna-node,
// .dna-node__label). Serve a far stare i nodi di bordo dentro l'inquadratura
// invece di tagliarli a metà.
const FULL_VIEW_NODE_HALF = 50;
const FULL_VIEW_GAP = 12;          // respiro ai bordi dello schermo

// Quale dei due modi è attivo. Solo in memoria, come il resto dello stato di
// questa schermata: la scelta resta per tutta la sessione ma non diventa
// un'impostazione da ricordare per sempre.
let fullViewFit = false;
// Geometria dell'ultima apertura, così passare da un modo all'altro ricalcola
// solo il transform invece di ricostruire tutti i nodi.
let fullViewGeom = null;

// ─── I NUMERI SOTTO LA RETE ───────────────────────────────────────────────
// Quattro-cinque righe che raccontano LE PERSONE SCELTE, non il disegno qui
// sopra: sono calcolate su tutta la loro libreria, non sui nodi aperti a
// mano (quelli cambiano ad ogni tocco, e con poche espansioni darebbero
// numeri senza senso — "regista preferito" su tre film non vuol dire
// niente). Per questo sopra le righe c'è scritto di chi sono: in uno
// screenshot, senza quella riga, si leggerebbero come didascalia del
// disegno. Tutto da `index`, già in memoria: zero chiamate, zero AI.

// Sotto questo numero di titoli un genere non fa media: un singolo 10 lo
// porterebbe in cima. È la stessa preoccupazione — e lo stesso numero — del
// minimo che dna.js chiede a un regista per diventare un nodo.
const STAT_MIN_TITOLI = 3;

const mediaVoti = (voti) => voti.reduce((s, v) => s + v, 0) / voti.length;
const unaCifra = (n) => n.toFixed(1).replace(".", ",");

// Quante delle persone selezionate devono avere VISTO (votato, qualunque
// voto) un titolo perché la sua media conti per "Voto medio più alto" più
// sotto — altrimenti un 10 isolato da una sola persona vincerebbe sempre,
// anche con un gruppo di 8. Fino a 3 persone serve l'unanimità (con così
// pochi, "quasi tutti" non vuol dire granché); da 4 in su basta circa un
// terzo abbondante del gruppo, arrotondato per eccesso — stessa idea del
// minimo per generi/registi sopra, solo scalata al numero di persone.
function sogliaVisti(n) {
  return n <= 3 ? n : Math.ceil((2 * n) / 3);
}

function fullViewStats() {
  if (!index) return [];
  const films = [...index.films.values()];
  if (!films.length) return [];

  const n = selectedPeople?.length || 0;
  const condivisa = n === 2 || n === 3;
  const righe = [];

  // "In comune" esiste solo guardando 2 o 3 persone: con una sola, o con
  // tutto il gruppo, non c'è un'intersezione da raccontare (vedi
  // isModalitaCondivisa in dna.js). Lì queste due righe semplicemente non
  // compaiono, invece di mostrare un trattino.
  if (condivisa) {
    const insieme = films.filter(f => f.fans.length === n);
    if (insieme.length) {
      righe.push({
        label: n === 2 ? "Amati da entrambi" : "Amati da tutti e tre",
        value: `${insieme.length} ${insieme.length === 1 ? "titolo" : "titoli"}`
      });
      const conta = new Map();
      for (const f of insieme) for (const g of f.genres) conta.set(g, (conta.get(g) || 0) + 1);
      const top = [...conta.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
      if (top) righe.push({ label: "Genere in comune", value: `${top[0]} (${top[1]} ${top[1] === 1 ? "titolo" : "titoli"})` });
    }
  }

  // Genere preferito: la media dei voti dei film di quel genere. L'indice
  // contiene solo titoli amati (7+), quindi non è "quanto vi piace il
  // genere in assoluto" ma "fra quelli che amate, quale premiate di più".
  const perGenere = new Map();
  for (const f of films) {
    for (const g of f.genres) {
      if (!perGenere.has(g)) perGenere.set(g, { titoli: 0, voti: [] });
      const dati = perGenere.get(g);
      dati.titoli++;
      for (const fan of f.fans) dati.voti.push(fan.vote);
    }
  }
  const genere = [...perGenere.entries()]
    .filter(([, d]) => d.titoli >= STAT_MIN_TITOLI)
    .map(([nome, d]) => ({ nome, avg: mediaVoti(d.voti) }))
    .sort((a, b) => b.avg - a.avg || a.nome.localeCompare(b.nome))[0];
  if (genere) righe.push({ label: "Genere preferito", value: `${genere.nome} (media ${unaCifra(genere.avg)})` });

  // Regista preferito: index.directors è già ordinato per punteggio (media
  // ritirata verso quella del gruppo più un bonus per quante persone lo
  // amano, vedi directorScores). Il punteggio decide chi vince, ma a schermo
  // si mostra la media vera: un punteggio non direbbe niente a nessuno.
  const regista = index.directors.values().next().value;
  if (regista) {
    const voti = (index.byDirector.get(regista.name) || [])
      .flatMap(e => (index.films.get(e.id)?.fans || []).map(f => f.vote));
    if (voti.length) {
      righe.push({
        label: "Regista preferito",
        value: `${regista.name} (${regista.films} film, media ${unaCifra(mediaVoti(voti))})`
      });
    }
  }

  // Voto medio più alto: NON sugli "amati" di index/films (fans è filtrato
  // a chi ha dato 7+, quindi lì la media sarebbe sempre alta per
  // costruzione) — sui voti veri, qualunque valore, così un titolo che
  // tutti hanno visto con una media onesta di 6,8 può battere un film
  // adorato da una persona sola con un 9. Serve però che l'abbiano visto in
  // abbastanza persone (sogliaVisti sopra), altrimenti vince sempre chi ha
  // un voto isolato molto alto. A parità di media vince chi l'ha visto in
  // più persone e poi l'ordine alfabetico — mai un pareggio risolto a caso,
  // come ovunque in questa schermata.
  const personeStat = selectedPeople || ctx.users;
  const sogliaMedia = sogliaVisti(personeStat.length);
  const film = (ctx.db || [])
    .map(t => {
      const voti = personeStat.map(nome => Number(t.votes?.[nome]?.vote)).filter(Number.isFinite);
      return { title: t.title, avg: voti.length ? mediaVoti(voti) : 0, n: voti.length };
    })
    .filter(c => c.n >= sogliaMedia)
    .sort((a, b) => b.avg - a.avg || b.n - a.n || a.title.localeCompare(b.title))[0];
  if (film) righe.push({ label: "Voto medio più alto", value: `${film.title} (${unaCifra(film.avg)})` });

  return righe;
}

// La legenda degli archi. Serve perché questa immagine è fatta per essere
// mandata agli altri, e chi la riceve non ha modo di sapere che il verde
// vuol dire "lo amate entrambi": senza una riga che lo dica, i colori
// restano un codice privato di chi ha fatto lo screenshot.
//
// Si guarda cosa è stato DAVVERO disegnato invece di dedurlo dalla modalità.
// Non è pignoleria: con 4 persone selezionate non c'è né il verde (serve la
// modalità a 2-3) né l'oro (servono 5 fan su 4 possibili), e una voce per un
// colore assente sarebbe una bugia in piccolo. Restano fuori apposta
// l'arancione (film→genere) e il tratteggio (regista): un arco che finisce su
// una pastiglia con scritto "Thriller" o "James Cameron" si legge dai suoi
// estremi, e didascalarlo sarebbe solo rumore. Una voce sola copre anche i
// nodi: l'anello verde e l'arco verde usano lo stesso verde di proposito.
function fullViewLegend() {
  const edges = el("dnaFullEdges");
  if (!edges) return [];
  const voci = [];
  if (edges.querySelector(".dna-edge--ama.is-shared")) {
    voci.push({ classe: "is-shared", testo: selectedPeople?.length === 3 ? "amato da tutti e tre" : "amato da entrambi" });
  }
  if (edges.querySelector(".dna-edge--ama.is-loved-2")) {
    voci.push({ classe: "is-loved", testo: "amato da 5+ persone" });
  }
  if (edges.querySelector(".dna-edge--ama")) {
    voci.push({ classe: "is-ama", testo: "chi ama cosa" });
  }
  return voci;
}

function renderFullViewStats() {
  const box = el("dnaFullViewStats");
  if (!box) return;
  const voci = fullViewLegend();
  const righe = fullViewStats();
  if (!voci.length && !righe.length) { box.innerHTML = ""; return; }

  const legenda = voci.length ? `
    <div class="dna-full-legend">
      ${voci.map(v => `<span class="dna-full-legend__voce"><i class="${v.classe}"></i>${escapeHtml(v.testo)}</span>`).join("")}
    </div>` : "";
  const titolo = selectedPeople ? `Il DNA di ${peopleLabel()}` : "Il DNA del gruppo";
  const numeri = righe.length ? `
    <div class="dna-full-stats__title">${escapeHtml(titolo)}</div>
    ${righe.map(r => `
      <div class="dna-full-stats__row">
        <span>${escapeHtml(r.label)}</span><strong>${escapeHtml(r.value)}</strong>
      </div>`).join("")}` : "";

  // Firma discreta: questa è l'unica schermata pensata per essere
  // condivisa fuori dall'app ("tutto in una schermata: lo screenshot la
  // prende intera"), quindi ha senso che porti il nome — ma in fondo, dopo
  // i numeri, e spenta (vedi .dna-signature in CSS): una firma, non un
  // secondo titolo che compete con "Il DNA di...".
  const firma = `<div class="dna-signature">CineFighi</div>`;

  box.innerHTML = legenda + numeri + firma;
}

function updateViewAllButton() {
  const btn = el("dnaViewAllBtn");
  if (!btn) return;
  // Vale in ogni modalità — una persona sola, due, tre, tutto il gruppo: la
  // rete diventa grande allo stesso modo, e il motivo per guardarla intera
  // non dipende da quante persone ci sono dentro.
  const aperti = net ? [...net.nodes.values()].filter(x => x.x !== null).length : 0;
  btn.classList.toggle("hidden", aperti < VIEW_ALL_MIN_NODES);
}

// Applica solo zoom e posizione, sui nodi già disegnati (vedi fullViewGeom).
function applyFullViewScale() {
  const overlay = el("dnaFullView");
  const canvas = el("dnaFullCanvas");
  const shift = el("dnaFullShift");
  const scrollBox = overlay?.querySelector(".dna-full-view__scroll");
  if (!overlay || !canvas || !shift || !scrollBox || !fullViewGeom) return;

  const { left, top, contentW, contentH } = fullViewGeom;
  const availW = Math.max(scrollBox.clientWidth - FULL_VIEW_GAP * 2, 1);
  const availH = Math.max(scrollBox.clientHeight - FULL_VIEW_GAP * 2, 1);
  const ratioW = availW / contentW, ratioH = availH / contentH;

  // Adatta: la più piccola delle due proporzioni fa stare TUTTO, senza
  // pavimento — se serve scendere a un terzo della scala si scende, altrimenti
  // il modo non manterrebbe la sua unica promessa. Ingrandita: la più grande,
  // mai sotto 1 (una rete più grande dello schermo si scorre, non si
  // rimpicciolisce fino a diventare illeggibile).
  const scale = fullViewFit
    ? Math.min(Math.min(ratioW, ratioH), 2.5)
    : Math.min(Math.max(1, Math.max(ratioW, ratioH)), 2.5);

  // Quando la rete scalata è più piccola del riquadro (sempre, in "Adatta":
  // una rete larga e bassa in uno schermo stretto e alto avanza parecchia
  // altezza) si centra invece di incollarla in alto: metà schermata nera in
  // fondo è proprio quello che si porterebbe dietro lo screenshot.
  const offX = Math.max(FULL_VIEW_GAP, (scrollBox.clientWidth - contentW * scale) / 2);
  const offY = Math.max(FULL_VIEW_GAP, (scrollBox.clientHeight - contentH * scale) / 2);

  // Due trasformazioni annidate invece di una: quella interna porta l'angolo
  // della rete sull'origine (i nodi tengono le loro coordinate originali,
  // condivise col render normale), quella esterna scala e posiziona. Così il
  // riquadro dichiarato coincide con la rete disegnata, e non resta spazio
  // vuoto in fondo allo scorrimento.
  shift.style.transform = `translate(${-left}px, ${-top}px)`;
  canvas.style.width = `${contentW}px`;
  canvas.style.height = `${contentH}px`;
  canvas.style.transform = `translate(${offX}px, ${offY}px) scale(${scale})`;

  // Lo spessore degli archi non può seguire lo zoom in modo lineare: in
  // "Adatta" a 0,35x un tratto da 2,6px diventa 0,9px — sotto il pixel, dove
  // l'antialiasing lo spegne. (Sui nodi non si nota: una locandina piccola
  // resta una locandina, una linea sottile invece sparisce.) Ogni livello ha
  // quindi uno spessore nominale e un minimo garantito A SCHERMO: sotto quella
  // soglia il nominale cresce quanto basta a compensare la riduzione. Non è
  // "spessore costante" (che a zoom alto farebbe linee sproporzionate rispetto
  // ai nodi): è un pavimento, non un blocco.
  const spessore = (nominale, minimoAschermo) => `${Math.max(nominale, minimoAschermo / scale).toFixed(2)}px`;
  overlay.style.setProperty("--dna-edge-forte", spessore(3.2, 2.2));
  overlay.style.setProperty("--dna-edge-medio", spessore(2.2, 1.5));
  overlay.style.setProperty("--dna-edge-debole", spessore(1.6, 1.1));

  if (fullViewFit) { scrollBox.scrollTop = 0; scrollBox.scrollLeft = 0; }
}

function setFullViewFit(fit) {
  fullViewFit = fit;
  for (const btn of document.querySelectorAll("#dnaFullViewZoom [data-zoom]")) {
    const attiva = (btn.dataset.zoom === "fit") === fit;
    btn.classList.toggle("active", attiva);
    btn.setAttribute("aria-pressed", attiva ? "true" : "false");
  }
  const hint = el("dnaFullViewHint");
  if (hint) {
    hint.textContent = fit
      ? "Tutta in una schermata: lo screenshot la prende intera."
      : "Scorri per vederla tutta, poi fai uno screenshot.";
  }
  applyFullViewScale();
}

function openFullNetworkView() {
  if (!net) return;
  const edgesEl = el("dnaFullEdges");
  const nodesEl = el("dnaFullNodes");
  const overlay = el("dnaFullView");
  const who = el("dnaFullViewWho");
  if (!edgesEl || !nodesEl || !overlay) return;

  const placed = [...net.nodes.values()].filter(n => n.x !== null);
  if (!placed.length) return;

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const n of placed) {
    minX = Math.min(minX, n.x); maxX = Math.max(maxX, n.x);
    minY = Math.min(minY, n.y); maxY = Math.max(maxY, n.y);
  }
  fullViewGeom = {
    left: minX - FULL_VIEW_NODE_HALF,
    top: minY - FULL_VIEW_NODE_HALF,
    contentW: maxX - minX + FULL_VIEW_NODE_HALF * 2,
    contentH: maxY - minY + FULL_VIEW_NODE_HALF * 2
  };

  const hops = hopsFrom(net, focusId);
  edgesEl.innerHTML = net.edges.map(e => edgeLine(e, hops)).join("");
  nodesEl.innerHTML = placed.map(n => nodeButton(n, hops)).join("");
  if (who) who.textContent = peopleLabel();
  // Prima le righe dei numeri, poi la misura: sono loro a decidere quanta
  // altezza resta alla rete, e in "Adatta" quell'altezza è la scala.
  renderFullViewStats();

  // L'overlay va mostrato PRIMA di misurare il riquadro scorrevole: nascosto
  // misurerebbe 0.
  overlay.classList.remove("hidden");
  setFullViewFit(fullViewFit);
}

function closeFullNetworkView() {
  el("dnaFullView")?.classList.add("hidden");
}

function bindFullView() {
  el("dnaViewAllBtn")?.addEventListener("click", () => { haptic(8); openFullNetworkView(); });
  el("dnaFullViewCloseBtn")?.addEventListener("click", () => { haptic(8); closeFullNetworkView(); });
  el("dnaFullViewZoom")?.addEventListener("click", e => {
    const btn = e.target.closest("[data-zoom]");
    if (!btn) return;
    haptic(8);
    setFullViewFit(btn.dataset.zoom === "fit");
  });
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

// Un arco, con la sua classe (tipo, profondità, focus, punto d'incontro).
// Usata sia dal render live (sul solo budget visibile) sia dalla vista
// completa (openFullNetworkView, su TUTTI gli archi): stessa funzione,
// stesso risultato visivo, non due modi diversi di disegnare la rete.
function edgeLine(e, hops) {
  const a = net.nodes.get(e.a);
  const b = net.nodes.get(e.b);
  const suFocus = e.a === focusId || e.b === focusId ? " is-focus" : "";
  // Un arco è lontano quanto il più lontano dei suoi due estremi.
  const h = Math.max(hops.get(e.a) ?? 0, hops.get(e.b) ?? 0);
  // Un arco fra due punti d'incontro (o fra una persona e un punto
  // d'incontro) è il tratto che racconta l'incrocio: più spesso, non un
  // colore nuovo — lo stesso trattamento già riservato a is-focus.
  const suIncontro = isMeetingPoint(a) || isMeetingPoint(b) ? " is-shared" : "";
  // Fuori dalla modalità condivisa il punto d'incontro non esiste, e
  // l'equivalente è il molto amato — ma solo quello di livello forte (5+ fan,
  // vedi lovedLevel). Col gradino basso (3 fan) su tutto il gruppo sarebbe
  // quasi ogni film, cioè di nuovo nessun risalto. lovedLevel vale 0 DENTRO
  // la modalità condivisa, quindi questa classe e is-shared non capitano mai
  // insieme — stessa esclusione già garantita sui nodi. A schermo normale non
  // cambia niente: la usa solo la vista completa.
  const suAmato = lovedLevel(a) === 2 || lovedLevel(b) === 2 ? " is-loved-2" : "";
  return `<line x1="${a.x.toFixed(1)}" y1="${a.y.toFixed(1)}" x2="${b.x.toFixed(1)}" y2="${b.y.toFixed(1)}" class="dna-edge dna-edge--${e.kind} dna-h${depthClass(h)}${suFocus}${suIncontro}${suAmato}"/>`;
}

// Un nodo, con la sua classe (locandina/avatar/pastiglia dentro, vedi
// nodeInner). Stessa funzione condivisa fra il render live e la vista
// completa — vedi edgeLine qui sopra per il perché.
function nodeButton(n, hops) {
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
    .map(e => edgeLine(e, hops))
    .join("");

  nodesEl.innerHTML = visible.map(n => nodeButton(n, hops)).join("");

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

  updateViewAllButton();
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
  bindFullView();

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
