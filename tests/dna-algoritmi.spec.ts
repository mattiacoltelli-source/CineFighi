import { test, expect, APIRequestContext } from "@playwright/test";
import { entra, vaiA, osserva, soloLettura } from "./helpers";

// Verifica che i NUMERI mostrati sotto "Tutta la rete" (dna-view.js,
// fullViewStats) corrispondano ai voti veri, non solo che "ci siano delle
// righe" (già coperto da dna.spec.ts). Sola lettura: interroga Supabase con
// la stessa chiave pubblica dell'app, mai una scrittura.
//
// Scelta deliberata: NON reimplementiamo qui l'algoritmo di ranking intero
// (chi vince tra i registi/generi — punteggio con shrinkage bayesiano in
// dna.js::directorScores, non banale) — un errore nostro nel reimplementarlo
// darebbe un falso allarme, esattamente il rischio di cui abbiamo parlato.
// Verifichiamo invece che il VINCITORE mostrato sia internamente coerente
// coi dati veri (la media mostrata corrisponde ai voti veri, le soglie
// minime sono rispettate) — cattura comunque i regressioni reali (numero
// sbagliato, soglia non rispettata, film che non doveva qualificarsi) senza
// dover duplicare la logica di scelta del vincitore.

const SUPABASE_URL = "https://dxzukpujouayxlomwryc.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_6kaInTs-_PDPHUszpj8N5w_Sb1zCXI9";
const LIKE_THRESHOLD = 7;
const STAT_MIN_TITOLI = 3;       // dna-view.js
const DIRECTOR_MIN_FILMS = 3;    // dna.js

type Titolo = { id: string; title: string; director: string | null; genre_names: string[] | null };
type Voto = { title_id: string; user_name: string; vote: string };

async function leggiTabella<T>(request: APIRequestContext, tabella: string, select: string): Promise<T[]> {
  const res = await request.get(`${SUPABASE_URL}/rest/v1/${tabella}?select=${select}`, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
  });
  expect(res.ok(), `lettura ${tabella} fallita: ${res.status()}`).toBe(true);
  return res.json();
}

// La stessa identica soglia di dna-view.js::sogliaVisti — unica formula che
// vale la pena duplicare qui, è due righe e non è a rischio di
// disallineamento silenzioso come lo sarebbe l'intero algoritmo di ranking.
function sogliaVisti(n: number): number {
  return n <= 3 ? n : Math.ceil((2 * n) / 3);
}

function media(voti: number[]): number {
  return voti.reduce((a, b) => a + b, 0) / voti.length;
}

async function leggiRigheStat(page: import("@playwright/test").Page): Promise<Record<string, string>> {
  const righe = await page.locator(".dna-full-stats__row").evaluateAll(els =>
    els.map(el => [el.querySelector("span")?.textContent?.trim() ?? "", el.querySelector("strong")?.textContent?.trim() ?? ""])
  );
  return Object.fromEntries(righe);
}

test("i numeri di \"Tutta la rete\" corrispondono ai voti veri", async ({ page, request }) => {
  const guasti = osserva(page);
  const scritture = soloLettura(page);
  await entra(page);
  await vaiA(page, "tonight");
  await page.locator("#dnaNodes .dna-node").first().waitFor({ state: "visible", timeout: 30_000 });

  // Espande la rete abbastanza da far comparire "vedi tutta la rete"
  // (stesso approccio di dna.spec.ts — soglia VIEW_ALL_MIN_NODES).
  async function tocca(selettore: string): Promise<boolean> {
    const nodo = page.locator(selettore).first();
    if (!(await nodo.count())) return false;
    const box = await nodo.boundingBox();
    if (!box) return false;
    await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForTimeout(400);
    return true;
  }
  await tocca(".dna-node.is-root");
  const visti = new Set<string>();
  for (let i = 0; i < 12; i++) {
    const prossimo = await page.evaluate(giaVisti => {
      const attivo = document.querySelector<HTMLElement>(".dna-node.is-focus")?.dataset.node;
      return [...document.querySelectorAll<HTMLElement>(".dna-node")]
        .map(n => n.dataset.node!)
        .find(id => id !== attivo && !giaVisti.includes(id));
    }, [...visti]);
    if (!prossimo) break;
    visti.add(prossimo);
    if (!(await tocca(`[data-node="${prossimo}"]`))) break;
  }
  const bottone = page.locator("#dnaViewAllBtn");
  test.skip(await bottone.evaluate(el => el.classList.contains("hidden")), "rete troppo piccola per aprire la vista completa");
  await bottone.click();
  await page.locator("#dnaFullNodes .dna-node").first().waitFor({ state: "visible" });

  const righe = await leggiRigheStat(page);
  console.log("Righe lette dallo schermo:", righe);

  // Dati veri, per la modalità "Tutti" (nessuna selezione persone): tutto
  // il gruppo, come lo calcola buildIndex(db, null/users).
  const [persone, titoli, voti] = await Promise.all([
    leggiTabella<{ name: string }>(request, "users", "name").then(r => r.map(u => u.name)),
    leggiTabella<Titolo>(request, "titles", "id,title,director,genre_names"),
    leggiTabella<Voto>(request, "votes", "title_id,user_name,vote"),
  ]);

  const votiPerTitolo = new Map<string, Voto[]>();
  for (const v of voti) {
    if (!persone.includes(v.user_name)) continue;
    (votiPerTitolo.get(v.title_id) ?? votiPerTitolo.set(v.title_id, []).get(v.title_id)!).push(v);
  }

  // "Amati" = titoli con almeno un fan (voto >= LIKE_THRESHOLD) tra le
  // persone del gruppo — lo stesso filtro di buildIndex in dna.js.
  const amati = titoli
    .map(t => ({ t, fan: (votiPerTitolo.get(t.id) ?? []).filter(v => Number(v.vote) >= LIKE_THRESHOLD) }))
    .filter(x => x.fan.length > 0);

  // ─── Genere preferito ───────────────────────────────────────────────────
  if (righe["Genere preferito"]) {
    const nomeGenere = righe["Genere preferito"].replace(/\s*\(media [\d,]+\)$/, "");
    const conMedia = righe["Genere preferito"].match(/media ([\d,]+)/)?.[1]?.replace(",", ".");
    expect(conMedia, `formato inatteso per "Genere preferito": ${righe["Genere preferito"]}`).toBeTruthy();

    const delGenere = amati.filter(x => (x.t.genre_names ?? []).includes(nomeGenere));
    expect(delGenere.length, `"${nomeGenere}" ha meno di ${STAT_MIN_TITOLI} titoli amati, non doveva qualificarsi`).toBeGreaterThanOrEqual(STAT_MIN_TITOLI);

    const votiDelGenere = delGenere.flatMap(x => x.fan.map(f => Number(f.vote)));
    const mediaVera = media(votiDelGenere);
    expect(Number(conMedia), `media mostrata per "${nomeGenere}" non corrisponde ai voti veri`).toBeCloseTo(mediaVera, 1);
  }

  // ─── Regista preferito ──────────────────────────────────────────────────
  if (righe["Regista preferito"]) {
    const m = righe["Regista preferito"].match(/^(.+?) \((\d+) film, media ([\d,]+)\)$/);
    expect(m, `formato inatteso per "Regista preferito": ${righe["Regista preferito"]}`).toBeTruthy();
    const [, nomeRegista, filmCountStr, mediaStr] = m!;

    const delRegista = amati.filter(x => x.t.director === nomeRegista);
    expect(delRegista.length, `"${nomeRegista}" ha meno di ${DIRECTOR_MIN_FILMS} film amati, non doveva qualificarsi`).toBeGreaterThanOrEqual(DIRECTOR_MIN_FILMS);
    expect(delRegista.length, `conteggio film mostrato per "${nomeRegista}" non corrisponde`).toBe(Number(filmCountStr));

    const votiDelRegista = delRegista.flatMap(x => x.fan.map(f => Number(f.vote)));
    expect(Number(mediaStr.replace(",", ".")), `media mostrata per "${nomeRegista}" non corrisponde ai voti veri`).toBeCloseTo(media(votiDelRegista), 1);
  }

  // ─── Voto medio più alto ────────────────────────────────────────────────
  if (righe["Voto medio più alto"]) {
    const m = righe["Voto medio più alto"].match(/^(.+) \(([\d,]+)\)$/);
    expect(m, `formato inatteso per "Voto medio più alto": ${righe["Voto medio più alto"]}`).toBeTruthy();
    const [, titoloMostrato, mediaStr] = m!;

    const soglia = sogliaVisti(persone.length);
    const titoloCorrispondente = titoli.find(t => t.title === titoloMostrato);
    expect(titoloCorrispondente, `il titolo "${titoloMostrato}" mostrato non esiste in libreria`).toBeTruthy();

    const votiReali = (votiPerTitolo.get(titoloCorrispondente!.id) ?? []).map(v => Number(v.vote));
    expect(votiReali.length, `"${titoloMostrato}" visto da meno persone della soglia (${soglia} su ${persone.length})`).toBeGreaterThanOrEqual(soglia);
    expect(Number(mediaStr.replace(",", ".")), `media mostrata per "${titoloMostrato}" non corrisponde ai voti veri`).toBeCloseTo(media(votiReali), 1);
  }

  expect(guasti, `guasti:\n${guasti.join("\n")}`).toEqual([]);
  expect(scritture, `la suite ha tentato di scrivere:\n${scritture.join("\n")}`).toEqual([]);
});
