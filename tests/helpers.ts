import { Page, expect } from "@playwright/test";

// Rende la sola lettura una garanzia invece di una promessa: qualunque
// richiesta di SCRITTURA verso Supabase viene bloccata e registrata, e i test
// falliscono se ne e' partita una. Vale anche per le Edge Function del report,
// che scrivono sul database e costano una chiamata a pagamento: oggi si
// rigenerano da sole solo dopo un anno, ma fra un anno il giro automatico
// giornaliero sarebbe esattamente cio' che le innescherebbe.
export function soloLettura(page: Page): string[] {
  const scritture: string[] = [];
  page.route("**/*", route => {
    const richiesta = route.request();
    const metodo = richiesta.method();
    const suSupabase = /supabase\.co/.test(richiesta.url());
    if (suSupabase && !["GET", "HEAD", "OPTIONS"].includes(metodo)) {
      scritture.push(`${metodo} ${richiesta.url().slice(0, 140)}`);
      return route.abort();
    }
    return route.continue();
  });
  return scritture;
}

// Entrare nell'app senza nominare nessuno: si sceglie il primo profilo che il
// selettore propone. Se un domani il gruppo cambia nomi, questi test non se ne
// accorgono nemmeno — ed e' esattamente il punto.
export async function entra(page: Page): Promise<void> {
  // Non e' un 404 dell'app (la home non ne restituisce mai uno): e' il 404
  // nativo di GitHub Pages ("There isn't a GitHub Pages site here"), un
  // routing interno di GitHub che a volte impiega piu' di qualche secondo a
  // risolversi da solo (osservato fino a oltre un'ora). Si riprova con
  // attese crescenti fino a un budget extra di 40s; se il sito e' davvero
  // giu' anche l'ultimo tentativo torna 404 e il test fallisce comunque,
  // come deve — questo non nasconde un sito rotto, allunga solo la pazienza
  // per un blip di GitHub.
  const attese = [3000, 6000, 12000, 19000];
  let risposta = await page.goto("/", { waitUntil: "domcontentloaded" });
  for (const attesa of attese) {
    if (!risposta || risposta.status() !== 404) break;
    await page.waitForTimeout(attesa);
    risposta = await page.goto("/", { waitUntil: "domcontentloaded" });
  }
  const lista = page.locator("#userPickerList button").first();
  await lista.waitFor({ state: "visible", timeout: 30_000 });
  await lista.click();
  await expect(page.locator("#app")).not.toHaveClass(/hidden/, { timeout: 30_000 });
}

export const SCHERMATE = ["home", "stats", "tonight", "report"] as const;

export async function vaiA(page: Page, schermata: string): Promise<void> {
  await page.locator(`.nav__btn[data-screen="${schermata}"]`).click();
  await page.waitForTimeout(500);   // le barre e i numeri si animano
}

// L'invariante che conta davvero sulla barra di navigazione fissa: non che
// nulla la tocchi — a volte e' giusto che il contenuto ci passi sotto — ma che
// si possa sempre ARRIVARE a leggere tutto scorrendo. Scritta cosi' non si
// rompe quando un riquadro cambia altezza.
export async function tuttoRaggiungibile(page: Page): Promise<{ ok: boolean; dettaglio: string }> {
  return page.evaluate(() => {
    const nav = document.querySelector(".bottom-nav");
    const navTop = nav ? nav.getBoundingClientRect().top : window.innerHeight;
    const doc = document.documentElement;
    const scrollDisponibile = doc.scrollHeight - doc.clientHeight;

    // L'ultimo blocco di contenuto della schermata visibile
    const schermata = [...document.querySelectorAll("section")].find(s => !s.classList.contains("hidden"));
    if (!schermata) return { ok: true, dettaglio: "nessuna schermata visibile" };
    const fondo = schermata.getBoundingClientRect().bottom;

    const coperto = Math.max(0, fondo - navTop);
    return {
      ok: coperto <= scrollDisponibile + 1,
      dettaglio: `coperto dalla nav ${Math.round(coperto)}px, scroll disponibile ${Math.round(scrollDisponibile)}px`,
    };
  });
}

// Nessuna barra orizzontale: su un telefono e' sempre un difetto, e non dipende
// da quali elementi ci sono nella pagina.
export async function nienteOverflowOrizzontale(page: Page): Promise<{ ok: boolean; dettaglio: string }> {
  return page.evaluate(() => {
    const doc = document.documentElement;
    return {
      ok: doc.scrollWidth <= doc.clientWidth + 1,
      dettaglio: `scrollWidth ${doc.scrollWidth} vs clientWidth ${doc.clientWidth}`,
    };
  });
}

// Raccoglie i guasti "veri" durante tutta la navigazione: eccezioni JS, errori
// in console e risposte 5xx. I 404 di TMDB (poster mancanti) non contano: sono
// dati altrui e non sono un problema dell'app.
export function osserva(page: Page): string[] {
  const guasti: string[] = [];
  page.on("pageerror", e => guasti.push(`eccezione: ${e.message}`));
  page.on("console", m => {
    if (m.type() === "error" && !m.text().includes("404")) guasti.push(`console: ${m.text().slice(0, 200)}`);
  });
  page.on("response", r => {
    if (r.status() >= 500) guasti.push(`${r.status()} su ${r.url().slice(0, 120)}`);
  });
  return guasti;
}
