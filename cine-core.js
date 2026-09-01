// ─── cine-core.js ────────────────────────────────────────────────────────────
// Funzioni "di servizio": formattazioni, calcoli, normalizzazione dati TMDB.
// Non parlano né con Supabase né con TMDB direttamente: sono utility pure.

const IMG = "https://image.tmdb.org/t/p/w500";

const GENRE_MAP = {
  28: "Azione", 12: "Avventura", 16: "Animazione", 35: "Commedia",
  80: "Crime", 99: "Documentario", 18: "Drama", 10751: "Famiglia",
  14: "Fantasy", 36: "Storia", 27: "Horror", 10402: "Musica",
  9648: "Mistero", 10749: "Romance", 878: "Fantascienza", 10770: "TV Movie",
  53: "Thriller", 10752: "Guerra", 37: "Western", 10759: "Azione & Avventura",
  10762: "Bambini", 10763: "News", 10764: "Reality", 10765: "Sci-Fi & Fantasy",
  10766: "Soap", 10767: "Talk", 10768: "War & Politics"
};

export const GENRE_NAME_TO_ID = {
  "Azione": 28, "Avventura": 12, "Animazione": 16, "Commedia": 35,
  "Crime": 80, "Documentario": 99, "Drama": 18, "Dramma": 18,
  "Famiglia": 10751, "Fantasy": 14, "Storia": 36, "Horror": 27,
  "Musica": 10402, "Mistero": 9648, "Romance": 10749, "Fantascienza": 878,
  "Thriller": 53, "Guerra": 10752, "Western": 37,
  "Azione & Avventura": 10759, "Sci-Fi & Fantasy": 10765
};

export function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export function normalizeGenres(item) {
  if (Array.isArray(item.genre_ids)) return item.genre_ids.map(id => GENRE_MAP[id] || `Genere ${id}`);
  if (Array.isArray(item.genres)) return item.genres.map(g => (typeof g === "string" ? g : g.name)).filter(Boolean);
  if (Array.isArray(item.genre_names)) return item.genre_names;
  return [];
}

export function posterUrl(path) { return path ? `${IMG}${path}` : ""; }

export function yearOf(item) {
  const d = item.release_date || item.first_air_date || "";
  return d ? d.slice(0, 4) : (item.year || "—");
}

export function titleOf(item) { return item.title || item.name || "Titolo sconosciuto"; }

export function extractDirector(item) {
  if (item.director) return item.director;
  if (item.media_type === "movie" || item.release_date) {
    const crew = item.credits?.crew || [];
    const d = crew.find(p => p.job === "Director");
    if (d?.name) return d.name;
  }
  if (item.media_type === "tv" || item.first_air_date) {
    if (Array.isArray(item.created_by) && item.created_by[0]?.name) return item.created_by[0].name;
  }
  return "";
}

// Trasforma un risultato grezzo TMDB in un oggetto pulito e uniforme
export function normalizedItem(item) {
  return {
    id: item.id,
    media_type: (item.media_type === "tv" || item.first_air_date) ? "tv" : "movie",
    title: titleOf(item),
    year: yearOf(item),
    poster_path: item.poster_path || "",
    backdrop_path: item.backdrop_path || "",
    overview: item.overview
      ? (item.overview.length > 300 ? item.overview.slice(0, 300) + "..." : item.overview)
      : "",
    vote_average: item.vote_average || 0,
    vote_count: item.vote_count || 0,
    genre_names: normalizeGenres(item),
    director: extractDirector(item),
    release_date: item.release_date || "",
    first_air_date: item.first_air_date || ""
  };
}

export function uniqueKey(item) { return `${item.media_type}_${item.id}`; }
export function mediaLabel(item) { return item.media_type === "movie" ? "Film" : "Serie TV"; }
export function mediaBadgeClass(item) { return item.media_type === "movie" ? "badge-film" : "badge-series"; }

export function decadeOf(year) {
  if (!year || year === "—" || isNaN(Number(year))) return "Sconosciuta";
  return `${Math.floor(Number(year) / 10) * 10}s`;
}

export function rawNumberToFixed(value, digits = 1, fallback = "n.d.") {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n.toFixed(digits) : fallback;
}

export function buildDateRange(startYear, endYear, type) {
  if (!startYear || !endYear) return "";
  return type === "movie"
    ? `&primary_release_date.gte=${startYear}-01-01&primary_release_date.lte=${endYear}-12-31`
    : `&first_air_date.gte=${startYear}-01-01&first_air_date.lte=${endYear}-12-31`;
}

export function randomPage(max = 5) { return Math.floor(Math.random() * max) + 1; }

// Calcola la media di gruppo di un titolo a partire dal suo oggetto voti
// votesObj = { "Mattia": { vote: 8, comment: "..." }, "Luca": { vote: 6.5 } }
export function average(votesObj) {
  const vals = Object.values(votesObj || {})
    .map(v => Number(v.vote))
    .filter(Number.isFinite);
  if (!vals.length) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

export function voteCount(votesObj) {
  return Object.keys(votesObj || {}).length;
}

// Chi ha votato, da mostrare accanto al voto nelle shelf della Home (vedi
// ui.js::renderShelf) — { name: "Marco", others: 0 } se ha votato una
// persona sola, { name: "Marco", others: 2 } se ce ne sono altre (name e
// others separati, non già uniti in una stringa: con un nome lungo il
// troncamento CSS deve poter tagliare SOLO il nome, mai il "+N" — è
// l'unico segnale che dice "hanno votato in più persone"). Niente
// timestamp per voto in tabella "votes": l'ordine alfabetico è l'unico
// criterio deterministico disponibile (lo stesso titolo deve mostrare
// sempre lo stesso nome, non uno a caso a ogni render). null se nessuno ha
// ancora votato.
export function firstVoter(votesObj) {
  const names = Object.keys(votesObj || {}).sort((a, b) => a.localeCompare(b, "it"));
  if (!names.length) return null;
  return { name: names[0], others: names.length - 1 };
}

// ─── REPORT DI GRUPPO: metriche "di curiosità" ───────────────────────────────
// Metriche sugli stessi dati già caricati per la Home/Statistiche (nessuna
// nuova query): chi ha votato di più, la coppia coi gusti più simili, i
// titoli più divisivi. Pure, sola lettura, nessuna chiamata a Supabase qui
// dentro — prendono `db` (l'array già restituito da fetchLibrary(), ogni
// item con `.votes`) e basta.

export function votingLeaderboard(db) {
  const counts = new Map();
  for (const item of db) {
    for (const user of Object.keys(item.votes || {})) {
      counts.set(user, (counts.get(user) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([user, count]) => ({ user, count }))
    .sort((a, b) => b.count - a.count);
}

// Differenza media di voto tra ogni coppia di utenti, sui soli titoli
// votati da ENTRAMBI. Richiede almeno minShared titoli in comune —
// altrimenti il numero è rumore (2-3 titoli condivisi tra due persone non
// dice niente di vero), quindi quella coppia viene scartata dall'elenco.
// Condiviso da mostAffinePair (avgDiff minimo) e mostDivergentPair
// (massimo): stesso identico calcolo, cambia solo quale estremo si tiene.
function pairVoteDiffs(db, minShared) {
  const users = [...new Set(db.flatMap(item => Object.keys(item.votes || {})))];
  const pairs = [];
  for (let i = 0; i < users.length; i++) {
    for (let j = i + 1; j < users.length; j++) {
      const [a, b] = [users[i], users[j]];
      const diffs = [];
      for (const item of db) {
        const va = Number(item.votes?.[a]?.vote);
        const vb = Number(item.votes?.[b]?.vote);
        if (Number.isFinite(va) && Number.isFinite(vb)) diffs.push(Math.abs(va - vb));
      }
      if (diffs.length < minShared) continue;
      const avgDiff = diffs.reduce((x, y) => x + y, 0) / diffs.length;
      pairs.push({ a, b, avgDiff, sharedCount: diffs.length });
    }
  }
  return pairs;
}

// Coppia con i gusti più simili: avgDiff minimo. null se nessuna coppia
// raggiunge la soglia minShared.
export function mostAffinePair(db, { minShared = 5 } = {}) {
  return pairVoteDiffs(db, minShared).reduce(
    (best, p) => (!best || p.avgDiff < best.avgDiff ? p : best), null
  );
}

// La coppia che litiga di più: stesso calcolo, avgDiff massimo invece che
// minimo — il rovescio esatto di mostAffinePair.
export function mostDivergentPair(db, { minShared = 5 } = {}) {
  return pairVoteDiffs(db, minShared).reduce(
    (best, p) => (!best || p.avgDiff > best.avgDiff ? p : best), null
  );
}

// Deviazione standard dei voti ricevuti da ogni titolo — quanto in media
// un voto si allontana dalla media del titolo. Soglia minVotes DIVERSA (e
// più alta) di quella della Classifica, che accetta anche 1 solo voto: lì
// basta per un ranking, qui "quanto il gruppo è diviso/d'accordo" con 1-2
// voti non significa niente. Condivisa da mostDivisive (sd più alta) e
// mostUnanimous (sd più bassa, il suo esatto opposto).
function titlesBySd(db, minVotes) {
  return db
    .map(item => {
      const vals = Object.values(item.votes || {}).map(v => Number(v.vote)).filter(Number.isFinite);
      if (vals.length < minVotes) return null;
      const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
      const variance = vals.reduce((a, b) => a + (b - avg) ** 2, 0) / vals.length;
      return { id: item.id, title: item.title, year: item.year, avg, sd: Math.sqrt(variance), count: vals.length };
    })
    .filter(Boolean);
}

export function mostDivisive(db, { minVotes = 3, limit = 3 } = {}) {
  return titlesBySd(db, minVotes).sort((a, b) => b.sd - a.sd).slice(0, limit);
}

export function mostUnanimous(db, { minVotes = 3, limit = 3 } = {}) {
  return titlesBySd(db, minVotes).sort((a, b) => a.sd - b.sd).slice(0, limit);
}

// Un profilo per persona per il Report di Gruppo: quanto vota, quanto sono
// costanti o polarizzati i suoi voti (deviazione standard dei SUOI voti,
// stessa formula di titlesBySd ma applicata a una persona invece che a un
// titolo), il genere/regista che premia di più (solo se ne ha votati
// abbastanza, altrimenti è rumore) e i suoi voti più alti/più bassi.
// Pure funzione su db/users, nessuna dipendenza DOM — stesso stile delle
// altre funzioni di questo file.
export function groupMemberProfiles(db, users, { minVotes = 0 } = {}) {
  const profiles = users.map(user => {
    const voted = db
      .map(item => {
        const v = item.votes?.[user];
        const vote = Number(v?.vote);
        return Number.isFinite(vote) ? { item, vote } : null;
      })
      .filter(Boolean);

    const n = voted.length;
    const avg = n ? voted.reduce((a, b) => a + b.vote, 0) / n : 0;
    const variance = n ? voted.reduce((a, b) => a + (b.vote - avg) ** 2, 0) / n : 0;
    const sd = Math.sqrt(variance);

    const genreVotes = {};
    const directorVotes = {};
    voted.forEach(({ item, vote }) => {
      (item.genre_names || []).forEach(g => (genreVotes[g] ||= []).push(vote));
      if (item.director) (directorVotes[item.director] ||= []).push(vote);
    });

    const rankByAvg = (acc, minCount) => {
      const entries = Object.entries(acc)
        .filter(([, votes]) => votes.length >= minCount)
        .map(([name, votes]) => ({ name, avg: votes.reduce((a, b) => a + b, 0) / votes.length, count: votes.length }));
      entries.sort((a, b) => b.avg - a.avg);
      return entries;
    };
    const genreRanking = rankByAvg(genreVotes, 3);

    const sorted = [...voted].sort((a, b) => b.vote - a.vote);
    const topFilms = sorted.slice(0, 3).map(({ item, vote }) => ({ title: item.title, vote }));
    const bottomFilms = sorted.slice(-3).reverse().map(({ item, vote }) => ({ title: item.title, vote }));

    return {
      user, n, avg, sd,
      topGenre: genreRanking[0] || null,
      // Fino a 3 generi per il mini-grafico "Generi preferiti" della card
      // (renderGroupReport in ui.js) — stessa soglia minima di 3 voti sul
      // genere di topGenre, solo non troncata a un solo risultato.
      topGenres: genreRanking.slice(0, 3),
      topDirector: rankByAvg(directorVotes, 2)[0] || null,
      topFilms, bottomFilms,
      label: null,
    };
  }).sort((a, b) => b.n - a.n);

  // "il più costante"/"il più polarizzato" vanno assegnati una sola volta
  // ciascuno, solo a chi ha davvero il minimo/massimo di deviazione standard
  // — mai a più persone insieme, altrimenti si contraddicono a vicenda.
  // Richiede almeno 3 voti per essere un dato significativo (1-2 voti
  // identici farebbero sembrare "costantissimo" chi ha semplicemente
  // votato poco).
  const eligible = profiles.filter(m => m.n >= 3);
  if (eligible.length >= 2) {
    const steadiest = eligible.reduce((a, b) => (b.sd < a.sd ? b : a));
    const mostPolarized = eligible.reduce((a, b) => (b.sd > a.sd ? b : a));
    if (steadiest !== mostPolarized) {
      steadiest.label = "costante";
      mostPolarized.label = "polarizzato";
    }
  }

  // Applicato DOPO l'assegnazione delle etichette sopra (che devono girare
  // sulla lista completa, non su quella già tagliata) — chi non raggiunge
  // minVotes non ha abbastanza dati per un profilo vero, sparisce dal
  // risultato invece di mostrare una card striminzita o vuota.
  return profiles.filter(m => m.n >= minVotes);
}

// Prosa di apertura del Report di Gruppo: quali titoli ha visto tutto il
// gruppo insieme (con quello più amato segnalato a parte), chi è il
// curatore della collezione (chi ha aggiunto più titoli) e chi vota poco
// ma premia parecchio. Pure funzione su db/users — nessuna chiamata a
// Claude: sono frasi templata con numeri reali, non testo generato a
// runtime (per questo il Report di Gruppo non ha il badge "scritto da
// Claude" a differenza del report personale).
export function groupProfileStats(db, users) {
  const allVotes = [];
  db.forEach(item => Object.values(item.votes || {}).forEach(v => {
    const n = Number(v.vote);
    if (Number.isFinite(n)) allVotes.push(n);
  }));
  const avg = allVotes.length ? allVotes.reduce((a, b) => a + b, 0) / allVotes.length : 0;

  const allVotedTitles = users.length
    ? db
        .filter(item => users.every(u => item.votes && item.votes[u]))
        .map(item => ({ title: item.title, avg: average(item.votes) }))
    : [];

  let curatorNote = "";
  if (allVotedTitles.length) {
    const bestIdx = allVotedTitles.reduce(
      (best, t, i) => (t.avg > allVotedTitles[best].avg ? i : best), 0
    );
    const parts = allVotedTitles.map((t, i) => {
      const highlight = i === bestIdx && allVotedTitles.length > 1
        ? ", il più amato tra quelli visti davvero insieme" : "";
      return `<b>${escapeHtml(t.title)}</b> (media ${t.avg.toFixed(1).replace(".", ",")}${highlight})`;
    });
    const list = parts.length > 1
      ? `${parts.slice(0, -1).join(", ")} e ${parts[parts.length - 1]}`
      : parts[0];
    const verb = allVotedTitles.length === 1 ? "è stato votato" : "sono stati votati";
    curatorNote = `Su ${db.length} titoli catalogati, solo <b>${allVotedTitles.length}</b> ${verb} da tutti e ${users.length}: ${list}. Il gruppo guarda insieme meno spesso di quanto sembri — ognuno porta avanti anche visioni proprie.`;
  }

  const addedCount = {};
  db.forEach(item => { if (item.added_by) addedCount[item.added_by] = (addedCount[item.added_by] || 0) + 1; });
  const topAdder = Object.entries(addedCount).sort((a, b) => b[1] - a[1])[0];

  const votesByUser = {};
  db.forEach(item => Object.entries(item.votes || {}).forEach(([u, v]) => {
    const n = Number(v.vote);
    if (Number.isFinite(n)) (votesByUser[u] ||= []).push(n);
  }));
  const memberAvgs = Object.entries(votesByUser)
    .map(([user, votes]) => ({ user, n: votes.length, avg: votes.reduce((a, b) => a + b, 0) / votes.length }))
    .sort((a, b) => b.avg - a.avg);
  const mostGenerous = memberAvgs[0] || null;

  let contributionNote = "";
  if (topAdder) {
    const [topAdderUser, topAdderCount] = topAdder;
    const pct = Math.round((topAdderCount / db.length) * 100);
    const topAdderVotes = (votesByUser[topAdderUser] || []).length;
    contributionNote = `<b>${escapeHtml(topAdderUser)}</b> è il motore assoluto: ha aggiunto ${topAdderCount} dei ${db.length} titoli (${pct}%) ed espresso ${topAdderVotes} dei ${allVotes.length} voti — è il curatore della collezione.`;
    if (mostGenerous && mostGenerous.user !== topAdderUser) {
      contributionNote += ` <b>${escapeHtml(mostGenerous.user)}</b> è all'opposto: vota poco (${mostGenerous.n} volte) ma quando lo fa premia quasi sempre, con la media più alta e generosa del gruppo (${mostGenerous.avg.toFixed(2).replace(".", ",")}).`;
    }
  }

  return {
    userCount: users.length,
    voteCount: allVotes.length,
    avg,
    allVotedCount: allVotedTitles.length,
    curatorNote,
    contributionNote,
  };
}
