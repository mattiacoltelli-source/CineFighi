// Edge Function "generate-report"
//
// Adattata da Cos90 (CineTracker Personal, single-user) allo schema
// multi-utente di CineFighi: qui il report è personale — profila SOLO i
// titoli che l'utente indicato ha visto E votato lui, non l'intera
// libreria condivisa del gruppo.
//
// Chiamata: on-demand dal tasto "Aggiorna" nella tab Report (solo la prima
// volta), poi in automatico una volta all'anno controllato lato client
// (vedi storage.js::loadLatestReport) — nessun cron lato Supabase.
//
// Le statistiche (medie, conteggi, registi con più titoli) sono calcolate
// qui in codice, NON dal modello — a Claude chiediamo solo il profilo
// narrativo, la nota sui generi e le 10 raccomandazioni, che richiedono
// giudizio/conoscenza e non aritmetica.

import Anthropic from "npm:@anthropic-ai/sdk";
import { z } from "npm:zod";
import { zodOutputFormat } from "npm:@anthropic-ai/sdk/helpers/zod";

const MIN_VOTED_FOR_REPORT = 50;
const TMDB_API_KEY = "c9ebaca404bbc26bad39cce1c3aa9677"; // stessa chiave pubblica già usata in tmdb.js
const RECS_REQUESTED = 12; // richiediamo qualche titolo in più: alcuni verranno scartati dal filtro anti-duplicati qui sotto
const RECS_FINAL = 10;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function average(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

// Normalizza un titolo per il confronto (minuscolo, senza accenti/punteggiatura):
// serve a scartare deterministicamente, in codice, qualunque raccomandazione
// che coincida con un titolo già visto o in watchlist — non ci affidiamo solo
// all'istruzione nel prompt, che il modello può comunque non rispettare.
function normTitle(t: string): string {
  return t
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const ReportContentSchema = z.object({
  profile: z.array(z.string()).min(2).max(3),
  genres_note: z.string(),
  // FIX: era .length(RECS_REQUESTED) — un vincolo esatto che falliva l'intera
  // generazione (nessun report salvato) ogni volta che Claude ne restituiva
  // uno in più o in meno del richiesto. Il codice sotto filtra i duplicati e
  // poi taglia comunque a RECS_FINAL, quindi basta che ce ne siano abbastanza
  // dopo il filtro — un range invece di un numero esatto.
  recommendations: z.array(z.object({
    title: z.string(),
    year: z.string(),
    media_type: z.enum(["movie", "tv"]),
    director: z.string(),
    why: z.string().min(15),
  })).min(RECS_FINAL).max(RECS_REQUESTED + 6),
});

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  try {
    const { user_name } = await req.json().catch(() => ({}));
    if (!user_name || typeof user_name !== "string") {
      return new Response(
        JSON.stringify({ error: "Parametro user_name mancante." }),
        { status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
      );
    }

    const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
    const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY");

    if (!SUPABASE_URL || !SERVICE_KEY) {
      throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY mancanti (dovrebbero essere iniettate automaticamente).");
    }
    if (!ANTHROPIC_KEY) {
      throw new Error("Secret ANTHROPIC_API_KEY non configurata su questo progetto Supabase.");
    }

    const restHeaders = {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
    };

    // ── 1. Dati grezzi da Supabase (libreria condivisa + voti di questo utente) ──
    const [titlesRes, votesRes] = await Promise.all([
      fetch(`${SUPABASE_URL}/rest/v1/titles?select=*`, { headers: restHeaders }),
      fetch(`${SUPABASE_URL}/rest/v1/votes?user_name=eq.${encodeURIComponent(user_name)}&select=title_id,vote`, { headers: restHeaders }),
    ]);
    if (!titlesRes.ok) throw new Error(`Lettura titles fallita: ${titlesRes.status} ${await titlesRes.text()}`);
    if (!votesRes.ok) throw new Error(`Lettura votes fallita: ${votesRes.status} ${await votesRes.text()}`);

    const allTitles: any[] = await titlesRes.json();
    const myVotes: { title_id: number; vote: number }[] = await votesRes.json();
    const myVoteByTitle = new Map(myVotes.map(v => [v.title_id, Number(v.vote)]));

    // "Visti da me": titoli segnati come visti E che io stesso ho votato —
    // non basta che siano "seen" nella libreria condivisa, deve averli
    // valutati proprio questo utente.
    const seen = allTitles
      .filter(t => t.status === "seen" && myVoteByTitle.has(t.id))
      .map(t => ({ ...t, vote: myVoteByTitle.get(t.id) }));

    if (seen.length < MIN_VOTED_FOR_REPORT) {
      return new Response(
        JSON.stringify({ error: `Servono almeno ${MIN_VOTED_FOR_REPORT} titoli votati per generare un report (ne hai ${seen.length}).` }),
        { status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
      );
    }

    // Watchlist dell'intero gruppo: serve solo a evitare di consigliare
    // qualcosa che qualcuno ha già messo in coda.
    const watchlist = allTitles.filter(t => t.status === "watchlist");

    // ── 2. Statistiche calcolate qui, non dal modello ──────────────────────────
    const genreCount: Record<string, number> = {};
    const genreVotes: Record<string, number[]> = {};
    const directorVotes: Record<string, number[]> = {};
    const allVotesArr: number[] = [];

    for (const item of seen) {
      const vote = Number(item.vote);
      if (Number.isFinite(vote)) allVotesArr.push(vote);

      for (const g of item.genre_names || []) {
        genreCount[g] = (genreCount[g] || 0) + 1;
        if (Number.isFinite(vote)) (genreVotes[g] ||= []).push(vote);
      }

      if (item.director && Number.isFinite(vote)) {
        (directorVotes[item.director] ||= []).push(vote);
      }
    }

    const avgVote = allVotesArr.length ? average(allVotesArr) : null;

    const genresTopCount = Object.entries(genreCount)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([name, count]) => ({
        name,
        count,
        avg: genreVotes[name] ? Number(average(genreVotes[name]).toFixed(2)) : null,
      }));

    const genresTopAvg = Object.entries(genreVotes)
      .filter(([, v]) => v.length >= 5)
      .map(([name, v]) => ({ name, avg: Number(average(v).toFixed(2)), count: genreCount[name] }))
      .sort((a, b) => b.avg - a.avg)
      .slice(0, 8);

    const directors = Object.entries(directorVotes)
      .filter(([, v]) => v.length >= 2)
      .map(([name, v]) => ({ name, count: v.length, avg: Number(average(v).toFixed(2)) }))
      .sort((a, b) => b.avg - a.avg)
      .slice(0, 8);

    // Righe compatte per il prompt: tengono il costo basso anche con centinaia
    // di titoli (niente chiavi JSON ripetute 250+ volte).
    const seenLines = seen
      .map((i: any) => `${i.title} (${i.year}) | ${i.director || "—"} | ${(i.genre_names || []).join(",")} | ${i.vote ?? "—"}`)
      .join("\n");

    const watchlistLine = watchlist.map((i: any) => `${i.title} (${i.year})`).join(", ") || "vuota";

    // ── 3. Claude: solo profilo, nota generi e raccomandazioni ────────────────
    const client = new Anthropic({ apiKey: ANTHROPIC_KEY });

    const response = await client.messages.parse({
      model: "claude-sonnet-5",
      max_tokens: 4000,
      output_config: {
        effort: "medium",
        format: zodOutputFormat(ReportContentSchema),
      },
      system:
        "Sei l'analista personale di un'app di tracking film/serie TV. Scrivi in italiano, in seconda persona, tono diretto e colloquiale, mai da comunicato stampa. Basati SOLO sui dati numerici forniti nel messaggio, non inventare cifre. Per le raccomandazioni usa la tua conoscenza di film/serie realmente esistenti, e non proporre MAI un titolo già presente tra i visti o nella watchlist elencati.",
      messages: [{
        role: "user",
        content: `Statistiche già calcolate (non ricalcolarle):
- Titoli visti e votati da questa persona: ${seen.length}, voto medio: ${avgVote !== null ? avgVote.toFixed(2) : "n.d."}
- Generi più visti: ${JSON.stringify(genresTopCount)}
- Generi meglio votati (min. 5 titoli): ${JSON.stringify(genresTopAvg)}
- Registi con almeno 2 titoli, per media voto: ${JSON.stringify(directors)}

Libreria vista e votata da questa persona (titolo (anno) | regista | generi | voto):
${seenLines}

In watchlist del gruppo (NON consigliare questi): ${watchlistLine}

Scrivi:
1. "profile": 2-3 paragrafi che raccontano il profilo di gusti di questa persona, con numeri concreti presi dai dati sopra.
2. "genres_note": 2-3 frasi su generi più visti vs. meglio votati.
3. "recommendations": esattamente ${RECS_REQUESTED} titoli reali (film o serie, indica "media_type" corretto), MAI titoli già presenti nell'elenco dei visti o della watchlist qui sopra (controlla con attenzione, anche eventuali sequel/prequel/remake con lo stesso titolo esatto vanno evitati se il titolo coincide) — ne verranno scartati alcuni per sicurezza, per questo te ne chiediamo ${RECS_REQUESTED} invece di ${RECS_FINAL}. Ogni titolo deve avere una riga di motivazione ("why", almeno una frase completa) legata a un dato concreto sopra (un regista, un genere, una struttura narrativa ricorrente) — non lasciarla mai vuota o generica.

Formattazione: in "profile", "genres_note" e in ogni "why", evidenzia con **doppi asterischi** solo i 2-3 dati o nomi davvero rilevanti per frase (un numero, un genere, un regista) — non l'intera frase, non ogni numero. Es: "con **286 titoli** visti sei un divoratore di **Thriller**". Niente altra formattazione markdown.`,
      }],
    });

    const parsed = response.parsed_output;
    if (!parsed) {
      throw new Error("Claude non ha restituito un output valido.");
    }

    // ── 4. Filtro anti-duplicati (deterministico, non ci fidiamo solo del prompt) ──
    const excluded = new Set([
      ...seen.map((i: any) => normTitle(i.title || "")),
      ...watchlist.map((i: any) => normTitle(i.title || "")),
    ]);

    const finalRecs = parsed.recommendations
      .filter(r => !excluded.has(normTitle(r.title)))
      .slice(0, RECS_FINAL);

    // ── 5. Poster da TMDB (il modello non conosce i path delle locandine) ──────
    const recsWithPosters = await Promise.all(finalRecs.map(async (r) => {
      try {
        const yearParam = r.media_type === "tv" ? "first_air_date_year" : "year";
        const url = `https://api.themoviedb.org/3/search/${r.media_type}` +
          `?api_key=${TMDB_API_KEY}&language=it-IT&query=${encodeURIComponent(r.title)}&${yearParam}=${encodeURIComponent(r.year)}`;
        const res = await fetch(url);
        if (!res.ok) return { ...r, poster_path: null };
        const data = await res.json();
        return { ...r, poster_path: data.results?.[0]?.poster_path ?? null };
      } catch {
        return { ...r, poster_path: null };
      }
    }));

    // ── 6. Salvataggio ──────────────────────────────────────────────────────────
    const payload = {
      seen_count: seen.length,
      avg_vote: avgVote,
      genres_top_count: genresTopCount,
      genres_top_avg: genresTopAvg,
      directors,
      profile: parsed.profile,
      genres_note: parsed.genres_note,
      recommendations: recsWithPosters,
    };

    const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/user_report`, {
      method: "POST",
      headers: { ...restHeaders, Prefer: "return=representation" },
      body: JSON.stringify({ user_name, payload }),
    });
    if (!insertRes.ok) {
      throw new Error(`Scrittura report fallita: ${insertRes.status} ${await insertRes.text()}`);
    }

    const [saved] = await insertRes.json();

    return new Response(JSON.stringify(saved), {
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error(e);
    return new Response(JSON.stringify({ error: String((e as Error)?.message || e) }), {
      status: 500,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }
});
