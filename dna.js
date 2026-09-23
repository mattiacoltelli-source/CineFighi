// ─── dna.js ──────────────────────────────────────────────────────────────────
// Il "DNA del gruppo": costruisce la rete che collega persone, film e generi
// partendo dalla libreria già in memoria (`db`, vedi storage.js::fetchLibrary).
//
// Questo file non tocca il DOM e non fa NESSUNA chiamata di rete: riceve la
// libreria, restituisce nodi e archi. Il disegno è in dna-view.js.
//
// Due scelte di fondo, decise guardando i dati veri del gruppo:
//
//  1. Non esiste un arco diretto Persona→Persona. Tutte e 21 le coppie di
//     utenti hanno almeno un film in comune: un arco sempre presente non
//     direbbe nulla. Due persone si incontrano solo ATTRAVERSO un film o un
//     genere — è quello il collegamento che porta informazione.
//
//  2. Niente casualità. Stesso tap, stessa rete: l'ordine dei vicini è
//     completamente deterministico (vedi pickNeighbours), così l'esplorazione
//     è riproducibile e i test non diventano instabili.

// Soglia "questo film mi è piaciuto". NON è una soglia nuova: è la stessa già
// usata dall'app (vedi il vecchio blocco Stasera e le statistiche).
export const LIKE_THRESHOLD = 7;

// TMDB usa tassonomie diverse per film e serie: la stessa cosa arriva con due
// nomi a seconda del media_type. Senza questa mappa la rete mostrerebbe
// "Fantascienza" e "Sci-Fi & Fantasy" come due generi scollegati.
export const GENRE_ALIASES = {
  "sci-fi & fantasy": "Fantascienza",
  "action & adventure": "Azione",
  "war & politics": "Guerra"
};

// "televisione film" (TMDB: "TV Movie") non è un genere, è un formato:
// non dice niente sui gusti di nessuno.
export const GENRE_IGNORED = new Set(["televisione film"]);

export function normalizeGenres(names) {
  const out = [];
  for (const raw of names || []) {
    const clean = String(raw || "").trim();
    if (!clean) continue;
    const key = clean.toLowerCase();
    if (GENRE_IGNORED.has(key)) continue;
    const name = GENRE_ALIASES[key] || clean;
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

// ─── ID DEI NODI ─────────────────────────────────────────────────────────────
// Tipizzati e stabili: sono anche la chiave con cui un nodo già presente nella
// rete viene riusato invece che duplicato (è così che nascono i "ponti").

export const personId = (name) => `persona:${name}`;
export const filmId = (id) => `film:${id}`;
export const genreId = (name) => `genere:${name}`;
export const directorId = (name) => `regista:${name}`;

export function nodeType(id) {
  const i = id.indexOf(":");
  return i === -1 ? "" : id.slice(0, i);
}

// ─── INDICE ──────────────────────────────────────────────────────────────────
// Una passata sola sulla libreria, poi tutto è lookup O(1). Con ~570 titoli
// costa nulla, e va rifatta solo quando cambiano i voti.

// Con esattamente 2 o 3 persone nell'indice, "quanti dei selezionati amano
// questa cosa" è di per sé l'informazione interessante — il punto della
// modalità condivisa (vedi la sezione "CANDIDATI CONDIVISI" più sotto). Con
// il gruppo intero o con una persona sola quel numero non direbbe niente
// (con 7 persone quasi tutto è amato "da qualcuno"), quindi resta un modo
// di ordinare, non un concetto nuovo nella rete: si accende da solo quando
// la selezione ha la taglia giusta, senza toccare gli altri casi.
function isModalitaCondivisa(users) {
  return !!(users && (users.length === 2 || users.length === 3));
}

export function buildIndex(db, users = null) {
  const known = users && users.length ? new Set(users) : null;
  const condivisa = isModalitaCondivisa(users);

  const films = new Map();       // filmId -> { id, key, title, year, poster_path, media_type, director, genres, fans }
  const byPerson = new Map();    // nome    -> [{ id, w }]  film amati, con il voto come peso
  const byGenre = new Map();     // genere  -> [{ id, w }]  film del genere, con il n. di fan come peso
  const genrePop = new Map();    // genere  -> quanti film amati da almeno uno
  const byDirector = new Map();  // regista -> [{ id, w }]  suoi film amati
  // Chi, fra le persone nell'indice, ama almeno un film di quel genere/
  // regista — popolate solo per calcolare "quanti dei selezionati" in
  // modalità condivisa (vedi sharedCountOf). Per un film basta fans.length,
  // già disponibile: non serve una mappa a parte.
  const genreFans = new Map();   // genere  -> Set(nome)
  const directorFans = new Map(); // regista -> Set(nome)

  for (const t of db || []) {
    const genres = normalizeGenres(t.genre_names);

    // I fan sono ordinati per nome: serve a rendere deterministico ogni
    // successivo ordinamento a parità di peso.
    const fans = Object.entries(t.votes || {})
      .filter(([name, v]) => Number(v?.vote) >= LIKE_THRESHOLD && (!known || known.has(name)))
      .map(([name, v]) => ({ name, vote: Number(v.vote) }))
      .sort((a, b) => a.name.localeCompare(b.name));

    // Un titolo che non è piaciuto a nessuno non entra nella rete: la rete
    // mostra ciò che è stato amato, non il catalogo. Sono ~1/3 dei titoli,
    // ed è il motivo della nota in fondo alla schermata.
    if (!fans.length) continue;

    const key = filmId(t.id);
    films.set(key, {
      id: String(t.id),
      key,
      title: t.title,
      year: t.year,
      poster_path: t.poster_path,
      media_type: t.media_type,
      director: t.director || "",
      genres,
      fans
    });

    for (const f of fans) {
      if (!byPerson.has(f.name)) byPerson.set(f.name, []);
      byPerson.get(f.name).push({ id: key, w: f.vote });
    }
    for (const g of genres) {
      if (!byGenre.has(g)) byGenre.set(g, []);
      byGenre.get(g).push({ id: key, w: fans.length });
      genrePop.set(g, (genrePop.get(g) || 0) + 1);
      if (condivisa) {
        if (!genreFans.has(g)) genreFans.set(g, new Set());
        for (const f of fans) genreFans.get(g).add(f.name);
      }
    }
    if (t.director) {
      if (!byDirector.has(t.director)) byDirector.set(t.director, []);
      byDirector.get(t.director).push({ id: key, w: fans.length });
      if (condivisa) {
        if (!directorFans.has(t.director)) directorFans.set(t.director, new Set());
        for (const f of fans) directorFans.get(t.director).add(f.name);
      }
    }
  }

  const index = {
    films, byPerson, byGenre, genrePop, byDirector, genreFans, directorFans,
    directors: new Map(), personDirectors: new Map(), shared: condivisa
  };
  // Solo i registi che superano la soglia diventano nodi: uno con un film solo
  // sarebbe un vicolo cieco, non un pezzo di DNA del gruppo.
  for (const d of directorScores(index)) index.directors.set(d.name, d);

  // I registi di ciascuna persona. Senza questo collegamento i registi
  // sarebbero quasi invisibili: solo 1 film amato su 4 e' di un regista
  // sopra soglia, quindi aprendo un film spesso non ne comparirebbe nessuno.
  //
  // In modalità condivisa la soglia scende a 1: con solo 2-3 persone nel
  // conteggio, pretendere 2 film dello STESSO regista da ciascuno è tanto —
  // verificato sui dati veri, con soglia 2 quasi tutte le 21 coppie del
  // gruppo avevano comunque un regista in comune, ma abbassarla a 1 fa
  // emergere il segnale ovunque invece che a fatica. Non è un secondo
  // algoritmo: è lo stesso filtro, con un numero diverso a seconda di quante
  // persone si stanno guardando — la soglia normale (2) resta intatta per
  // Tutti / 1 persona / 4 o più.
  const sogliaRegista = condivisa ? DIRECTOR_MIN_PER_PERSON_SHARED : DIRECTOR_MIN_PER_PERSON;
  for (const [name, entries] of byPerson) {
    const tally = new Map();
    for (const e of entries) {
      const dir = films.get(e.id)?.director;
      if (dir && index.directors.has(dir)) tally.set(dir, (tally.get(dir) || 0) + 1);
    }
    const suoi = [...tally.entries()]
      .filter(([, n]) => n >= sogliaRegista)
      .map(([dir, n]) => ({ id: directorId(dir), n }))
      .sort((a, b) => b.n - a.n || a.id.localeCompare(b.id));
    if (suoi.length) index.personDirectors.set(name, suoi);
  }
  return index;
}

// ─── VICINI DI UN NODO ───────────────────────────────────────────────────────
// Tutti i vicini possibili (non ancora filtrati per quelli già collegati).

export function neighboursOf(index, id) {
  const type = nodeType(id);
  const key = id.slice(type.length + 1);

  if (type === "persona") {
    return [
      ...(index.byPerson.get(key) || []).map(e => ({ id: e.id, kind: "ama", w: e.w })),
      // Peso su scala piu' alta dei voti (7-10) di proposito: tra i candidati
      // di una persona, "tre film dello stesso regista" e' un segnale piu'
      // forte di "un film votato 9".
      ...(index.personDirectors.get(key) || []).map(d => ({ id: d.id, kind: "diretto", w: 10 + d.n * 10 }))
    ];
  }

  if (type === "film") {
    const film = index.films.get(id);
    if (!film) return [];
    return [
      ...film.fans.map(f => ({ id: personId(f.name), kind: "ama", w: f.vote })),
      // Peso di un genere = quanto è diffuso tra i film amati dal gruppo.
      // A parità di tutto il resto si espande prima il genere più
      // rappresentativo, non il primo che TMDB ha messo in lista.
      ...film.genres.map(g => ({ id: genreId(g), kind: "appartiene", w: index.genrePop.get(g) || 0 })),
      // Il regista compare solo se ha abbastanza film amati dal gruppo da
      // essere un segnale (vedi DIRECTOR_MIN_FILMS): il peso è il suo
      // punteggio, così tra i candidati si piazza tra le persone e i generi.
      ...(index.directors.has(film.director)
        ? [{ id: directorId(film.director), kind: "diretto", w: Math.round(index.directors.get(film.director).score * 10) }]
        : [])
    ];
  }

  if (type === "regista") {
    return (index.byDirector.get(key) || []).map(e => ({ id: e.id, kind: "diretto", w: e.w }));
  }

  if (type === "genere") {
    return (index.byGenre.get(key) || []).map(e => ({ id: e.id, kind: "appartiene", w: e.w }));
  }

  return [];
}

// ─── RETE ────────────────────────────────────────────────────────────────────

export function createNetwork(index, rootUser) {
  const net = {
    rootId: personId(rootUser),
    nodes: new Map(),
    edges: [],
    linked: new Set()   // "a|b" ordinato: evita archi doppi
  };
  addNode(net, index, net.rootId, null);
  return net;
}

function labelFor(index, id) {
  const type = nodeType(id);
  const key = id.slice(type.length + 1);
  if (type === "film") return index.films.get(id)?.title || key;
  return key;
}

function metaFor(index, id) {
  const type = nodeType(id);
  const key = id.slice(type.length + 1);
  if (type === "film") {
    const f = index.films.get(id);
    if (!f) return {};
    return {
      id: f.id, year: f.year, poster_path: f.poster_path, media_type: f.media_type,
      director: f.director, genres: f.genres, fans: f.fans
    };
  }
  if (type === "genere") return { count: index.genrePop.get(key) || 0, topFans: topFansOfGenre(index, key) };
  if (type === "persona") return {
    liked: (index.byPerson.get(key) || []).length,
    topGenres: topGenresOfPerson(index, key),
    topDirectors: (index.personDirectors.get(key) || []).slice(0, 3).map(d => ({ name: d.id.slice(8), film: d.n }))
  };
  if (type === "regista") {
    const d = index.directors.get(key);
    const films = (index.byDirector.get(key) || [])
      .map(e => index.films.get(e.id))
      .filter(Boolean)
      .sort((a, b) => b.fans.length - a.fans.length || a.title.localeCompare(b.title));
    return d ? { films: d.films, people: d.people, score: d.score, titoli: films.slice(0, 3).map(f => f.title) } : {};
  }
  return {};
}

// I 3 generi piu' presenti tra i film che una persona ha amato.
export function topGenresOfPerson(index, name) {
  const tally = new Map();
  for (const e of index.byPerson.get(name) || []) {
    for (const g of index.films.get(e.id)?.genres || []) tally.set(g, (tally.get(g) || 0) + 1);
  }
  return [...tally.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 3)
    .map(([g, n]) => ({ genere: g, film: n }));
}

// Chi, nel gruppo, ha amato piu' titoli di un certo genere.
export function topFansOfGenre(index, genere) {
  const tally = new Map();
  for (const e of index.byGenre.get(genere) || []) {
    for (const f of index.films.get(e.id)?.fans || []) tally.set(f.name, (tally.get(f.name) || 0) + 1);
  }
  return [...tally.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 3)
    .map(([name, n]) => ({ name, film: n }));
}

function addNode(net, index, id, parentId) {
  if (net.nodes.has(id)) return net.nodes.get(id);
  const node = {
    id,
    type: nodeType(id),
    label: labelFor(index, id),
    meta: metaFor(index, id),
    parent: parentId,
    expanded: false,
    x: null,
    y: null
  };
  net.nodes.set(id, node);
  return node;
}

const edgeKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);

function addEdge(net, a, b, kind, w) {
  const k = edgeKey(a, b);
  if (net.linked.has(k)) return null;
  net.linked.add(k);
  const edge = { a, b, kind, w };
  net.edges.push(edge);
  return edge;
}

export function degree(net, id) {
  let n = 0;
  for (const e of net.edges) if (e.a === id || e.b === id) n++;
  return n;
}

// ─── SCELTA DEI VICINI DA MOSTRARE ───────────────────────────────────────────
//
// L'ordine è la parte che decide se la rete racconta qualcosa o se cresce
// come un albero piatto. In ordine di priorità:
//
//   1. PONTE — il candidato è già nella rete (2 punti), oppure è nuovo ma ha
//      almeno un altro vicino già nella rete (1 punto). Aprirlo chiude un
//      anello: è esattamente ciò che si vuole vedere.
//   2. CONDIVISIONE (solo in modalità condivisa, vedi sotto) — fra due
//      candidati con lo stesso livello di ponte, va prima quello amato da
//      più delle persone che si stanno guardando. Fuori da questa modalità
//      vale sempre 0 per tutti: non cambia niente.
//   3. VARIETÀ DI TIPO — a parità delle prime due, si alterna il tipo, così
//      un film non mostra cinque persone di fila prima di un genere.
//   4. PESO — voto più alto / genere più diffuso.
//   5. ID — tie-break finale, deterministico.

function bridgeScore(net, index, sourceId, candId) {
  if (net.nodes.has(candId)) return 2;
  for (const n of neighboursOf(index, candId)) {
    if (n.id !== sourceId && net.nodes.has(n.id)) return 1;
  }
  return 0;
}

// ─── CANDIDATI CONDIVISI (2-3 persone selezionate) ───────────────────────────
//
// Quante delle persone nell'indice amano questa cosa. Con "Tutti" o con una
// persona sola il numero non direbbe niente (quasi tutto è amato "da
// qualcuno" su un gruppo di 7) — per questo conta solo quando
// index.shared è vero, cioè quando buildIndex è stato costruito su
// esattamente 2 o 3 persone (vedi isModalitaCondivisa).
//
// Un film lo sa già da solo (fans è già filtrato alle sole persone
// nell'indice): non serve una mappa a parte. Genere e regista usano le
// mappe costruite in buildIndex proprio per questo.
export function sharedCountOf(index, id) {
  const type = nodeType(id);
  const key = id.slice(type.length + 1);
  if (type === "film") return index.films.get(id)?.fans.length || 0;
  if (type === "genere") return index.genreFans?.get(key)?.size || 0;
  if (type === "regista") return index.directorFans?.get(key)?.size || 0;
  return 0;
}

export function pickNeighbours(net, index, sourceId, limit = 5) {
  const cands = neighboursOf(index, sourceId)
    .filter(n => !net.linked.has(edgeKey(sourceId, n.id)))
    .map(n => ({
      ...n,
      bridge: bridgeScore(net, index, sourceId, n.id),
      shared: index.shared ? sharedCountOf(index, n.id) : 0,
      type: nodeType(n.id)
    }))
    .sort((a, b) => b.bridge - a.bridge || b.shared - a.shared || b.w - a.w || a.id.localeCompare(b.id));

  const picked = [];
  const perType = new Map();
  const pool = [...cands];

  while (picked.length < limit && pool.length) {
    // Non si scende mai di livello di ponte per amore della varietà:
    // il ponte viene prima, sempre.
    const topBridge = pool[0].bridge;
    const tier = pool.filter(c => c.bridge === topBridge);
    const minSeen = Math.min(...tier.map(c => perType.get(c.type) || 0));
    const chosen = tier.find(c => (perType.get(c.type) || 0) === minSeen);
    picked.push(chosen);
    perType.set(chosen.type, (perType.get(chosen.type) || 0) + 1);
    pool.splice(pool.indexOf(chosen), 1);
  }

  return picked;
}

// Apre un nodo: aggiunge fino a `limit` vicini e i relativi archi.
// Ritorna gli id dei nodi NUOVI (quelli già presenti hanno solo un arco in più).
export function expand(net, index, id, limit = 5) {
  const source = net.nodes.get(id);
  if (!source) return [];
  source.expanded = true;

  const added = [];
  for (const cand of pickNeighbours(net, index, id, limit)) {
    const isNew = !net.nodes.has(cand.id);
    addNode(net, index, cand.id, id);
    addEdge(net, id, cand.id, cand.kind, cand.w);
    if (isNew) added.push(cand.id);
  }
  return added;
}

// Richiude un nodo. Spariscono solo i nodi che esistevano SOLO grazie a lui:
// un nodo con altri collegamenti vivi (un ponte) o aperto a mano dall'utente
// resta dov'è. La rimozione è a cascata, così si richiude anche un ramo
// profondo in un colpo solo.
export function collapse(net, id) {
  const node = net.nodes.get(id);
  if (!node) return [];
  node.expanded = false;

  const removed = [];
  let changed = true;
  while (changed) {
    changed = false;
    for (const n of [...net.nodes.values()]) {
      if (n.id === net.rootId || n.expanded) continue;
      if (!n.parent || !net.nodes.has(n.parent)) continue;
      if (net.nodes.get(n.parent).expanded) continue;
      if (degree(net, n.id) > 1) continue;   // è un ponte: resta
      net.nodes.delete(n.id);
      for (let i = net.edges.length - 1; i >= 0; i--) {
        const e = net.edges[i];
        if (e.a === n.id || e.b === n.id) {
          net.linked.delete(edgeKey(e.a, e.b));
          net.edges.splice(i, 1);
        }
      }
      removed.push(n.id);
      changed = true;
    }
  }
  return removed;
}

// Distanza in salti da un nodo, su tutta la rete. Serve al renderer per
// decidere chi disegnare e chi etichettare (vedi il budget DOM in dna-view).
export function hopsFrom(net, startId) {
  const hops = new Map([[startId, 0]]);
  const adj = new Map();
  for (const e of net.edges) {
    if (!adj.has(e.a)) adj.set(e.a, []);
    if (!adj.has(e.b)) adj.set(e.b, []);
    adj.get(e.a).push(e.b);
    adj.get(e.b).push(e.a);
  }
  const queue = [startId];
  while (queue.length) {
    const cur = queue.shift();
    for (const next of adj.get(cur) || []) {
      if (hops.has(next)) continue;
      hops.set(next, hops.get(cur) + 1);
      queue.push(next);
    }
  }
  return hops;
}

// ─── REGISTI ─────────────────────────────────────────────────────────────────
// Sostituisce belovedDirectors() del vecchio blocco Stasera, che ordinava i
// registi per media semplice + un bonus fisso e poi mescolava a caso.
//
// Qui la media è "ritirata" verso la media del gruppo in proporzione a quanti
// film abbiamo di quel regista (shrinkage bayesiano): un regista con un solo
// 10 non scavalca più chi ne ha sei da 8. Più il bonus per quante persone
// diverse lo hanno amato — che è l'informazione interessante in un gruppo.
//
//   score = (voti × media + K × MEDIA_GRUPPO) / (voti + K) + 0.10 × (persone − 1)
//
// Nota: l'indice contiene solo i film amati da almeno una persona, quindi la
// soglia qui sotto è "almeno 3 film AMATI", non "3 film in catalogo" — più
// stretta di quella dell'analisi, e più adatta a una rete che per definizione
// mostra solo ciò che è piaciuto.
//
// Non è ancora usata dalla schermata: i nodi Regista arrivano in fase 2.
export const DIRECTOR_MIN_FILMS = 3;
// Un film solo non dice niente sui gusti: un regista compare tra i TUOI
// quando ne hai amati almeno due.
export const DIRECTOR_MIN_PER_PERSON = 2;
// Variante usata solo in modalità condivisa (buildIndex, 2-3 persone
// selezionate): con un conteggio così piccolo un film solo di un regista
// è già un indizio, vedi il commento in buildIndex.
export const DIRECTOR_MIN_PER_PERSON_SHARED = 1;
const DIRECTOR_PRIOR_WEIGHT = 5;
const DIRECTOR_PRIOR_MEAN = 6.84;   // media di tutti i voti del gruppo

export function directorScores(index) {
  const byDirector = new Map();
  for (const film of index.films.values()) {
    if (!film.director) continue;
    if (!byDirector.has(film.director)) byDirector.set(film.director, { films: [], votes: [], people: new Set() });
    const d = byDirector.get(film.director);
    d.films.push(film.key);
    for (const f of film.fans) { d.votes.push(f.vote); d.people.add(f.name); }
  }

  return [...byDirector.entries()]
    .filter(([, d]) => d.films.length >= DIRECTOR_MIN_FILMS)
    .map(([name, d]) => {
      const sum = d.votes.reduce((a, b) => a + b, 0);
      const shrunk = (sum + DIRECTOR_PRIOR_WEIGHT * DIRECTOR_PRIOR_MEAN) / (d.votes.length + DIRECTOR_PRIOR_WEIGHT);
      return { name, films: d.films.length, people: d.people.size, score: shrunk + 0.10 * (d.people.size - 1) };
    })
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}
