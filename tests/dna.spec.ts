import { test, expect } from "@playwright/test";
import { entra, vaiA, tuttoRaggiungibile, osserva, soloLettura } from "./helpers";

// La rete del DNA e' l'unica parte dell'app con una geometria calcolata a mano,
// quindi e' l'unica che puo' rompersi in modi che a occhio non si vedono subito.
// Questi controlli sono sopravvissuti a piu' di una modifica vera: la
// sovrapposizione dei nodi qui sotto ha gia' pescato una regressione che nessuna
// lettura del codice aveva notato.

async function toccaNodo(page: import("@playwright/test").Page, selettore: string): Promise<boolean> {
  const nodo = page.locator(selettore).first();
  if (!(await nodo.count())) return false;
  const box = await nodo.boundingBox();
  if (!box) return false;
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(600);
  return true;
}

// Espande la rete seguendo ogni volta un nodo nuovo, senza mai richiudere
// quello attivo (un secondo tap sul nodo attivo lo chiude).
async function esplora(page: import("@playwright/test").Page, passi: number): Promise<void> {
  await toccaNodo(page, ".dna-node.is-root");
  const visti = new Set<string>();
  for (let i = 0; i < passi; i++) {
    const prossimo = await page.evaluate((giaVisti: string[]) => {
      const attivo = document.querySelector<HTMLElement>(".dna-node.is-focus")?.dataset.node;
      return [...document.querySelectorAll<HTMLElement>(".dna-node")]
        .map(n => n.dataset.node!)
        .find(id => id !== attivo && !giaVisti.includes(id));
    }, [...visti]);
    if (!prossimo) break;
    visti.add(prossimo);
    if (!(await toccaNodo(page, `[data-node="${prossimo}"]`))) break;
  }
}

test("esplorando la rete i nodi non si sovrappongono mai", async ({ page }) => {
  const guasti = osserva(page);
  const scritture = soloLettura(page);
  await entra(page);
  await vaiA(page, "tonight");
  await page.locator("#dnaNodes .dna-node").first().waitFor({ state: "visible", timeout: 30_000 });

  await esplora(page, 6);

  const misura = await page.evaluate(() => {
    const riquadri = (sel: string) => [...document.querySelectorAll(sel)].map(e => e.getBoundingClientRect());
    const sovrapposti = (a: DOMRect, b: DOMRect) =>
      !(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top);
    const conta = (lista: DOMRect[]) => {
      let n = 0;
      for (let i = 0; i < lista.length; i++) for (let j = i + 1; j < lista.length; j++) if (sovrapposti(lista[i], lista[j])) n++;
      return n;
    };
    const nodi = riquadri(".dna-node");
    const attivo = document.querySelector(".dna-node.is-focus")?.getBoundingClientRect();
    const palco = document.getElementById("dnaStage")!.getBoundingClientRect();
    return {
      nodi: nodi.length,
      nodiSovrapposti: conta(nodi),
      etichetteSovrapposte: conta(riquadri(".dna-node__label")),
      attivoInQuadro: !!attivo && attivo.left >= palco.left && attivo.right <= palco.right
        && attivo.top >= palco.top && attivo.bottom <= palco.bottom,
    };
  });

  expect(misura.nodi, "la rete non si e' aperta").toBeGreaterThan(1);
  expect(misura.nodiSovrapposti, `${misura.nodiSovrapposti} coppie di nodi sovrapposte su ${misura.nodi} nodi`).toBe(0);
  expect(misura.etichetteSovrapposte, "etichette dei nodi sovrapposte").toBe(0);
  expect(misura.attivoInQuadro, "il nodo attivo e' finito fuori dall'inquadratura").toBe(true);

  const raggiungibile = await tuttoRaggiungibile(page);
  expect(raggiungibile.ok, `il pannello del DNA resta irraggiungibile (${raggiungibile.dettaglio})`).toBe(true);

  expect(guasti, `guasti esplorando il DNA:\n${guasti.join("\n")}`).toEqual([]);
  expect(scritture, `la suite ha tentato di scrivere:\n${scritture.join("\n")}`).toEqual([]);
});

test("toccare un nodo aggiorna sempre il pannello", async ({ page }) => {
  const scritture = soloLettura(page);
  await entra(page);
  await vaiA(page, "tonight");
  await page.locator("#dnaNodes .dna-node").first().waitFor({ state: "visible", timeout: 30_000 });

  await toccaNodo(page, ".dna-node.is-root");
  const altri = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>(".dna-node")]
      .filter(n => !n.classList.contains("is-focus"))
      .map(n => n.dataset.node!));
  expect(altri.length, "il primo tocco non ha aperto nessun ramo").toBeGreaterThan(0);

  // Il nodo toccato diventa quello descritto dal pannello: e' il patto base
  // della schermata, e il punto in cui si e' gia' rotta una volta (un nodo che
  // si spostava sotto il dito prima che il tocco venisse registrato).
  await toccaNodo(page, `[data-node="${altri[0]}"]`);
  const dopo = await page.evaluate(() => ({
    attivo: document.querySelector<HTMLElement>(".dna-node.is-focus")?.dataset.node,
    pannello: (document.getElementById("dnaPanel")?.textContent ?? "").trim().length,
  }));
  expect(dopo.attivo, "il nodo toccato non e' diventato quello attivo").toBe(altri[0]);
  expect(dopo.pannello, "il pannello e' rimasto vuoto").toBeGreaterThan(0);
});

async function selezionaPersone(page: import("@playwright/test").Page, nomi: string[]): Promise<void> {
  await page.locator("#dnaPeopleBtn").click();
  for (const nome of nomi) {
    await page.locator(`#dnaPeopleList .dna-sheet__row[data-user="${nome}"]`).click();
  }
  await page.locator("#dnaPeopleDoneBtn").click();
  await page.locator("#dnaNodes .dna-node").first().waitFor({ state: "visible", timeout: 30_000 });
}

// L'alone dorato dei "molto amati" (vedi lovedLevel in dna-view.js) e l'anello
// verde dei punti d'incontro (isMeetingPoint) raccontano due cose diverse e
// non devono mai accendersi sullo stesso nodo: il primo vale fuori dalla
// modalita' condivisa, il secondo solo dentro (2-3 persone selezionate).
test("l'alone dorato dei molto amati e l'anello verde dei punti d'incontro non compaiono mai insieme", async ({ page }) => {
  const guasti = osserva(page);
  const scritture = soloLettura(page);
  await entra(page);
  await vaiA(page, "tonight");
  await page.locator("#dnaNodes .dna-node").first().waitFor({ state: "visible", timeout: 30_000 });

  await page.locator("#dnaPeopleBtn").click();
  const persone = await page.locator("#dnaPeopleList .dna-sheet__row[data-user]").evaluateAll(
    els => els.map(e => e.getAttribute("data-user")).filter((u): u is string => !!u && u !== "*")
  );
  await page.locator("#dnaPeopleDoneBtn").click();
  test.skip(persone.length < 4, "serve un gruppo di almeno 4 persone per verificare entrambe le modalita'");

  // 2 persone: modalita' condivisa stretta. L'alone dorato non deve comparire.
  await selezionaPersone(page, [persone[0], persone[1]]);
  await esplora(page, 8);
  const condivisa = await page.evaluate(() => ({
    loved: document.querySelectorAll(".dna-node.is-loved-1, .dna-node.is-loved-2").length,
  }));
  expect(condivisa.loved, "l'alone dorato non deve comparire con 2 persone selezionate").toBe(0);

  // 4 persone: fuori dalla modalita' condivisa. L'anello verde deve sparire,
  // e in nessun momento i due segnali devono coincidere sullo stesso nodo.
  await selezionaPersone(page, [persone[2], persone[3]]);
  await esplora(page, 8);
  const fuori = await page.evaluate(() => ({
    shared: document.querySelectorAll(".dna-node.is-shared").length,
    lovedEShared: document.querySelectorAll(
      ".dna-node.is-loved-1.is-shared, .dna-node.is-loved-2.is-shared"
    ).length,
  }));
  expect(fuori.shared, "l'anello verde non deve comparire con 4 persone selezionate").toBe(0);
  expect(fuori.lovedEShared, "alone dorato e anello verde non devono mai comparire sullo stesso nodo").toBe(0);

  expect(guasti, `guasti esplorando il DNA:\n${guasti.join("\n")}`).toEqual([]);
  expect(scritture, `la suite ha tentato di scrivere:\n${scritture.join("\n")}`).toEqual([]);
});

// Il tasto "vedi tutta la rete" (vedi updateViewAllButton in dna-view.js)
// deve comparire solo dove ha senso — modalita' condivisa (2-3 persone) e
// rete gia' grande — e aprendolo deve mostrare DAVVERO tutti i nodi aperti,
// non un sottoinsieme: e' il punto per cui questa vista esiste (vedi
// openFullNetworkView, che ridisegna l'intera rete con le stesse funzioni
// del render live, senza il budget DOM).
test("il tasto vedi tutta la rete compare solo in modalita' condivisa con rete grande, e mostra ogni nodo aperto", async ({ page }) => {
  const guasti = osserva(page);
  const scritture = soloLettura(page);
  await entra(page);
  await vaiA(page, "tonight");
  await page.locator("#dnaNodes .dna-node").first().waitFor({ state: "visible", timeout: 30_000 });

  // "Tutti" (nessun filtro): anche con una rete grande il tasto non deve comparire.
  await esplora(page, 10);
  await expect(page.locator("#dnaViewAllBtn")).toHaveClass(/hidden/);

  await page.locator("#dnaPeopleBtn").click();
  const persone = await page.locator("#dnaPeopleList .dna-sheet__row[data-user]").evaluateAll(
    els => els.map(e => e.getAttribute("data-user")).filter((u): u is string => !!u && u !== "*")
  );
  await page.locator("#dnaPeopleDoneBtn").click();
  test.skip(persone.length < 2, "serve un gruppo di almeno 2 persone");

  // Modalita' condivisa ma rete appena ricostruita (un solo nodo): ancora nascosto.
  await selezionaPersone(page, [persone[0], persone[1]]);
  await expect(page.locator("#dnaViewAllBtn")).toHaveClass(/hidden/);

  // Sopra soglia: compare.
  await esplora(page, 10);
  await expect(page.locator("#dnaViewAllBtn")).not.toHaveClass(/hidden/);

  const nodiAperti = await page.evaluate(() => document.querySelectorAll("#dnaNodes .dna-node").length);

  await page.locator("#dnaViewAllBtn").click();
  await expect(page.locator("#dnaFullView")).not.toHaveClass(/hidden/);
  await page.locator("#dnaFullNodes .dna-node").first().waitFor({ state: "visible" });

  // La vista live ha un budget (MAX_DOM_NODES/DOM_MAX_HOPS): la vista
  // completa non deve averne — deve mostrare almeno quanti nodi mostra già
  // la vista live, e nella pratica normalmente di più (root compreso, che il
  // budget live potrebbe aver escluso se lontano dalla camera).
  const nodiNellaVistaCompleta = await page.evaluate(() => document.querySelectorAll("#dnaFullNodes .dna-node").length);
  expect(nodiNellaVistaCompleta, "la vista completa mostra meno nodi della vista live").toBeGreaterThanOrEqual(nodiAperti);

  // Le locandine sono quelle vere (stesso meccanismo dello schermo normale:
  // background-image su .dna-node__poster), non un segnaposto.
  const conLocandina = await page.evaluate(() =>
    [...document.querySelectorAll("#dnaFullNodes .dna-node__poster")]
      .filter(p => (p as HTMLElement).style.backgroundImage.includes("image.tmdb.org")).length
  );
  expect(conLocandina, "nessuna locandina vera nella vista completa").toBeGreaterThan(0);

  await page.locator("#dnaFullViewCloseBtn").click();
  await expect(page.locator("#dnaFullView")).toHaveClass(/hidden/);

  expect(guasti, `guasti aprendo la vista completa:\n${guasti.join("\n")}`).toEqual([]);
  expect(scritture, `la suite ha tentato di scrivere:\n${scritture.join("\n")}`).toEqual([]);
});
