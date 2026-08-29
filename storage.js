// ─── storage.js ──────────────────────────────────────────────────────────────
// Ogni funzione che legge o scrive dati "veri" (utenti, titoli, voti) passa
// da qui. Il resto dell'app non parla mai direttamente con Supabase.

import { supabase } from "./supabase.js?v=9f88b14";

const CURRENT_USER_KEY = "cinefighiCurrentUser";
export const MAX_USERS = 15;

// ─── UTENTE CORRENTE (solo sul dispositivo, per comodità) ────────────────────

export function getCurrentUser() {
  try { return localStorage.getItem(CURRENT_USER_KEY) || null; } catch { return null; }
}
export function setCurrentUser(name) {
  try { localStorage.setItem(CURRENT_USER_KEY, name); } catch {}
}
export function clearCurrentUser() {
  try { localStorage.removeItem(CURRENT_USER_KEY); } catch {}
}

// ─── "VISTO L'ULTIMA VOLTA" (solo sul dispositivo) ───────────────────────────
// Usato solo per marcare in modo discreto i titoli aggiunti da qualcun altro
// da quando questo dispositivo ha aperto l'app l'ultima volta. Per
// dispositivo e non per persona (come currentUser sopra): non esiste un vero
// login, quindi non avrebbe senso legarlo a un utente specifico.
const LAST_SEEN_KEY = "cinefighiLastSeenAt";
export function getLastSeenAt() {
  try { return localStorage.getItem(LAST_SEEN_KEY) || null; } catch { return null; }
}
export function setLastSeenAt(iso) {
  try { localStorage.setItem(LAST_SEEN_KEY, iso); } catch {}
}

// ─── UTENTI DEL GRUPPO (su Supabase, condivisi da tutti) ─────────────────────

export async function fetchUsers() {
  const { data, error } = await supabase
    .from("users")
    .select("name")
    .order("created_at", { ascending: true });
  // FIX: prima ritornava [] anche in caso di errore di rete/Supabase, e
  // l'app interpretava "lista vuota per errore" come "nessun utente":
  // le liste si svuotavano silenziosamente. Ora propaghiamo l'errore e
  // lasciamo decidere al chiamante come gestirlo (es. non toccare lo
  // stato precedente invece di sostituirlo con un array vuoto).
  if (error) { console.error("fetchUsers:", error); throw error; }
  return data.map(u => u.name);
}

// Ritorna { ok, reason?, existing?, name? }
export async function addUser(rawName) {
  const clean = String(rawName || "").trim();
  if (!clean) return { ok: false, reason: "empty" };
  if (clean.length > 24) return { ok: false, reason: "too_long" };

  let existing;
  try {
    existing = await fetchUsers();
  } catch (e) {
    return { ok: false, reason: "error" };
  }
  const match = existing.find(u => u.toLowerCase() === clean.toLowerCase());
  if (match) return { ok: true, existing: true, name: match };

  if (existing.length >= MAX_USERS) return { ok: false, reason: "full" };

  const { error } = await supabase.from("users").insert({ name: clean });
  if (error) { console.error("addUser:", error); return { ok: false, reason: "error" }; }
  return { ok: true, existing: false, name: clean };
}

// Elimina un utente dal gruppo. I suoi voti già dati restano (scelta voluta:
// la media di gruppo resta corretta, semplicemente non può più votare finché
// non si aggiunge di nuovo).
export async function deleteUser(name) {
  const { error } = await supabase.from("users").delete().eq("name", name);
  if (error) { console.error("deleteUser:", error); return { ok: false }; }
  return { ok: true };
}
// ─── LIBRERIA (titoli + voti, uniti in un unico oggetto comodo da usare) ─────
// Ogni titolo torna con: { ...campi, votes: { "Mattia": { vote, comment }, ... } }

export async function fetchLibrary() {
  const [
    { data: titles, error: e1 },
    { data: votes, error: e2 }
  ] = await Promise.all([
    supabase.from("titles").select("*").order("created_at", { ascending: false }),
    supabase.from("votes").select("*")
  ]);

  // FIX: come fetchUsers, non ritorniamo piu' [] su errore (svuotava
  // silenziosamente la libreria mostrata a tutti). Il chiamante decide
  // se mantenere i dati precedenti mostrando un avviso.
  if (e1) { console.error("fetchLibrary/titles:", e1); throw e1; }
  if (e2) { console.error("fetchLibrary/votes:", e2); throw e2; }

  const votesByTitle = {};
  (votes || []).forEach(v => {
    if (!votesByTitle[v.title_id]) votesByTitle[v.title_id] = {};
    votesByTitle[v.title_id][v.user_name] = { vote: Number(v.vote), comment: v.comment || "" };
  });

  return (titles || []).map(t => ({
    id: t.id,
    tmdb_id: t.tmdb_id,
    media_type: t.media_type,
    title: t.title,
    year: t.year,
    poster_path: t.poster_path,
    backdrop_path: t.backdrop_path,
    overview: t.overview,
    genre_names: t.genre_names || [],
    director: t.director,
    status: t.status,          // 'watchlist' | 'seen'
    added_by: t.added_by,
    created_at: t.created_at,
    votes: votesByTitle[t.id] || {}
  }));
}

export async function addTitle(item, status, addedBy) {
  const { data, error } = await supabase
    .from("titles")
    .insert({
      tmdb_id: item.id,
      media_type: item.media_type,
      title: item.title,
      year: item.year,
      poster_path: item.poster_path,
      backdrop_path: item.backdrop_path || "",
      overview: item.overview || "",
      genre_names: item.genre_names || [],
      director: item.director || "",
      status,
      added_by: addedBy
    })
    .select()
    .single();

  if (error) {
    // Se il titolo esiste già (vincolo unique tmdb_id+media_type), lo segnaliamo
    if (error.code === "23505") return { ok: false, reason: "duplicate" };
    console.error("addTitle:", error);
    return { ok: false, reason: "error" };
  }
  return { ok: true, title: data };
}

export async function updateTitleStatus(titleId, status) {
  const { error } = await supabase.from("titles").update({ status }).eq("id", titleId);
  if (error) { console.error("updateTitleStatus:", error); return { ok: false }; }
  return { ok: true };
}

export async function removeTitle(titleId) {
  const { error } = await supabase.from("titles").delete().eq("id", titleId);
  if (error) { console.error("removeTitle:", error); return { ok: false }; }
  return { ok: true };
}

// ─── VOTI (uno per persona per titolo) ────────────────────────────────────────

export async function upsertVote(titleId, userName, vote, comment) {
  const { error } = await supabase
    .from("votes")
    .upsert(
      { title_id: titleId, user_name: userName, vote, comment: comment || null },
      { onConflict: "title_id,user_name" }
    );
  if (error) { console.error("upsertVote:", error); return { ok: false }; }
  return { ok: true };
}

export async function removeVote(titleId, userName) {
  const { error } = await supabase
    .from("votes")
    .delete()
    .eq("title_id", titleId)
    .eq("user_name", userName);
  if (error) { console.error("removeVote:", error); return { ok: false }; }
  return { ok: true };
}



// ─── REPORT (profilo + consigli generati da Claude, una volta all'anno per utente) ──
// Sola lettura dal client: la riga viene scritta solo dalla Edge Function
// "generate-report" (chiave service_role, mai esposta qui). Il client legge
// l'ultimo report di QUESTO utente e può richiederne la generazione tramite
// la stessa funzione, invocata con la chiave pubblica già usata per il resto.
// Cache locale per utente (più persone possono usare lo stesso dispositivo).

function reportCacheKey(userName) {
  return `cinefighiReportCache_${userName}`;
}

function saveLocalReportCache(userName, report) {
  try {
    if (report) localStorage.setItem(reportCacheKey(userName), JSON.stringify(report));
  } catch (e) {
    console.warn("Cache locale report non salvata:", e);
  }
}

function loadLocalReportCache(userName) {
  try {
    const raw = localStorage.getItem(reportCacheKey(userName));
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

export async function loadLatestReport(userName, onUpdate) {
  const localCache = loadLocalReportCache(userName);

  // Sincronizzazione da Supabase in background
  const fetchTask = (async () => {
    try {
      const res = await supabase
        .from("user_report")
        .select("generated_at, payload")
        .eq("user_name", userName)
        .order("generated_at", { ascending: false })
        .limit(1);

      if (!res || res.error || !res.data?.length) return null;
      const remoteReport = res.data[0];

      saveLocalReportCache(userName, remoteReport);

      if (onUpdate && JSON.stringify(remoteReport) !== JSON.stringify(localCache)) {
        onUpdate(remoteReport);
      }
      return remoteReport;
    } catch (e) {
      console.warn("Lettura report remota fallita:", e);
      return null;
    }
  })();

  if (localCache) {
    return localCache;
  }

  return await fetchTask;
}

export async function regenerateReport(userName) {
  const { data, error } = await supabase.functions.invoke("generate-report", { body: { user_name: userName } });
  if (error) throw error;
  if (data?.error) throw new Error(data.error);
  if (data) {
    saveLocalReportCache(userName, data);
  }
  return data;
}
