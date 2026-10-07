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
  buildIndex, createNetwork, expand, collapse, hopsFrom, sharedCountOf, remainingCount, LIKE_THRESHOLD
} from "./dna.js?v=729a211";
import { escapeHtml } from "./cine-core.js?v=729a211";
import { avatarHtml } from "./ui.js?v=729a211";
import { createSpatial } from "./dna-spatial.js?v=729a211";

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
// A schermo intero (schermoIntero, vedi bindFullscreenToggle) il riquadro è
// sempre abbastanza alto per i 5 rami di NEIGHBOURS_WIDE, e c'è anche più
// posto per allargarli: lo stesso ventaglio respira di più invece di
// restare compresso al raggio tarato sul riquadro piccolo.
//
// Ma non troppo: il riquadro a schermo intero è stretto (è il lato corto
// del telefono), e un figlio piazzato esattamente in orizzontale finisce
// con l'etichetta (fino a 88px, più larga del nodo stesso) a metà fuori
// schermo se il raggio supera metà larghezza del riquadro meno quel
// margine — verificato dal vivo (154px era troppo su un riquadro da 358px).
// 154 resta il tetto per i riquadri molto larghi.
function raggio() {
  if (schermoIntero) {
    const w = el("dnaStage")?.clientWidth || 358;
    return Math.max(110, Math.min(154, w / 2 - 54));
  }
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

// Schermo intero: stessa esplorazione di sempre, solo con tutto lo schermo
// al posto del riquadro — vedi bindFullscreenToggle e la classe
// "dna-schermo-intero" in styles.css. Falso di default: finché non lo tocchi
// il comportamento è identico a prima di questo interruttore.
let schermoIntero = false;

// A schermo intero il pannello nasce "chiuso" (solo il titolo, vedi
// renderPanel): si espande SOLO quando lo tocchi tu. Si azzera ad ogni tap su
// un nodo, come panX/panY — toccare qualcosa di nuovo riparte sempre da capo,
// non trascina dietro lo stato di apertura del nodo precedente.
let panelExpanded = false;

// L'ultimo contesto passato da app.js, così il selettore può ridisegnare da
// solo senza farsi ripassare db/users/currentUser ad ogni interazione.
let ctx = null;
let sheetOpen = false;

// Vista Piatta (questo file, quella di sempre) o Spaziale (dna-spatial.js):
// stessa rete, stesso pannello, stesse persone — cambia solo come la si
// guarda. Interruttore nell'angolo del riquadro; la scelta resta sul
// dispositivo, come Barre/Bolle nelle Statistiche (è una preferenza visiva,
// non qualcosa da imporre al gruppo).
const DNA_VIEW_KEY = "cinefighiDnaView";
function getDnaView() {
  try { return localStorage.getItem(DNA_VIEW_KEY) === "spatial" ? "spatial" : "flat"; } catch { return "flat"; }
}
function setDnaView(v) {
  try { localStorage.setItem(DNA_VIEW_KEY, v); } catch {}
}
let dnaView = getDnaView();
let spatial = null;

// Spostamento manuale della camera rispetto al nodo attivo (vedi il
// trascinamento in fondo al file). Si azzera ad ogni tap su un nodo: toccare
// un nodo ricentra sempre, quindi non ci si perde mai fuori dalla rete.
let panX = 0;
let panY = 0;
let shownIds = [];          // i nodi davvero nel DOM all'ultimo render

// Dopo un'apertura la camera non deve centrarsi con la media pesata della
// vecchia centraSuiFigli (genitore + figli): una media si sposta verso dove
// i nodi sono più fitti, e con un ventaglio sbilanciato lasciava vuoto
// l'emicerchio opposto — verificato dal vivo, non un'ipotesi ("spesso mi
// ritrovo con un sacco di schermo vuoto"). Il render ricentra invece sul
// riquadro d'ingombro di focus + SOLO i figli appena nati (vedi più sotto),
// non tutto il vicinato: un genitore già aperto da prima (quindi già visto)
// non deve più contare nel calcolo e tirare la camera verso di sé — meglio
// che resti lui ai bordi piuttosto che il ramo appena toccato, stesso
// principio della vecchia centraSuiFigli ma con un riquadro invece di una
// media (quella si spostava verso dove i nodi erano più fitti).
let pendingNewIds = null;

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
    trail = [net.rootId];
    panX = 0; panY = 0;
    // Ogni rete nuova riparte da schermo normale: lo schermo intero è una
    // scelta per QUESTA esplorazione (si riaccende da sola al primo tocco,
    // vedi il click handler più sotto), non una preferenza che sopravvive a
    // un "Ricomincia" o a un cambio di persone selezionate.
    setSchermoIntero(false);
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
// minimo che dna.js chiedeva a un regista (ora 2, vedi DIRECTOR_MIN_FILMS:
// per una media di genere serve piu' storico che per un nodo).
const STAT_MIN_TITOLI = 3;

const mediaVoti = (voti) => voti.reduce((s, v) => s + v, 0) / voti.length;
const unaCifra = (n) => n.toFixed(1);

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

  // Attori: stessi criteri del regista, sugli stessi dati (l'indice contiene
  // solo film amati). "Più presente" = in più film amati; "preferito" = il
  // punteggio (media ritirata verso quella del gruppo + persone che lo
  // amano), quello che decide anche chi diventa nodo.
  const attori = [...index.actors.values()];
  const mediaAttore = (a) => mediaVoti((index.byActor.get(a.name) || [])
    .flatMap(e => (index.films.get(e.id)?.fans || []).map(f => f.vote)));
  const piuPresente = [...attori].sort((a, b) => b.films - a.films || b.score - a.score || a.name.localeCompare(b.name))[0];
  if (piuPresente) {
    righe.push({ label: "Attore più presente", value: `${piuPresente.name} (${piuPresente.films} film)` });
  }
  const attorePreferito = attori[0];   // index.actors è già ordinato per punteggio
  if (attorePreferito) {
    righe.push({ label: "Attore preferito", value: `${attorePreferito.name} (${attorePreferito.films} film, media ${unaCifra(mediaAttore(attorePreferito))})` });
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
  // i numeri, e piccola (vedi .dna-signature in CSS): una firma, non un
  // secondo titolo che compete con "Il DNA di...". Il testo sta in uno
  // <span> a parte, non nel div a piena larghezza: il gradiente si clippa
  // sulla larghezza del box, quindi su un div intero (con text-align:center)
  // il centro del testo cade a metà sfumatura — un grigiastro invece del
  // vero ciano/arancio (stesso bug già risolto per .topbar__title).
  const firma = `<div class="dna-signature"><span>CineFighi</span></div>`;

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

  if (fullViewFit) {
    scrollBox.scrollTop = 0; scrollBox.scrollLeft = 0;
  } else {
    // Ingrandita: la rete e' piu' grande del riquadro e lo scorrimento
    // partiva dall'angolo in alto a sinistra, spesso vuoto (la rete si
    // allunga in diagonale): si apre invece sul baricentro dei nodi. Il
    // browser limita da solo lo scorrimento ai bordi validi.
    const { cx, cy } = fullViewGeom;
    scrollBox.scrollLeft = offX + (cx - left) * scale - scrollBox.clientWidth / 2;
    scrollBox.scrollTop = offY + (cy - top) * scale - scrollBox.clientHeight / 2;
  }
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
  // La forma cambia fra "Adatta" (allargata allo schermo) e "Ingrandita"
  // (naturale): si ridisegna, poi si applica la scala.
  if (!el("dnaFullView")?.classList.contains("hidden")) {
    // Tre passaggi per un motivo: la legenda si legge dagli archi GIA'
    // disegnati (fullViewLegend), ma una volta scritta cambia l'altezza
    // lasciata alla rete, da cui dipende l'allargamento. Disegno, legenda,
    // ridisegno con l'altezza finale.
    renderFullNetwork();
    renderFullViewStats();
    renderFullNetwork();
  }
  applyFullViewScale();
}

// In "Adatta" la rete si scala in modo uniforme per stare intera nel riquadro:
// se ha una forma diversa dallo schermo (tipicamente alta e stretta su un
// telefono) restano bande vuote ai lati. Prima di scalare si allarga quindi
// la DISTANZA fra i nodi lungo l'asse corto, cosi' la forma segue quella
// dello schermo; i nodi non si deformano (locandine quadrate, cerchi tondi)
// perche' si spostano i centri, non si stira il disegno. Al massimo 1,6x:
// oltre, le distanze fra nodi collegati diventerebbero troppo false.
const FULL_VIEW_MAX_STRETCH = 1.6;

function stretchForScreen(placed, scrollBox) {
  if (placed.length < 2) return;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const n of placed) {
    minX = Math.min(minX, n.x); maxX = Math.max(maxX, n.x);
    minY = Math.min(minY, n.y); maxY = Math.max(maxY, n.y);
  }
  const h2 = FULL_VIEW_NODE_HALF * 2;
  const spanX = maxX - minX, spanY = maxY - minY;
  const availW = Math.max(scrollBox.clientWidth - FULL_VIEW_GAP * 2, 1);
  const availH = Math.max(scrollBox.clientHeight - FULL_VIEW_GAP * 2, 1);
  const boxAspect = availW / availH;
  const contentW = spanX + h2, contentH = spanY + h2;
  let sx = 1, sy = 1;
  if (contentW / contentH < boxAspect && spanX > 0) {
    sx = Math.min(FULL_VIEW_MAX_STRETCH, (boxAspect * contentH - h2) / spanX);
  } else if (contentW / contentH > boxAspect && spanY > 0) {
    sy = Math.min(FULL_VIEW_MAX_STRETCH, (contentW / boxAspect - h2) / spanY);
  }
  sx = Math.max(1, sx); sy = Math.max(1, sy);
  const mx = (minX + maxX) / 2, my = (minY + maxY) / 2;
  for (const n of placed) { n.x = mx + (n.x - mx) * sx; n.y = my + (n.y - my) * sy; }
}

// Disegna nodi e archi della vista completa. In "Adatta" con le posizioni
// allargate (stretchForScreen), ma SOLO per il tempo del disegno: le
// posizioni vere della rete, usate dalla schermata DNA, non cambiano mai.
function renderFullNetwork() {
  if (!net) return;
  const edgesEl = el("dnaFullEdges");
  const nodesEl = el("dnaFullNodes");
  const overlay = el("dnaFullView");
  const scrollBox = overlay?.querySelector(".dna-full-view__scroll");
  if (!edgesEl || !nodesEl || !overlay) return;

  const placed = [...net.nodes.values()].filter(n => n.x !== null);
  if (!placed.length) return;

  const saved = placed.map(n => [n.x, n.y]);
  try {
    if (fullViewFit && scrollBox) stretchForScreen(placed, scrollBox);

    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const n of placed) {
      minX = Math.min(minX, n.x); maxX = Math.max(maxX, n.x);
      minY = Math.min(minY, n.y); maxY = Math.max(maxY, n.y);
    }
    fullViewGeom = {
      left: minX - FULL_VIEW_NODE_HALF,
      top: minY - FULL_VIEW_NODE_HALF,
      contentW: maxX - minX + FULL_VIEW_NODE_HALF * 2,
      contentH: maxY - minY + FULL_VIEW_NODE_HALF * 2,
      // Baricentro dei nodi (non il centro del riquadro: una rete che si
      // allunga in diagonale ha il riquadro in gran parte vuoto). Serve a
      // "Ingrandita", che si apre centrata qui invece che sull'angolo in alto
      // a sinistra.
      cx: placed.reduce((a, n) => a + n.x, 0) / placed.length,
      cy: placed.reduce((a, n) => a + n.y, 0) / placed.length
    };

    const hops = hopsFrom(net, focusId);
    edgesEl.innerHTML = net.edges.map(e => edgeLine(e, hops)).join("");
    nodesEl.innerHTML = placed.map(n => nodeButton(n, hops)).join("");
  } finally {
    placed.forEach((n, i) => { n.x = saved[i][0]; n.y = saved[i][1]; });
  }
}

function openFullNetworkView() {
  if (!net) return;
  const overlay = el("dnaFullView");
  const who = el("dnaFullViewWho");
  if (!el("dnaFullEdges") || !el("dnaFullNodes") || !overlay) return;
  if (![...net.nodes.values()].some(n => n.x !== null)) return;

  if (who) who.textContent = peopleLabel();
  // L'overlay va mostrato PRIMA di misurare il riquadro scorrevole (nascosto
  // misurerebbe 0).
  overlay.classList.remove("hidden");
  setFullViewFit(fullViewFit);
}

function closeFullNetworkView() {
  el("dnaFullView")?.classList.add("hidden");
}

function bindFullView() {
  el("dnaViewAllBtn")?.addEventListener("click", () => { openFullNetworkView(); });
  el("dnaFullViewCloseBtn")?.addEventListener("click", () => { closeFullNetworkView(); });
  el("dnaFullViewZoom")?.addEventListener("click", e => {
    const btn = e.target.closest("[data-zoom]");
    if (!btn) return;
    setFullViewFit(btn.dataset.zoom === "fit");
  });
}

// Schermo intero: stessa esplorazione di sempre (stesso tocco, stesso
// ventaglio radiale, stesso pannello), solo con tutto lo schermo invece del
// riquadro — vedi .dna-schermo-intero in styles.css per il resto. Non è
// "vedi tutta la rete" qui sopra (quella è una foto di sola lettura, pensata
// per lo screenshot): qui si continua a toccare ed esplorare, proprio come
// nel riquadro piccolo.
// Accende/spegne lo schermo intero senza ridisegnare: la usano sia il tasto
// dedicato sia l'apertura automatica al primo tocco su un nodo (vedi il
// click handler più sotto), così i due punti non si disallineano mai su
// cosa vuol dire "acceso" (classe su #app + aria-pressed sul tasto).
function setSchermoIntero(value) {
  schermoIntero = value;
  el("dnaFullscreenBtn")?.setAttribute("aria-pressed", schermoIntero ? "true" : "false");
  el("app")?.classList.toggle("dna-schermo-intero", schermoIntero);
}

function bindFullscreenToggle() {
  const btn = el("dnaFullscreenBtn");
  if (!btn) return;
  btn.addEventListener("click", () => {
    setSchermoIntero(!schermoIntero);
    panelExpanded = false;
    // La misura del riquadro è appena cambiata di scatto (niente transizione
    // lì, vedi CSS): ricentra subito, non al prossimo tocco — altrimenti per
    // un istante la rete resterebbe disegnata sulla misura vecchia.
    if (net) { panX = 0; panY = 0; render(); }
  });
}

function renderMessage(text) {
  const nodes = el("dnaNodes");
  const edges = el("dnaEdges");
  const panel = el("dnaPanel");
  if (edges) edges.innerHTML = "";
  if (nodes) nodes.innerHTML = "";
  spatial?.clear();
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

// Oltre alla distanza minima in linea d'aria, un controllo sul rettangolo:
// i nodi sono piu' alti che larghi (poster + etichetta, fino a ~88px per un
// film molto amato) e sulla diagonale due nodi a distanza MIN_GAP possono
// comunque toccarsi. Emerge quando un hub (es. un attore in molti film)
// riempie il ventaglio e i tentativi cadono vicino al limite.
const MIN_DX = 66;
const MIN_DY = 92;

function tooClose(x, y, ignoreId) {
  for (const n of net.nodes.values()) {
    if (n.id === ignoreId || n.x === null) continue;
    const dx = Math.abs(n.x - x);
    const dy = Math.abs(n.y - y);
    if (Math.hypot(dx, dy) < MIN_GAP || (dx < MIN_DX && dy < MIN_DY)) return true;
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
  // Ultima spiaggia: ventaglio pieno (con hub molto collegati, ad esempio un
  // attore in molti film, i primi tentativi possono finire tutti occupati).
  // Si allarga ancora il raggio e si gira tutto attorno al genitore finche'
  // c'e' posto, invece di piazzare a caso sopra un altro nodo.
  for (let ring = 1; ring <= 6; ring++) {
    const r = raggio() + PLACE_TRIES * 3 + ring * 34;
    for (let k = 0; k < 16; k++) {
      const a = angle + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * (Math.PI / 8);
      const x = parent.x + Math.cos(a) * r;
      const y = parent.y + Math.sin(a) * r;
      if (!tooClose(x, y, parent.id)) return { x, y };
    }
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
  if (node.type === "attore") {
    return `<span class="dna-node__actor">${escapeHtml(initials(node.label))}</span>`;
  }
  return `<span class="dna-node__genre">${escapeHtml(node.label.slice(0, 3).toUpperCase())}</span>`;
}

// I vicini di quello che stai guardando restano pieni; più ci si allontana,
// più si spengono. Quattro livelli bastano: oltre, i nodi escono comunque dal
// DOM (DOM_MAX_HOPS).
function depthClass(h) { return Math.min(h ?? 0, 4); }

// Un nodo è un "punto d'incontro" quando lo amano TUTTE le persone che stai
// guardando — non una parte di loro. Solo in modalità condivisa (2-3
// selezionati), e solo film/genere/regista/attore: una persona non può essere un
// punto d'incontro di se stessa. È lo stesso sharedCountOf che ordina i
// candidati in dna.js, qui usato per decidere l'evidenza visiva invece
// dell'ordine — la stessa informazione, letta in due punti diversi.
function isMeetingPoint(n) {
  if (!index?.shared || !selectedPeople) return false;
  if (n.type !== "film" && n.type !== "genere" && n.type !== "regista" && n.type !== "attore") return false;
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
function nodeButton(n, hops, conPiu = false) {
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
    ${conPiu ? piuHtml(n) : ""}
    ${withLabel ? `<span class="dna-node__label">${escapeHtml(n.label)}</span>` : ""}
  </button>`;
}

// Il segno dei collegamenti ancora chiusi. Film, regista e attore ne hanno
// pochi: il numero dice quanto manca e si arriva a "finito". Persona e genere
// ne hanno centinaia (+180, +146), un numero che non dice niente e che
// nessuno aprirebbe tutto: lì solo "+", cioè "c'è altro".
function piuLabel(node, restano) {
  return node.type === "persona" || node.type === "genere" ? "+" : `+${restano}`;
}

// "+N": un nodo aperto che ha ancora altri collegamenti non mostrati. Un
// tocco sul segno li apre (tapMore), come il tocco sul nodo attivo (vedi
// tapNode): il segno serve a vederlo prima di toccare. Stesso in entrambe le
// viste; non nella vista "tutta la rete" (una foto, non si tocca).
function piuHtml(n) {
  const restano = n.expanded ? remainingCount(net, index, n.id) : 0;
  return restano > 0
    ? `<span class="dna-node__more" data-more="${escapeHtml(n.id)}" role="button" aria-label="Mostra altri ${restano} collegamenti">${piuLabel(n, restano)}</span>`
    : "";
}

// Per la vista spaziale: lo stesso nodo di nodeButton (stesse classi fisse,
// stesso contenuto) senza posizione né profondità, che lì decide la
// proiezione. E lo stesso arco di edgeLine, senza coordinate.
function nodeShell(n) {
  const cls = [
    "dna-node", `dna-node--${n.type}`,
    isMeetingPoint(n) ? "is-shared" : "",
    lovedLevel(n) ? `is-loved-${lovedLevel(n)}` : ""
  ].filter(Boolean).join(" ");
  return { cls, html: `${nodeInner(n)}${piuHtml(n)}<span class="dna-node__label">${escapeHtml(n.label)}</span>` };
}

function edgeClass(e) {
  const incontro = isMeetingPoint(net.nodes.get(e.a)) || isMeetingPoint(net.nodes.get(e.b));
  return `dna-edge dna-edge--${e.kind}${incontro ? " is-shared" : ""}`;
}

function render() {
  const nodesEl = el("dnaNodes");
  const edgesEl = el("dnaEdges");
  const canvas = el("dnaCanvas");
  if (!nodesEl || !edgesEl || !canvas) return;

  if (dnaView === "spatial" && spatial) {
    // La vista spaziale disegna da sé tutta la rete (niente budget DOM: i
    // lontani svaniscono nella sua "nebbia"); qui resta tutto il resto.
    if (nodesEl.firstChild) { nodesEl.innerHTML = ""; edgesEl.innerHTML = ""; }
    shownIds = [];
    const nuovi = pendingNewIds;
    pendingNewIds = null;
    spatial.update(net, focusId, nuovi);
    afterRender();
    return;
  }

  const hops = hopsFrom(net, focusId);

  // Budget: prima i più vicini alla camera, a parità l'id (ordine stabile).
  const visible = [...net.nodes.values()]
    .filter(n => n.x !== null && (hops.get(n.id) ?? Infinity) <= DOM_MAX_HOPS)
    .sort((a, b) => (hops.get(a.id) - hops.get(b.id)) || a.id.localeCompare(b.id))
    .slice(0, MAX_DOM_NODES);
  const shown = new Set(visible.map(n => n.id));

  const shownEdges = net.edges.filter(e => shown.has(e.a) && shown.has(e.b));
  edgesEl.innerHTML = shownEdges.map(e => edgeLine(e, hops)).join("");

  nodesEl.innerHTML = visible.map(n => nodeButton(n, hops, true)).join("");

  shownIds = visible.map(n => n.id);

  if (pendingNewIds) {
    const nuoviIds = pendingNewIds;
    pendingNewIds = null;
    animaCrescita(nuoviIds, shownEdges);
    const focus = net.nodes.get(focusId);
    if (focus) {
      // Solo focus + figli appena nati: un genitore già aperto da prima (e
      // quindi già visto) non deve contare qui, altrimenti tira la camera
      // verso di sé e peggiora la vista sul ramo che hai appena toccato —
      // segnalato dal vivo ("mi basterebbe che quello che esce non sia
      // tagliato, le parti aperte in precedenza possono esserlo").
      //
      // Un figlio che place() ha dovuto spingere molto oltre raggio() (posto
      // vicino già occupato, tocca allargare l'anello) non conta nemmeno
      // lui: trascinerebbe la camera verso di lui invece di inquadrare bene
      // il resto del ventaglio, per un nodo che comunque resterebbe ai
      // margini — meglio lui solo raggiungibile trascinando.
      const distanzaNormale = raggio() * 1.3;
      let minX = focus.x, maxX = focus.x, minY = focus.y, maxY = focus.y;
      for (const id of nuoviIds) {
        const n = net.nodes.get(id);
        if (!n || n.x === null) continue;
        if (Math.hypot(n.x - focus.x, n.y - focus.y) > distanzaNormale) continue;
        minX = Math.min(minX, n.x); maxX = Math.max(maxX, n.x);
        minY = Math.min(minY, n.y); maxY = Math.max(maxY, n.y);
      }
      // Spostamento comunque limitato a un raggio: un riquadro d'ingombro,
      // a differenza della media pesata della vecchia centraSuiFigli, non ha
      // da solo un limite naturale a quanto può spingere la camera.
      const maxShift = raggio();
      panX = Math.max(-maxShift, Math.min(maxShift, focus.x - (minX + maxX) / 2));
      panY = Math.max(-maxShift, Math.min(maxShift, focus.y - (minY + maxY) / 2));
    }
  }

  applyCamera();
  afterRender();
}

// Quello che segue un render, in entrambe le viste.
function afterRender() {
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

// ─── CRESCITA DEI RAMI ───────────────────────────────────────────────────────
// I nodi appena aperti non compaiono più di scatto al loro posto: escono dal
// genitore e ci scivolano in ~0,4s, e i loro archi crescono insieme a loro.
// Solo transform/opacity con le Web Animations (compositor, nessun loop JS):
// a fine animazione restano le regole CSS di sempre, posizione compresa —
// left/top sono già quelli finali dal primo istante, cambia solo come ci si
// arriva.
const CRESCITA_MS = 420;
const CRESCITA_SFASAMENTO_MS = 25;   // un filo di sequenza fra fratelli
const CRESCITA_EASE = "cubic-bezier(.22,1,.36,1)";   // = --ease in styles.css

function animaCrescita(nuoviIds, shownEdges) {
  if (!nuoviIds.length || typeof Element.prototype.animate !== "function") return;
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;

  // La camera si sposta con la stessa durata, non in 0,2s davanti ai nodi.
  const canvas = el("dnaCanvas");
  canvas?.classList.add("is-growing");
  setTimeout(() => canvas?.classList.remove("is-growing"), CRESCITA_MS + 80);

  const nuovi = new Set(nuoviIds);
  nuoviIds.forEach((id, i) => {
    const n = net.nodes.get(id);
    const p = n && net.nodes.get(n.parent);
    const btn = el("dnaNodes")?.querySelector(`[data-node="${CSS.escape(id)}"]`);
    if (!n || !p || p.x === null || !btn) return;
    const dx = (p.x - n.x).toFixed(1), dy = (p.y - n.y).toFixed(1);
    btn.animate(
      [{ transform: `translate(-50%, -50%) translate(${dx}px, ${dy}px) scale(.35)`, opacity: 0 }, {}],
      { duration: CRESCITA_MS, delay: i * CRESCITA_SFASAMENTO_MS, easing: CRESCITA_EASE, fill: "backwards" }
    );
  });

  // L'arco cresce dall'estremo già presente verso il nodo nuovo, con la stessa
  // curva: l'estremità resta attaccata al nodo per tutto il tragitto.
  const lines = el("dnaEdges")?.children || [];
  shownEdges.forEach((e, k) => {
    const nuovoA = nuovi.has(e.a), nuovoB = nuovi.has(e.b);
    if (nuovoA === nuovoB || !lines[k]) return;
    const origine = net.nodes.get(nuovoA ? e.b : e.a);
    const i = nuoviIds.indexOf(nuovoA ? e.a : e.b);
    lines[k].style.transformOrigin = `${origine.x.toFixed(1)}px ${origine.y.toFixed(1)}px`;
    lines[k].animate(
      [{ transform: "scale(0)" }, { transform: "scale(1)" }],
      { duration: CRESCITA_MS, delay: i * CRESCITA_SFASAMENTO_MS, easing: CRESCITA_EASE, fill: "backwards" }
    );
  });
}

// Il pannello è il posto dove sta l'informazione: la rete mostra i
// collegamenti, qui si legge chi, quanto e perché. È il motivo per cui un tap
// apre pochi rami — quello che non diventa un nodo si legge qui sotto.
// Unico punto in cui si muove la camera: posizione del nodo attivo più lo
// spostamento manuale. È una sola translate sul contenitore, non un
// riposizionamento dei nodi, quindi il telefono la anima sul compositor.
//
// Una prima versione aggiungeva anche uno zoom automatico a schermo intero
// (si allontanava quando i nodi aperti non ci stavano più): provata dal vivo,
// rimpiccioliva le locandine anche con poche aperture (0,87x con soli 6 nodi)
// e lasciava vuoti sopra la rete senza un vero motivo — tolta. A schermo
// intero lo spazio in più arriva da raggio() e dal riquadro grande, non da
// uno zoom: stesso identico comportamento della camera di sempre.
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

  const restano = node.expanded ? remainingCount(net, index, node.id) : 0;
  const chiudi = !node.expanded
    ? `<span class="dna-panel__hint">Toccalo per aprire i collegamenti</span>`
    : restano
      ? `<span class="dna-panel__hint">Toccalo per mostrarne altri (${piuLabel(node, restano)})</span>`
      : `<span class="dna-panel__hint">Toccalo di nuovo per richiudere</span>`;

  // "Scheda →" sta nella riga del titolo e non in fondo: su un telefono
  // piccolo un bottone in coda al pannello finisce dietro la barra di
  // navigazione, e la scheda è la cosa che si vuole raggiungere subito.
  const scheda = node.type === "film"
    ? `<button type="button" class="dna-panel__scheda open-detail" data-id="${escapeHtml(node.meta.id)}">Scheda →</button>`
    : "";

  // A schermo intero il pannello galleggia SOPRA la rete (vedi
  // .dna-schermo-intero in styles.css): disteso come nel riquadro normale
  // finiva per coprire nodi veri, rendendoli intoccabili (verificato dal
  // vivo). Qui nasce come una striscia col solo titolo — "a comparsa" — e il
  // corpo intero si vede solo se la tocchi (panelExpanded, azzerato ad ogni
  // nuovo tap su un nodo). Fuori da schermo intero il pannello resta quello
  // di sempre, nel flusso della pagina: lì non copre niente, non serve.
  if (schermoIntero) {
    panel.classList.toggle("is-compact", !panelExpanded);
    // Chiuso, un film mostra anche chi l'ha votato e con che voto: è
    // l'informazione che conta di più su un nodo film, e prima toccava
    // aprire il pannello anche solo per vedere quello. Da aperto i fan sono
    // già dentro panelBody, qui sotto — non si ripetono due volte.
    const fansCompatti = !panelExpanded && node.type === "film" && (node.meta.fans || []).length
      ? `<div class="dna-panel__peek-fans">${fansHtml(node.meta.fans)}</div>`
      : "";
    // "Richiudi" nella barra, non solo nel corpo del pannello (chiuso a schermo
    // intero): un nodo aperto si richiude con un tocco solo.
    const richiudi = node.expanded
      ? `<button type="button" class="dna-panel__richiudi-bar" data-richiudi="${escapeHtml(node.id)}">Richiudi</button>`
      : "";
    panel.innerHTML = `
      <div class="dna-panel__bar">
        <button type="button" class="dna-panel__peek" id="dnaPanelPeek">
          ${panelIcon(node)}<strong>${escapeHtml(panelTitle(node))}</strong>
          <span class="dna-panel__peek-hint">${panelExpanded ? "▾" : "Dettagli →"}</span>
        </button>
        ${richiudi}
      </div>
      ${fansCompatti}
      <div class="dna-panel__full"${panelExpanded ? "" : " hidden"}>
        ${scheda}
        ${panelBody(node)}
        ${chiudi}
      </div>`;
    el("dnaPanelPeek")?.addEventListener("click", () => {
      panelExpanded = !panelExpanded;
      renderPanel(node);
    });
    return;
  }

  panel.classList.remove("is-compact");
  // "Richiudi" sta sempre in alto a destra: nella barra a schermo intero, qui
  // nella riga del titolo.
  const richiudiTesta = node.expanded
    ? `<button type="button" class="dna-panel__richiudi-bar" data-richiudi="${escapeHtml(node.id)}">Richiudi</button>`
    : "";
  panel.innerHTML = `
    <div class="dna-panel__head">${panelIcon(node)}<strong>${escapeHtml(panelTitle(node))}</strong>${scheda}${richiudiTesta}</div>
    ${panelBody(node)}
    ${chiudi}`;
}

function panelIcon(node) {
  if (node.type === "persona") return avatarHtml(node.label, 30);
  if (node.type === "regista") return `<span class="dna-chip dna-chip--regista">${escapeHtml(initials(node.label))}</span>`;
  if (node.type === "attore") return `<span class="dna-chip dna-chip--attore">${escapeHtml(initials(node.label))}</span>`;
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

// ─── PANNELLO DELLA VISTA SPAZIALE ───────────────────────────────────────────
// Stessi dati della vista piatta, letti da un altro lato: il pannello piatto
// racconta COSA è il nodo, questo racconta COSA LO LEGA a chi guarda — il
// percorso fatto per arrivarci e quanto lo condividete. Solo voti già in
// memoria (index), nessun numero inventato: niente percentuali di "affinità",
// solo conteggi di titoli.
const PERSONA_PREFIX = "persona:".length;
const riferimento = () => net.rootId.slice(PERSONA_PREFIX);
const nomeVisto = (nome) => (nome === ctx?.currentUser ? "Tu" : nome);

// Il percorso fatto: i nodi che hai toccato, dalla radice al nodo attivo. Non
// il collegamento più corto della rete (con i "ponti" fra rami ce n'è quasi
// sempre uno più breve di quello che hai percorso davvero): quello che serve
// a orientarsi è la STRADA CHE HAI FATTO. Toccare un nodo già nel percorso lo
// accorcia fino lì, come un "indietro"; ogni passaggio si tocca per tornarci.
let trail = [];

function visit(id) {
  focusId = id;
  const i = trail.indexOf(id);
  if (i !== -1) trail.length = i + 1;
  else trail.push(id);
}

// Il percorso riallineato alla rete di adesso: un ramo richiuso porta via i
// nodi che c'erano solo grazie a lui, e il percorso finisce sempre sul nodo
// attivo.
function percorsoAttuale(node) {
  const t = [];
  for (const id of trail) { if (!net.nodes.has(id)) break; t.push(id); }
  const i = t.indexOf(node.id);
  if (i !== -1) t.length = i + 1;
  else t.push(node.id);
  trail = t;
  return t;
}

const MAX_PASSAGGI = 4;

function percorsoHtml(node) {
  const t = percorsoAttuale(node);
  if (t.length < 2) return "";
  // Percorsi lunghi: l'inizio, un "…" e gli ultimi tre passaggi.
  const visti = t.length > MAX_PASSAGGI ? [t[0], null, ...t.slice(-(MAX_PASSAGGI - 1))] : t;
  const chip = (id) => {
    if (id === null) return `<span class="dna-path__sep">…</span>`;
    const nome = escapeHtml(id === net.rootId ? nomeVisto(riferimento()) : net.nodes.get(id).label);
    return id === node.id
      ? `<span class="dna-path__chip is-here">${nome}</span>`
      : `<button type="button" class="dna-path__chip" data-trail="${escapeHtml(id)}">${nome}</button>`;
  };
  return `<div class="dna-path"><span class="dna-path__label">Il tuo percorso</span>${visti.map(chip).join(`<span class="dna-path__sep">›</span>`)}</div>`;
}

const countChip = (nome, n) =>
  `<span class="dna-fan">${avatarHtml(nome, 22)}<span class="dna-fan__name">${escapeHtml(nomeVisto(nome))}</span><span class="dna-fan__vote">${n}</span></span>`;

const titoliIn = (n) => `${n} ${n === 1 ? "titolo" : "titoli"}`;

// I titoli amati sia da `a` sia da `b`, i più votati insieme per primi.
function incomune(a, b) {
  const miei = new Map((index.byPerson.get(a) || []).map(e => [e.id, e.w]));
  return (index.byPerson.get(b) || [])
    .filter(e => miei.has(e.id))
    .map(e => ({ id: e.id, peso: e.w + miei.get(e.id), film: index.films.get(e.id) }))
    .filter(x => x.film)
    .sort((x, y) => y.peso - x.peso || x.film.title.localeCompare(y.film.title));
}

function panelBody(node) {
  const m = node.meta, rif = riferimento();
  const percorso = percorsoHtml(node);
  const incontro = isMeetingPoint(node)
    ? `<p class="dna-panel__line dna-panel__line--shared">Punto d'incontro: piace a ${selectedPeople.length === 2 ? "entrambi" : "tutti e tre"}.</p>`
    : "";

  if (node.type === "persona") {
    if (node.label === rif) {
      // Chi guardi: con chi hai più titoli amati in comune.
      const io = rif === ctx?.currentUser;
      const conta = `<p class="dna-panel__line">${io ? "Hai" : "Ha"} amato ${titoliIn(m.liked || 0)} (voto 7 o più).</p>`;
      const n = selectedPeople?.length || 0;
      if (n >= 2) {
        // Più persone scelte: con chi si sovrappone lo sa già il selettore (le
        // altre sono quelle spuntate), quindi una riga sola sul comune a TUTTI.
        const chi = n === 2 ? "entrambi" : n === 3 ? "tutti e tre" : n === 4 ? "tutti e quattro" : `tutti e ${n}`;
        const insieme = [...index.films.values()].filter(f => f.fans.length === n);
        const genere = new Map();
        for (const f of insieme) for (const g of f.genres) genere.set(g, (genere.get(g) || 0) + 1);
        const top = [...genere.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 2).map(([g]) => escapeHtml(g));
        return `${conta}
        <p class="dna-panel__line">${insieme.length
          ? `Amati da ${chi}: <strong>${titoliIn(insieme.length)}</strong>${top.length ? ` · soprattutto ${top.join(" e ")}` : ""}.`
          : `Nessun titolo amato da ${chi}.`}</p>`;
      }
      if (n === 1) return conta;
      // Tutto il gruppo: con chi si hanno più titoli amati in comune.
      const altri = [...index.byPerson.keys()].filter(x => x !== rif)
        .map(x => ({ n: x, tot: incomune(rif, x).length }))
        .filter(x => x.tot > 0)
        .sort((a, b) => b.tot - a.tot || a.n.localeCompare(b.n))
        .slice(0, 3);
      return `${conta}
        ${altri.length ? `<p class="dna-panel__line dna-panel__label">Con chi ${io ? "hai" : "ha"} più titoli in comune</p><div class="dna-fans">${altri.map(x => countChip(x.n, x.tot)).join("")}</div>` : ""}`;
    }
    const insieme = incomune(rif, node.label);
    const genere = new Map();
    for (const x of insieme) for (const g of x.film.genres) genere.set(g, (genere.get(g) || 0) + 1);
    const top = [...genere.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 2).map(([g]) => g);
    return `
      ${percorso}
      <p class="dna-panel__line">${insieme.length ? `${escapeHtml(nomeVisto(rif))} e ${escapeHtml(node.label)} avete amato in comune <strong>${titoliIn(insieme.length)}</strong>.` : `${escapeHtml(nomeVisto(rif))} e ${escapeHtml(node.label)} non avete titoli amati in comune.`}</p>
      ${insieme.length ? `<p class="dna-panel__line">Ad esempio: ${insieme.slice(0, 3).map(x => escapeHtml(x.film.title)).join(" · ")}.</p>` : ""}
      ${top.length ? `<p class="dna-panel__line">Soprattutto: ${top.map(escapeHtml).join(" · ")}.</p>` : ""}`;
  }

  if (node.type === "film") {
    // Regia, cast, generi e anno stanno nella scheda ("Scheda →"): qui solo il
    // legame fra le persone. Niente frase su chi lo ama: i nomi e i voti qui
    // sotto la dicono già.
    const fans = m.fans || [];
    return `
      ${percorso}
      ${incontro}
      <p class="dna-panel__line dna-panel__label">Chi l'ha amato (${fans.length})</p>
      ${fansHtml(fans)}`;
  }

  // Genere, regista, attore: chi li ama, e quanto ci sei dentro tu.
  const key = node.id.slice(node.id.indexOf(":") + 1);
  const voci = node.type === "genere" ? index.byGenre.get(key)
    : node.type === "regista" ? index.byDirector.get(key) : index.byActor.get(key);
  const tally = new Map();
  let tuoi = 0;
  for (const e of voci || []) {
    const film = index.films.get(e.id);
    if (!film) continue;
    if (film.fans.some(f => f.name === rif)) tuoi++;
    for (const f of film.fans) tally.set(f.name, (tally.get(f.name) || 0) + 1);
  }
  const chi = [...tally.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 4);
  return `
    ${percorso}
    ${incontro}
    <p class="dna-panel__line">${tuoi ? `Tra i tuoi amati: <strong>${titoliIn(tuoi)}</strong> su ${(voci || []).length}.` : `Nessuno dei tuoi amati ne fa parte (${titoliIn((voci || []).length)} nel gruppo).`}</p>
    ${chi.length ? `<p class="dna-panel__line dna-panel__label">Chi lo ama di più (titoli)</p><div class="dna-fans">${chi.map(([n, t]) => countChip(n, t)).join("")}</div>` : ""}`;
}

// ─── EVENTI ──────────────────────────────────────────────────────────────────

export function initDnaView() {
  if (bound) return;
  bound = true;

  bindPan();
  bindPeople();
  bindIntroToggle();
  bindFullView();
  bindFullscreenToggle();

  const nodesEl = el("dnaNodes");
  if (nodesEl) {
    nodesEl.addEventListener("click", e => {
      const btn = e.target.closest(".dna-node");
      if (!btn || dragged) return;   // era un trascinamento, non un tocco
      if (e.target.closest(".dna-node__more")) tapMore(btn.dataset.node);
      else tapNode(btn.dataset.node);
    });
  }

  // "Richiudi" nel pannello: vedi renderPanel.
  el("dnaPanel")?.addEventListener("click", e => {
    if (!net) return;
    // Un passaggio del percorso: si torna a quel nodo (solo selezione, non
    // apre né richiude niente).
    const passo = e.target.closest("[data-trail]");
    if (passo) {
      const id = passo.dataset.trail;
      if (!net.nodes.has(id)) return;
      visit(id);
      panelExpanded = false;
      panX = 0; panY = 0;
      render();
      return;
    }
    const b = e.target.closest("[data-richiudi]");
    if (!b) return;
    const id = b.dataset.richiudi;
    if (!net.nodes.get(id)?.expanded) return;
    collapse(net, id);
    visit(id);
    panX = 0; panY = 0;
    render();
  });

  const spatialEl = el("dnaSpatial");
  if (spatialEl) {
    spatial = createSpatial({ container: spatialEl, nodeShell, edgeClass, onTap: tapNode, onMore: tapMore, radius: raggio });
  }
  bindViewToggle();
}

// Un tocco su un nodo, da qualunque delle due viste.
function tapNode(id) {
  const node = net?.nodes.get(id);
  if (!node) return;
  // Il primissimo tocco (un solo nodo in rete, quello che stai per
  // espandere) accende da solo lo schermo intero: è il momento in cui lo
  // spazio comincia davvero a servire, e chiedere di premere un tasto a
  // parte prima è un passo in più che quasi nessuno farebbe mai. Va
  // acceso PRIMA di espandere, non dopo: layoutChildren usa raggio(), e
  // una volta piazzato un nodo non si muove più — acceso dopo, il primo
  // giro di nodi resterebbe piazzato piccolo. Il tasto in alto resta per
  // chi lo vuole spento, o acceso subito anche prima di toccare nulla.
  if (net.nodes.size === 1 && !schermoIntero) setSchermoIntero(true);
  // Un tap su un nodo che non è quello attivo lo SELEZIONA soltanto: serve
  // a leggerne il pannello (chi l'ha votato, i generi, la regia) senza
  // toccare la rete. Apre o richiude solo il nodo già attivo, cioè quello
  // che il pannello sta già descrivendo — così guardare non è mai un'azione
  // distruttiva, e "richiudi" non capita mai per sbaglio.
  //
  // Sul nodo attivo, il tocco apre sempre ciò che c'è ancora da aprire: se ha
  // altri collegamenti chiusi ne mostra altri (stesso gesto del "+"), e solo
  // quando non resta niente richiude. Prima richiudeva sempre, ed era
  // impossibile sapere se un altro tocco ne avrebbe aperti altri o chiuso
  // tutto. Chi ne ha sempre di più (persone, generi) si richiude dal
  // "Richiudi" nel pannello.
  let nuovi = null;
  if (id === focusId) {
    if (!node.expanded || remainingCount(net, index, id) > 0) nuovi = expandNode(id, false);
    else collapse(net, id);
  } else if (!node.expanded) {
    nuovi = expandNode(id, false);
  }
  visit(id);
  panelExpanded = false;
  // Toccare un nodo ricentra sempre; se ha appena figliato, il render che
  // segue ricentra sul riquadro d'ingombro di focus + figli nuovi (vedi
  // pendingNewIds più sopra nel file).
  if (nuovi) pendingNewIds = nuovi;
  else { panX = 0; panY = 0; }
  render();
}

// "+N": apre altri collegamenti di un nodo già aperto, senza richiuderlo.
function tapMore(id) {
  const node = net?.nodes.get(id);
  if (!node) return;
  const nuovi = expandNode(id, false);
  visit(id);
  panelExpanded = false;
  if (nuovi.length) pendingNewIds = nuovi;
  else { panX = 0; panY = 0; }
  render();
}

function bindViewToggle() {
  const box = el("dnaViewToggle");
  if (!box) return;
  box.addEventListener("click", e => {
    const btn = e.target.closest("[data-dna-view]");
    if (!btn || btn.dataset.dnaView === dnaView) return;
    dnaView = btn.dataset.dnaView;
    setDnaView(dnaView);
    applyViewMode();
    // Tornando al piatto la camera riparte centrata sul nodo attivo.
    panX = 0; panY = 0;
    if (net) render();
  });
  applyViewMode();
}

function applyViewMode() {
  for (const btn of document.querySelectorAll("#dnaViewToggle [data-dna-view]")) {
    const on = btn.dataset.dnaView === dnaView;
    btn.classList.toggle("active", on);
    btn.setAttribute("aria-pressed", on ? "true" : "false");
  }
  el("dnaCanvas")?.classList.toggle("hidden", dnaView === "spatial");
  if (dnaView === "spatial") spatial?.show(); else spatial?.hide();
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
    // In vista spaziale i gesti sono suoi (dna-spatial.js).
    if (dnaView === "spatial") return;
    // Il selettore è dentro al riquadro: lì i tocchi sono suoi, non della rete.
    if (e.target.closest(".dna-sheet")) return;
    // Un solo nodo (il tuo, ancora chiuso) sta sempre fermo al centro: non
    // c'è niente da scoprire trascinandolo, solo PAN_MARGIN di gioco a vuoto
    // che lo spostava via dal centro senza motivo. Si sblocca al primo tap.
    if (net.nodes.size <= 1) return;
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

  btn?.addEventListener("click", () => { openSheet(!sheetOpen); });
  done?.addEventListener("click", () => { openSheet(false); });

  lista?.addEventListener("click", e => {
    const riga = e.target.closest(".dna-sheet__row");
    if (!riga || !ctx) return;
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
