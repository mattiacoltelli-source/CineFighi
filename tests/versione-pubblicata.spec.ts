import { test, expect } from "@playwright/test";

// Controllo GIORNALIERO (solo sul sito vero) che la versione pubblicata sia
// quella dell'ultimo commit vero su main. Il workflow "Bump version" scrive
// l'hash breve del commit in ogni "?v=..." di index.html e in SW_VERSION di
// sw.js: e' cio' che fa ricaricare il codice nuovo a browser e PWA. Se la
// pubblicazione su GitHub Pages si blocca o fallisce, il sito resta su una
// versione vecchia senza che nessun test lo noti.
//
// L'ultimo commit vero e' il primo che non e' un bump automatico ("[skip ci]").
// Dopo un merge la pubblicazione impiega qualche minuto: entro 20 minuti dal
// commit un ritardo non e' un errore. Se l'API di GitHub non risponde (limite
// di richieste) il test si salta, non fallisce: sarebbe un falso allarme.

const REPO = "mattiacoltelli-source/CineFighi";
const TOLLERANZA_MIN = 20;
const soloSitoVero = !/github\.io/.test(process.env.CINEFIGHI_URL ?? "");

test("il sito pubblicato serve la versione dell'ultimo commit", async ({ request, baseURL }) => {
  test.skip(soloSitoVero, "controllo giornaliero: gira solo sul sito pubblicato (CINEFIGHI_URL su github.io)");

  const nonInCache = `?controllo=${Date.now()}`;
  const [htmlRes, swRes] = await Promise.all([
    request.get(new URL(`index.html${nonInCache}`, baseURL!).href),
    request.get(new URL(`sw.js${nonInCache}`, baseURL!).href),
  ]);
  expect(htmlRes.ok(), `index.html del sito non raggiungibile: ${htmlRes.status()}`).toBe(true);
  expect(swRes.ok(), `sw.js del sito non raggiungibile: ${swRes.status()}`).toBe(true);
  const versioneHtml = (await htmlRes.text()).match(/app\.js\?v=([A-Za-z0-9]+)/)?.[1];
  const versioneSw = (await swRes.text()).match(/const SW_VERSION = "([A-Za-z0-9]+)"/)?.[1];
  expect(versioneHtml, "nessun app.js?v=... in index.html").toBeTruthy();
  expect(versioneSw, "nessuna SW_VERSION in sw.js").toBeTruthy();
  expect(versioneSw, `sw.js (${versioneSw}) e index.html (${versioneHtml}) hanno versioni diverse`).toBe(versioneHtml);

  // Versione attesa: quella dell'ultimo commit che non e' un bump automatico.
  // VERSIONE_ATTESA serve solo a provare il test a mano (simulare un sito in ritardo).
  let attesa = process.env.VERSIONE_ATTESA ?? "";
  let quandoCommit = 0;
  if (!attesa) {
    // Con il token (Actions lo fornisce) il limite di richieste e' alto; se il
    // token non vale (401/403) si riprova senza: il repository e' pubblico.
    const token = process.env.GITHUB_TOKEN;
    const url = `https://api.github.com/repos/${REPO}/commits?sha=main&per_page=15`;
    const intestazioni = { Accept: "application/vnd.github+json" };
    let api = await request.get(url, { headers: token ? { ...intestazioni, Authorization: `Bearer ${token}` } : intestazioni });
    if (token && (api.status() === 401 || api.status() === 403)) api = await request.get(url, { headers: intestazioni });
    test.skip(!api.ok(), `API GitHub non disponibile (${api.status()}): controllo saltato per non dare un falso allarme`);
    const commit = (await api.json()) as Array<{ sha: string; commit: { message: string; committer: { date: string } } }>;
    const vero = commit.find(c => !c.commit.message.includes("[skip ci]"));
    expect(vero, "nessun commit vero tra gli ultimi 15 su main").toBeTruthy();
    attesa = vero!.sha.slice(0, 7);
    quandoCommit = new Date(vero!.commit.committer.date).getTime();
  }

  if (versioneHtml !== attesa) {
    const minuti = quandoCommit ? (Date.now() - quandoCommit) / 60_000 : Infinity;
    test.skip(minuti < TOLLERANZA_MIN, `pubblicazione in corso: il commit ${attesa} ha ${Math.round(minuti)} minuti`);
  }
  expect(versioneHtml, `il sito pubblicato e' fermo a ${versioneHtml}, l'ultimo commit su main e' ${attesa}: la pubblicazione e' bloccata?`).toBe(attesa);
});
