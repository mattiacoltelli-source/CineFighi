// Edge Function "generate-group-report"
//
// Mirror di generate-report, ma per il gruppo intero invece che per un
// singolo utente: un solo report condiviso, nessun user_name.
//
// Chiamata: on-demand dal gesto nascosto (7 tap sul titolo "Report"), o
// automaticamente ogni 4 mesi (1° gennaio/maggio/settembre, ore 6 UTC)
// tramite un cron reale lato Supabase — vedi la migrazione
// group_report_cron_4_months. A differenza del report personale
// (auto-rigenerato una volta all'anno, per utente, controllato lato
// client), qui il trigger periodico è server-side: nessuno deve aprire
// l'app perché il report si aggiorni in tempo.
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

// PostgREST risponde al massimo con 1000 righe per richiesta e NON segnala il
// taglio: con `select=*` semplice, oltre la riga 1000 i dati sparivano in
// silenzio (30/9/2026: `votes` aveva 1005 righe e il report ne perdeva 5).
// Si legge a pagine con un ordine stabile (`order=id.asc`, senza potrebbero
// ripetersi o saltarsi righe tra una pagina e l'altra) finche' una pagina
// torna incompleta. `query` e' il pezzo dopo `/rest/v1/`, senza order/limit.
async function fetchAllRows(supabaseUrl: string, headers: Record<string, string>, query: string): Promise<any[]> {
  const PAGE_SIZE = 1000;
  const rows: any[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const res = await fetch(`${supabaseUrl}/rest/v1/${query}&order=id.asc&limit=${PAGE_SIZE}&offset=${offset}`, { headers });
    if (!res.ok) throw new Error(`Lettura ${query.split("?")[0]} fallita: ${res.status} ${await res.text()}`);
    const page = await res.json();
    rows.push(...page);
    if (page.length < PAGE_SIZE) return rows;
  }
}

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
  // Stessa soglia proporzionale ai voti di cine-core.js::groupMemberProfiles
  // (5 oltre 100 voti, 4 da 40, 3 sotto): 3 titoli su 351 sono rumore.
  const minGenreVotes = n >= 100 ? 5 : n >= 40 ? 4 : 3;
  const bestByAvg = (acc: Record<string, number[]>, minCount: number) => {
    const entries = Object.entries(acc)
      .filter(([, v]) => v.length >= minCount)
      .map(([name, v]) => ({ name, avg: average(v), count: v.length }));
    entries.sort((a, b) => b.avg - a.avg);
    return entries[0] || null;
  };

  // Attori ricorrenti (primi 3 del cast di ogni titolo), generi più visti e
  // decennio: calcolati qui, il modello li riceve già fatti.
  const actorVotes: Record<string, number[]> = {};
  const decadeVotes: Record<string, number[]> = {};
  for (const { item, vote } of voted) {
    for (const a of item.cast_names || []) (actorVotes[a] ||= []).push(vote);
    const y = Number(item.year);
    if (Number.isFinite(y) && y > 1880) (decadeVotes[`${Math.floor(y / 10) * 10}s`] ||= []).push(vote);
  }
  const minActor = n >= 100 ? 4 : 3;
  const topActors = Object.entries(actorVotes)
    .filter(([, v]) => v.length >= minActor)
    .map(([name, v]) => ({ name, count: v.length, avg: Number(average(v).toFixed(2)) }))
    .sort((a, b) => b.count - a.count || b.avg - a.avg)
    .slice(0, 3);
  const minDecade = n >= 100 ? 10 : 5;
  const decades = Object.entries(decadeVotes)
    .filter(([, v]) => v.length >= minDecade)
    .map(([name, v]) => ({ name, count: v.length, avg: Number(average(v).toFixed(2)) }));
  const decadeMostSeen = [...decades].sort((a, b) => b.count - a.count)[0] || null;
  const decadeBestRated = [...decades].sort((a, b) => b.avg - a.avg)[0] || null;
  const genresMostSeen = Object.entries(genreVotes)
    .map(([name, v]) => ({ name, count: v.length, avg: Number(average(v).toFixed(2)) }))
    .sort((a, b) => b.count - a.count || b.avg - a.avg)
    .slice(0, 3);

  const sorted = [...voted].sort((a, b) => b.vote - a.vote);
  const topFilms = sorted.slice(0, 3).map(({ item, vote }) => ({ title: item.title, vote }));
  const bottomFilms = sorted.slice(-3).reverse().map(({ item, vote }) => ({ title: item.title, vote }));

  return {
    user, n, avg, sd,
    genere_piu_amato: bestByAvg(genreVotes, minGenreVotes),
    generi_piu_visti: genresMostSeen,
    topDirector: bestByAvg(directorVotes, 2),
    topActors, decadeMostSeen, decadeBestRated,
    topFilms, bottomFilms,
  };
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

    // ── 0. Freno: un report recente non si rigenera ────────────────────────
    //
    // Il report di gruppo deve cambiare ogni 4 mesi, non ogni giorno. Finora
    // la cadenza era affidata solo a CHI chiama (il cron lato Supabase e il
    // controllo annuale lato client), e bastava che qualcos'altro invocasse
    // questa funzione perche' il report venisse riscritto — con una chiamata
    // a Claude ogni volta. E' successo davvero: due rigenerazioni al giorno,
    // tutti i giorni, per giorni.
    //
    // Il freno sta qui e non nel chiamante perche' questo e' l'unico punto
    // che vale per TUTTI: il client, un test, il cron, una riesecuzione a
    // mano. 90 giorni non ostacola mai il cron vero (le sue esecuzioni
    // distano ~120 giorni) e ferma qualunque ripetizione ravvicinata.
    //
    // `force: true` lo scavalca: e' il gesto nascosto dei 7 tap, che chiede
    // conferma esplicita prima di spendere una chiamata.
    const MIN_GIORNI_FRA_REPORT = 90;

    let force = false;
    try {
      const body = await req.json();
      force = body?.force === true;
    } catch {
      // nessun corpo, o corpo non JSON: nessun forzamento
    }

    if (!force) {
      const ultimoRes = await fetch(
        `${SUPABASE_URL}/rest/v1/group_report?select=generated_at,payload&order=generated_at.desc&limit=1`,
        { headers: restHeaders },
      );
      if (ultimoRes.ok) {
        const [ultimo] = await ultimoRes.json();
        const quando = ultimo?.generated_at ? new Date(ultimo.generated_at).getTime() : NaN;
        const giorni = Number.isNaN(quando) ? Infinity : (Date.now() - quando) / 86_400_000;
        if (giorni < MIN_GIORNI_FRA_REPORT) {
          console.log(`Rigenerazione saltata: l'ultimo report ha ${giorni.toFixed(1)} giorni (minimo ${MIN_GIORNI_FRA_REPORT}).`);
          // Non e' un errore: il chiamante riceve il report che c'e' gia',
          // quindi l'app mostra la cosa giusta senza accorgersi di niente.
          return new Response(JSON.stringify({ ...ultimo, skipped: true, days_old: Math.round(giorni) }), {
            headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
          });
        }
      }
      // Lettura fallita: si prosegue. Meglio un report in piu' che nessuno.
    }

    // ── 1. Dati grezzi: intera libreria + tutti i voti + elenco utenti ──────
    const [allTitles, allVotes, usersRows] = await Promise.all([
      fetchAllRows(SUPABASE_URL, restHeaders, "titles?select=*"),
      fetchAllRows(SUPABASE_URL, restHeaders, "votes?select=id,title_id,user_name,vote") as Promise<{ title_id: number; user_name: string; vote: number }[]>,
      fetchAllRows(SUPABASE_URL, restHeaders, "users?select=id,name"),
    ]);
    const users: string[] = usersRows.map((u: any) => u.name);

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
    const memberNames = new Set(members.map(m => m.user));

    // "Tutti" nel prompt (sia il conteggio persone che "titoli votati da
    // tutti") è sempre riferito ai membri sopra soglia, MAI al totale utenti
    // registrati: altrimenti Claude scrive frasi come "tutti e 9" quando in
    // realtà solo una parte di quei 9 viene davvero profilata nel report —
    // un numero che il lettore non riesce a ricollegare a nessuno dei nomi
    // effettivamente citati sotto.
    const allVotedTitles = allTitles
      .filter(t => members.length > 0 && [...memberNames].every(u => votesByTitle.get(t.id)?.[u] !== undefined))
      .map(t => {
        const vals = Object.values(votesByTitle.get(t.id)!);
        return { title: t.title, avg: average(vals) };
      });

    // "Titoli aggiunti per persona" è un dato editoriale quanto i voti (Claude
    // lo usa per dire chi cataloga di più) — se lo lasciassimo per TUTTI gli
    // utenti, Claude potrebbe nominare per nome anche chi non ha superato la
    // soglia voti sopra, solo perché ha aggiunto tanti titoli. Filtrato sugli
    // stessi membri per non nominare mai nessuno fuori da quella lista.
    const addedCount: Record<string, number> = {};
    for (const t of allTitles) {
      if (t.added_by && memberNames.has(t.added_by)) {
        addedCount[t.added_by] = (addedCount[t.added_by] || 0) + 1;
      }
    }

    // Primati tra persone: calcolati qui, non dedotti dal modello. Così frasi
    // come "la media più bassa del gruppo" sono sempre vere.
    const extreme = (key: "n" | "avg" | "sd", dir: "max" | "min") => {
      if (members.length < 2) return null;
      const best = members.reduce((a, b) => ((dir === "max" ? b[key] > a[key] : b[key] < a[key]) ? b : a));
      return { user: best.user, value: Number(best[key].toFixed(2)) };
    };
    const primati = {
      piu_voti: extreme("n", "max"),
      media_piu_alta: extreme("avg", "max"),
      media_piu_bassa: extreme("avg", "min"),
      piu_costante_dev_std_minima: extreme("sd", "min"),
      piu_polarizzato_dev_std_massima: extreme("sd", "max"),
    };

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
- Persone profilate in questo report (almeno ${MIN_VOTES_FOR_MEMBER_BLURB} voti a testa): ${members.length}, voti totali: ${allVoteValues.length}, media di gruppo: ${avgVote.toFixed(2)}
- Titoli catalogati: ${allTitles.length}; titoli diversi votati da almeno una persona: ${votesByTitle.size}
- Titoli votati da tutte e ${members.length} le persone profilate: ${JSON.stringify(allVotedTitles)}
- Titoli aggiunti per persona: ${JSON.stringify(addedCount)}
- Primati tra persone, GIÀ VERIFICATI dal codice (per i confronti tra persone usa solo questi, non dedurne altri): ${JSON.stringify(primati)}

Profilo per persona (n voti, media, deviazione standard dei SUOI voti, genere_piu_amato (per media voto, con un minimo di voti: 5 se ha oltre 100 voti, 4 oltre 40, altrimenti 3), generi_piu_visti (per numero di titoli), regista top con almeno 2 titoli, attori ricorrenti (nei primi 3 del cast), decennio più visto e meglio votato, i suoi 3 voti più alti, i suoi 3 voti più bassi):
${JSON.stringify(members, null, 0)}

Scrivi:
1. "group_profile": 2-3 paragrafi sul gruppo nel suo complesso. Nel PRIMO paragrafo scrivi sempre due numeri veri presi da sopra: i voti totali dati dal gruppo e quanti titoli diversi sono stati votati; se i voti totali superano i 1000 (o un'altra cifra tonda importante), sottolinealo come un traguardo del gruppo. Poi — quanto guardano insieme davvero (usa i titoli votati da tutte le persone profilate, se ce ne sono), chi si comporta da curatore della collezione (chi ha aggiunto più titoli) vs. chi vota poco ma premia parecchio, o altri contrasti che i numeri suggeriscono. Il gruppo "nel suo complesso" qui significa le persone profilate elencate sotto, NON il numero totale di utenti dell'app — nomina per nome SOLO le persone elencate nel "Profilo per persona", e non dire mai un numero di persone diverso da quello dato sopra. Se vuoi parlare del gruppo senza nominare qualcuno specifico, va bene restare generico ("qualcuno nel gruppo...").
2. "members": un oggetto {"user", "blurb"} per OGNI persona elencata sopra (stesso identico nome, non tradurlo/abbreviarlo), un paragrafo di 2-4 frasi che ne racconta il gusto personale usando i suoi dati concreti — regista o genere che ama, i titoli a cui ha dato il voto più alto, e se ha una deviazione standard nettamente più alta o più bassa delle altre persone del gruppo fallo emergere (è "costante"/prevedibile oppure "polarizzato"/estremo — ma solo se il dato lo giustifica davvero, non forzarlo per tutti). Se la persona ha attori ricorrenti, cita almeno un attore per nome con il numero di titoli. Non scrivere le soglie minime usate per selezionare i dati (niente "su almeno N titoli"): usa solo i numeri veri.

Termini: chiama "più visti" solo i generi con più titoli e "più amati" solo quello con la media più alta; non chiamare "preferito" un genere solo perché ha molti titoli.

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
