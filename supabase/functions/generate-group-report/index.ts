// Edge Function "generate-group-report"
//
// Mirror di generate-report, ma per il gruppo intero invece che per un
// singolo utente: un solo report condiviso, nessun user_name.
//
// Chiamata: on-demand dal tasto "Aggiorna" nel tab Gruppo della schermata
// Report — nessun cron, nessuna rigenerazione automatica (a differenza del
// report personale, che si auto-rigenera una volta all'anno: qui la
// composizione del gruppo cambia raramente, ha senso solo un trigger
// manuale quando arriva un utente nuovo o i dati sono cambiati parecchio).
//
// Le statistiche (medie, deviazioni standard, chi ha votato di più, coppie
// di gusto, titoli divisivi/unanimi) restano calcolate lato client in
// cine-core.js, ESATTAMENTE come oggi — questa funzione non le tocca e non
// le duplica per il rendering. A Claude chiediamo solo le due cose che
// richiedono giudizio editoriale, non aritmetica:
//   1. "group_profile": 2-3 paragrafi sul gruppo nel suo complesso.
//   2. "members": un paragrafo editoriale per persona, nello stesso stile
//      dell'artefatto originale approvato dall'utente ("Cultore dei
//      classici: Ridley Scott (9,75). Ha dato 10 a tutti e tre i Signore
//      degli Anelli... ma stronca senza pietà...") — testo che un
//      algoritmo può solo approssimare, non scrivere davvero.
// Il client tiene questo payload in cache e lo usa al posto del testo
// templato locale quando disponibile; se non è mai stato generato (o la
// chiamata fallisce) resta il fallback client-side già in produzione,
// sempre gratuito e istantaneo — vedi cine-core.js::groupProfileStats /
// groupMemberProfiles e ui.js::renderGroupReport.

import Anthropic from "npm:@anthropic-ai/sdk";
import { z } from "npm:zod";
import { zodOutputFormat } from "npm:@anthropic-ai/sdk/helpers/zod";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function average(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

type Voted = { item: any; vote: number };

// Stesso calcolo di cine-core.js::groupMemberProfiles (n, media, deviazione
// standard, genere/regista top, voti più alti/più bassi) — riscritto qui
// perché questa funzione Deno non può importare un modulo ESM pensato per
// il browser. Se cambi la formula in cine-core.js, aggiorna anche qui.
function memberStats(allTitles: any[], votesByUser: Map<string, { title_id: number; vote: number }[]>, user: string) {
  const votesForUser = votesByUser.get(user) || [];
  const voteByTitle = new Map(votesForUser.map(v => [v.title_id, Number(v.vote)]));

  const voted: Voted[] = allTitles
    .filter(t => voteByTitle.has(t.id))
    .map(item => ({ item, vote: voteByTitle.get(item.id)! }));

  const n = voted.length;
  const avg = n ? average(voted.map(v => v.vote)) : 0;
  const variance = n ? average(voted.map(v => (v.vote - avg) ** 2)) : 0;
  const sd = Math.sqrt(variance);

  const genreVotes: Record<string, number[]> = {};
  const directorVotes: Record<string, number[]> = {};
  for (const { item, vote } of voted) {
    for (const g of item.genre_names || []) (genreVotes[g] ||= []).push(vote);
    if (item.director) (directorVotes[item.director] ||= []).push(vote);
  }
  const bestByAvg = (acc: Record<string, number[]>, minCount: number) => {
    const entries = Object.entries(acc)
      .filter(([, v]) => v.length >= minCount)
      .map(([name, v]) => ({ name, avg: average(v), count: v.length }));
    entries.sort((a, b) => b.avg - a.avg);
    return entries[0] || null;
  };

  const sorted = [...voted].sort((a, b) => b.vote - a.vote);
  const topFilms = sorted.slice(0, 3).map(({ item, vote }) => ({ title: item.title, vote }));
  const bottomFilms = sorted.slice(-3).reverse().map(({ item, vote }) => ({ title: item.title, vote }));

  return { user, n, avg, sd, topGenre: bestByAvg(genreVotes, 3), topDirector: bestByAvg(directorVotes, 2), topFilms, bottomFilms };
}

const GroupReportContentSchema = z.object({
  group_profile: z.array(z.string()).min(2).max(3),
  members: z.array(z.object({
    user: z.string(),
    blurb: z.string().min(20),
  })),
});

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  try {
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

    // ── 1. Dati grezzi: intera libreria + tutti i voti + elenco utenti ──────
    const [titlesRes, votesRes, usersRes] = await Promise.all([
      fetch(`${SUPABASE_URL}/rest/v1/titles?select=*`, { headers: restHeaders }),
      fetch(`${SUPABASE_URL}/rest/v1/votes?select=title_id,user_name,vote`, { headers: restHeaders }),
      fetch(`${SUPABASE_URL}/rest/v1/users?select=name`, { headers: restHeaders }),
    ]);
    if (!titlesRes.ok) throw new Error(`Lettura titles fallita: ${titlesRes.status} ${await titlesRes.text()}`);
    if (!votesRes.ok) throw new Error(`Lettura votes fallita: ${votesRes.status} ${await votesRes.text()}`);
    if (!usersRes.ok) throw new Error(`Lettura users fallita: ${usersRes.status} ${await usersRes.text()}`);

    const allTitles: any[] = await titlesRes.json();
    const allVotes: { title_id: number; user_name: string; vote: number }[] = await votesRes.json();
    const users: string[] = (await usersRes.json()).map((u: any) => u.name);

    if (!users.length) {
      return new Response(JSON.stringify({ error: "Nessun utente nel gruppo." }), {
        status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    const votesByUser = new Map<string, { title_id: number; vote: number }[]>();
    for (const v of allVotes) {
      if (!votesByUser.has(v.user_name)) votesByUser.set(v.user_name, []);
      votesByUser.get(v.user_name)!.push({ title_id: v.title_id, vote: v.vote });
    }

    // ── 2. Statistiche calcolate qui, non dal modello ──────────────────────
    const allVoteValues = allVotes.map(v => Number(v.vote)).filter(Number.isFinite);
    const avgVote = allVoteValues.length ? average(allVoteValues) : 0;

    const votesByTitle = new Map<number, Record<string, number>>();
    for (const v of allVotes) {
      if (!votesByTitle.has(v.title_id)) votesByTitle.set(v.title_id, {});
      votesByTitle.get(v.title_id)![v.user_name] = Number(v.vote);
    }
    const allVotedTitles = allTitles
      .filter(t => users.every(u => votesByTitle.get(t.id)?.[u] !== undefined))
      .map(t => {
        const vals = Object.values(votesByTitle.get(t.id)!);
        return { title: t.title, avg: average(vals) };
      });

    const addedCount: Record<string, number> = {};
    for (const t of allTitles) if (t.added_by) addedCount[t.added_by] = (addedCount[t.added_by] || 0) + 1;

    // Chi non ha ancora votato abbastanza (utente appena entrato, o poco
    // attivo) non entra nel prompt: sotto la soglia non c'è abbastanza dato
    // reale per un paragrafo vero, e chiederlo a Claude comunque
    // rischierebbe solo di inventare gusti da pochissimi voti. Il client
    // (cine-core.js::groupMemberProfiles) applica lo stesso taglio e nasconde
    // del tutto la card per queste persone (vedi ui.js::renderGroupReport) —
    // qui evitiamo di pagare per generare un paragrafo che poi non verrebbe
    // mai mostrato.
    // Stessa soglia di app.js::MIN_VOTED_FOR_REPORT (50) — se cambi lì, cambia anche qui.
    const MIN_VOTES_FOR_MEMBER_BLURB = 50;
    const allMembers = users.map(u => memberStats(allTitles, votesByUser, u)).sort((a, b) => b.n - a.n);
    const members = allMembers.filter(m => m.n >= MIN_VOTES_FOR_MEMBER_BLURB);

    // ── 3. Claude: solo il profilo di gruppo e un paragrafo per persona ────
    const client = new Anthropic({ apiKey: ANTHROPIC_KEY });

    const response = await client.messages.parse({
      model: "claude-sonnet-5",
      max_tokens: 4000,
      output_config: {
        effort: "medium",
        format: zodOutputFormat(GroupReportContentSchema),
      },
      system:
        "Sei l'analista di un gruppo di amici che tracciano insieme i film/serie TV che guardano su un'app condivisa. Scrivi in italiano, in terza persona (parli DEL gruppo e delle persone, non a loro direttamente), tono diretto, colloquiale, con un pizzico di ironia affettuosa — mai da comunicato stampa, mai generico. Basati SOLO sui dati numerici forniti nel messaggio, non inventare cifre né titoli. Ogni paragrafo per persona deve citare almeno un dato concreto (un regista, un titolo con voto, un genere) e, quando i numeri lo suggeriscono (media alta con pochi voti, deviazione standard alta o bassa, generi contrastanti), far emergere un tratto di personalità riconoscibile — esattamente come faresti descrivendo amici veri, non profili anonimi.",
      messages: [{
        role: "user",
        content: `Statistiche di gruppo già calcolate (non ricalcolarle):
- Persone nel gruppo: ${users.length}, voti totali: ${allVoteValues.length}, media di gruppo: ${avgVote.toFixed(2)}
- Titoli catalogati: ${allTitles.length}
- Titoli votati da tutti e ${users.length}: ${JSON.stringify(allVotedTitles)}
- Titoli aggiunti per persona: ${JSON.stringify(addedCount)}

Profilo per persona (n voti, media, deviazione standard dei SUOI voti, genere top con almeno 3 voti in quel genere, regista top con almeno 2 titoli, i suoi 3 voti più alti, i suoi 3 voti più bassi):
${JSON.stringify(members, null, 0)}

Scrivi:
1. "group_profile": 2-3 paragrafi sul gruppo nel suo complesso — quanto guardano insieme davvero (usa i titoli votati da tutti, se ce ne sono), chi si comporta da curatore della collezione (chi ha aggiunto più titoli) vs. chi vota poco ma premia parecchio, o altri contrasti che i numeri suggeriscono.
2. "members": un oggetto {"user", "blurb"} per OGNI persona elencata sopra (stesso identico nome, non tradurlo/abbreviarlo), un paragrafo di 2-4 frasi che ne racconta il gusto personale usando i suoi dati concreti — regista o genere che ama, i titoli a cui ha dato il voto più alto, e se ha una deviazione standard nettamente più alta o più bassa delle altre persone del gruppo fallo emergere (è "costante"/prevedibile oppure "polarizzato"/estremo — ma solo se il dato lo giustifica davvero, non forzarlo per tutti).

Formattazione: evidenzia con **doppi asterischi** solo i 2-3 dati o nomi davvero rilevanti per frase (un titolo, un regista, un numero) — non l'intera frase, non ogni numero. Niente altra formattazione markdown.`,
      }],
    });

    const parsed = response.parsed_output;
    if (!parsed) {
      throw new Error("Claude non ha restituito un output valido.");
    }

    // ── 4. Salvataggio ────────────────────────────────────────────────────
    const payload = {
      user_count: users.length,
      vote_count: allVoteValues.length,
      avg_vote: avgVote,
      all_voted_titles: allVotedTitles,
      group_profile: parsed.group_profile,
      members: parsed.members,
    };

    const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/group_report`, {
      method: "POST",
      headers: { ...restHeaders, Prefer: "return=representation" },
      body: JSON.stringify({ payload }),
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
