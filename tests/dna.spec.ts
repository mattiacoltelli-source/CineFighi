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
  // Un dito tocca un nodo FERMO: dopo un cambio di persone o un'apertura la
  // camera si sta ancora muovendo, e leggere la posizione a meta' corsa fa
  // cadere il tap dove il nodo non c'e' piu' (flake ~1 volta su 10: la rete
  // restava al solo nodo radice e il test vedeva "tasto nascosto"). Si aspetta
  // che due letture a 100ms di distanza coincidano.
  let box = await nodo.boundingBox();
  for (let i = 0; i < 20 && box; i++) {
    await page.waitForTimeout(100);
    const dopo = await nodo.boundingBox();
    if (!dopo) return false;
    const fermo = Math.abs(dopo.x - box.x) < 1 && Math.abs(dopo.y - box.y) < 1;
    box = dopo;
    if (fermo) break;
  }
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
      // Solo nodi davvero toccabili: uno finito sotto un controllo
      // fluttuante (es. il tasto "vedi tutta la rete") non riceverebbe il tap
      // di un dito, quindi non e' un passo di esplorazione valido.
      const toccabile = (n: HTMLElement) => {
        const r = n.getBoundingClientRect();
        const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return !!top && n.contains(top);
      };
      return [...document.querySelectorAll<HTMLElement>("#dnaNodes .dna-node")]
        .filter(toccabile)
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

// Aprendo una persona la prima volta si vede "chi e'": al massimo 1 genere,
// 2 registi e 1 attore (quote di PERSON_OPENING in dna.js), il resto film.
// Niente di piu' (la rete non si riempie di nomi) e mai quasi vuota: chi non
// ha un attore o ha pochi registi ha i film al loro posto.
test("la prima apertura di una persona mostra genere, registi e attore senza sforare le quote", async ({ page }) => {
  const guasti = osserva(page);
  const scritture = soloLettura(page);
  await entra(page);
  await vaiA(page, "tonight");
  await page.locator("#dnaNodes .dna-node").first().waitFor({ state: "visible", timeout: 30_000 });

  await toccaNodo(page, ".dna-node.is-root");
  const tipi = await page.evaluate(() => {
    const conta: Record<string, number> = {};
    for (const n of document.querySelectorAll<HTMLElement>("#dnaNodes .dna-node:not(.is-root)")) {
      const tipo = [...n.classList].find(c => c.startsWith("dna-node--"))?.slice("dna-node--".length) ?? "?";
      conta[tipo] = (conta[tipo] || 0) + 1;
    }
    return conta;
  });
  const totale = Object.values(tipi).reduce((a, b) => a + b, 0);

  expect(totale, `prima apertura quasi vuota: ${JSON.stringify(tipi)}`).toBeGreaterThanOrEqual(3);
  // Chi ha film amati ha sempre un genere piu' amato: deve esserci, uno solo.
  expect(tipi.genere ?? 0, `il genere piu' amato manca o e' piu' di uno: ${JSON.stringify(tipi)}`).toBe(1);
  expect(tipi.regista ?? 0, `troppi registi: ${JSON.stringify(tipi)}`).toBeLessThanOrEqual(2);
  expect(tipi.attore ?? 0, `troppi attori: ${JSON.stringify(tipi)}`).toBeLessThanOrEqual(1);
  expect(guasti, `guasti:\n${guasti.join("\n")}`).toEqual([]);
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
// dipende SOLO da quanto e' grande la rete, non da quante persone sono
// selezionate: vale con "Tutti", con una persona sola, con due, con cinque.
// Aprendolo deve mostrare DAVVERO tutti i nodi aperti, non un sottoinsieme:
// e' il punto per cui questa vista esiste (vedi openFullNetworkView, che
// ridisegna l'intera rete con le stesse funzioni del render live, senza il
// budget DOM).
// "Ingrandita" (la vista di "Tutta la rete" all'apertura) e' piu' grande del
// riquadro e si scorre. Partiva dall'angolo in alto a sinistra, spesso vuoto
// perche' la rete si allunga in diagonale: ora si apre centrata sul baricentro
// dei nodi. L'invariante: il baricentro sta al centro del riquadro (oppure lo
// scorrimento e' arrivato a un bordo, dove il browser non puo' andare oltre).
test("la vista ingrandita di tutta la rete si apre centrata sui nodi", async ({ page }) => {
  const guasti = osserva(page);
  await entra(page);
  await vaiA(page, "tonight");
  await page.locator("#dnaNodes .dna-node").first().waitFor({ state: "visible", timeout: 30_000 });

  await esplora(page, 10);
  await page.locator("#dnaViewAllBtn").click();
  await expect(page.locator("#dnaFullView")).not.toHaveClass(/hidden/);
  await page.locator("#dnaFullNodes .dna-node").first().waitFor({ state: "visible" });
  await page.waitForTimeout(400);

  const m = await page.evaluate(() => {
    const scroll = document.querySelector<HTMLElement>(".dna-full-view__scroll")!;
    const box = scroll.getBoundingClientRect();
    const nodi = [...document.querySelectorAll("#dnaFullNodes .dna-node")].map(n => n.getBoundingClientRect());
    const cx = nodi.reduce((a, r) => a + r.left + r.width / 2, 0) / nodi.length;
    const cy = nodi.reduce((a, r) => a + r.top + r.height / 2, 0) / nodi.length;
    const dx = Math.round(cx - (box.left + box.width / 2));
    const dy = Math.round(cy - (box.top + box.height / 2));
    // Bloccato dal bordo solo se per centrare serve scorrere NELLA direzione
    // in cui non si puo' piu' andare (baricentro a destra: serve scorrere a
    // destra, e si e' gia' in fondo). Fermo a 0 con il baricentro a destra
    // non e' un bordo: e' non aver scorso.
    const bloccato = (d: number, pos: number, max: number) => (d > 0 && pos >= max - 1) || (d < 0 && pos <= 1);
    return {
      dx, dy,
      xClampata: bloccato(dx, scroll.scrollLeft, scroll.scrollWidth - scroll.clientWidth),
      yClampata: bloccato(dy, scroll.scrollTop, scroll.scrollHeight - scroll.clientHeight),
    };
  });
  expect(Math.abs(m.dx) <= 40 || m.xClampata, `baricentro fuori centro in orizzontale di ${m.dx}px`).toBe(true);
  expect(Math.abs(m.dy) <= 40 || m.yClampata, `baricentro fuori centro in verticale di ${m.dy}px`).toBe(true);
  expect(guasti, `guasti:\n${guasti.join("\n")}`).toEqual([]);
});

// "Adatta" scala la rete in modo uniforme: una rete alta e stretta lasciava
// bande vuote ai lati. Ora i nodi si allargano lungo l'asse corto fino alla
// forma dello schermo (al massimo 1,6x, senza deformare i nodi). L'invariante:
// la rete occupa buona parte del riquadro in entrambe le direzioni, e la
// legenda degli archi (letta dagli archi disegnati) resta al suo posto.
test("la vista adatta riempie lo schermo e mantiene la legenda", async ({ page }) => {
  const guasti = osserva(page);
  await entra(page);
  await vaiA(page, "tonight");
  await page.locator("#dnaNodes .dna-node").first().waitFor({ state: "visible", timeout: 30_000 });

  await esplora(page, 12);
  await page.locator("#dnaViewAllBtn").click();
  await page.locator('#dnaFullViewZoom [data-zoom="fit"]').click();
  await page.locator("#dnaFullNodes .dna-node").first().waitFor({ state: "visible" });
  await page.waitForTimeout(500);

  const m = await page.evaluate(() => {
    const box = document.querySelector(".dna-full-view__scroll")!.getBoundingClientRect();
    const r = [...document.querySelectorAll("#dnaFullNodes .dna-node")].map(n => n.getBoundingClientRect());
    const l = Math.min(...r.map(x => x.left)), rt = Math.max(...r.map(x => x.right));
    const t = Math.min(...r.map(x => x.top)), b = Math.max(...r.map(x => x.bottom));
    return {
      larghezza: Math.round((rt - l) / box.width * 100),
      altezza: Math.round((b - t) / box.height * 100),
      legenda: !!document.querySelector("#dnaFullViewStats .dna-full-legend"),
      archi: document.querySelectorAll("#dnaFullEdges .dna-edge").length,
    };
  });
  expect(m.archi, "la vista completa non ha disegnato archi").toBeGreaterThan(0);
  expect(m.legenda, "la legenda degli archi e' sparita").toBe(true);
  expect(Math.max(m.larghezza, m.altezza), `rete troppo piccola nel riquadro: ${JSON.stringify(m)}`).toBeGreaterThanOrEqual(85);
  expect(Math.min(m.larghezza, m.altezza), `una direzione e' quasi vuota: ${JSON.stringify(m)}`).toBeGreaterThanOrEqual(60);
  expect(guasti, `guasti:\n${guasti.join("\n")}`).toEqual([]);
});

test("il tasto vedi tutta la rete compare con rete grande in ogni modalita', e mostra ogni nodo aperto", async ({ page }) => {
  const guasti = osserva(page);
  const scritture = soloLettura(page);
  await entra(page);
  await vaiA(page, "tonight");
  await page.locator("#dnaNodes .dna-node").first().waitFor({ state: "visible", timeout: 30_000 });

  // Rete appena costruita (un solo nodo): sotto soglia, nascosto.
  await expect(page.locator("#dnaViewAllBtn")).toHaveClass(/hidden/);

  // "Tutti" (nessun filtro) con una rete grande: deve comparire.
  await esplora(page, 10);
  await expect(page.locator("#dnaViewAllBtn")).not.toHaveClass(/hidden/);

  await page.locator("#dnaPeopleBtn").click();
  const persone = await page.locator("#dnaPeopleList .dna-sheet__row[data-user]").evaluateAll(
    els => els.map(e => e.getAttribute("data-user")).filter((u): u is string => !!u && u !== "*")
  );
  await page.locator("#dnaPeopleDoneBtn").click();
  test.skip(persone.length < 2, "serve un gruppo di almeno 2 persone");

  // Cambiando selezione la rete riparte da un nodo solo: torna sotto soglia.
  await selezionaPersone(page, [persone[0], persone[1]]);
  await expect(page.locator("#dnaViewAllBtn")).toHaveClass(/hidden/);

  // Sopra soglia: compare di nuovo.
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

  // Qui la sfumatura per distanza dal nodo attivo non deve applicarsi: in una
  // foto della rete intera nasconderebbe meta' dei nodi per un motivo (dov'era
  // la camera) che nella foto non esiste piu'.
  const opacitaMinima = await page.evaluate(() =>
    Math.min(...[...document.querySelectorAll("#dnaFullNodes .dna-node")]
      .map(n => parseFloat(getComputedStyle(n as HTMLElement).opacity)))
  );
  expect(opacitaMinima, "nella vista completa restano nodi sbiaditi dalla distanza").toBeGreaterThan(0.7);

  // Le righe di numeri sotto la rete: con 2 persone ci sono anche le due
  // righe "in comune", quindi almeno tre.
  const righeStat = await page.locator("#dnaFullViewStats .dna-full-stats__row").count();
  expect(righeStat, "mancano le righe di statistiche sotto la rete").toBeGreaterThanOrEqual(3);

  // La legenda deve dire esattamente quello che c'e' nell'immagine: mai una
  // voce per un colore non disegnato (con 4 persone selezionate, per dire,
  // non c'e' ne' verde ne' oro), e mai un colore disegnato senza la sua voce.
  // Scritta come uguaglianza, quindi vale in qualunque modalita'.
  const legenda = await page.evaluate(() => ({
    verdeInLegenda: !!document.querySelector(".dna-full-legend__voce i.is-shared"),
    verdeNegliArchi: !!document.querySelector("#dnaFullEdges .dna-edge--ama.is-shared"),
    oroInLegenda: !!document.querySelector(".dna-full-legend__voce i.is-loved"),
    oroNegliArchi: !!document.querySelector("#dnaFullEdges .dna-edge--ama.is-loved-2"),
    voci: document.querySelectorAll(".dna-full-legend__voce").length,
  }));
  expect(legenda.voci, "manca la legenda degli archi").toBeGreaterThan(0);
  expect(legenda.verdeInLegenda, "la legenda non combacia con gli archi verdi disegnati").toBe(legenda.verdeNegliArchi);
  expect(legenda.oroInLegenda, "la legenda non combacia con gli archi oro disegnati").toBe(legenda.oroNegliArchi);

  // "Adatta" ha una promessa sola: tutto dentro una schermata. Si verifica
  // sulla cosa che conta davvero — nessuno scorrimento residuo — non sul
  // fattore di scala, che dipende da quanto e' grande la rete del gruppo.
  await page.locator('#dnaFullViewZoom [data-zoom="fit"]').click();
  const adattata = await page.evaluate(() => {
    const s = document.querySelector(".dna-full-view__scroll")!;
    return { scorrimentoX: s.scrollWidth - s.clientWidth, scorrimentoY: s.scrollHeight - s.clientHeight };
  });
  expect(adattata.scorrimentoX, "in 'Adatta' resta da scorrere in orizzontale").toBeLessThanOrEqual(1);
  expect(adattata.scorrimentoY, "in 'Adatta' resta da scorrere in verticale").toBeLessThanOrEqual(1);

  // "Adatta" e' il caso peggiore per gli archi: la scala e' la piu' piccola,
  // e uno spessore che la segue in modo lineare finirebbe sotto il pixel —
  // dove l'antialiasing lo spegne e la rete resta senza collegamenti
  // visibili. Si misura lo spessore EFFETTIVO a schermo (nominale x scala).
  const tratti = await page.evaluate(() => {
    const canvas = document.getElementById("dnaFullCanvas")!;
    const scala = Number((canvas.style.transform.match(/scale\(([\d.]+)\)/) || [])[1] || 1);
    const spessori = [...document.querySelectorAll("#dnaFullEdges .dna-edge")]
      .map(e => parseFloat(getComputedStyle(e).strokeWidth) * scala);
    return { minimo: Math.min(...spessori), quanti: spessori.length };
  });
  expect(tratti.quanti, "nessun arco disegnato nella vista completa").toBeGreaterThan(0);
  expect(tratti.minimo, "archi troppo sottili per vedersi nello screenshot").toBeGreaterThanOrEqual(1);

  // Tornando a "Ingrandita" i nodi restano tutti li': cambia solo lo zoom.
  await page.locator('#dnaFullViewZoom [data-zoom="fill"]').click();
  const dopoRitorno = await page.evaluate(() => document.querySelectorAll("#dnaFullNodes .dna-node").length);
  expect(dopoRitorno, "cambiando zoom si sono persi dei nodi").toBe(nodiNellaVistaCompleta);

  await page.locator("#dnaFullViewCloseBtn").click();
  await expect(page.locator("#dnaFullView")).toHaveClass(/hidden/);

  expect(guasti, `guasti aprendo la vista completa:\n${guasti.join("\n")}`).toEqual([]);
  expect(scritture, `la suite ha tentato di scrivere:\n${scritture.join("\n")}`).toEqual([]);
});

// Piatto/Spaziale: le due viste disegnano la STESSA rete. Passando da una
// all'altra non si perde niente di quello che si è aperto, il tocco apre i
// rami anche nella vista spaziale, e la scelta resta sul dispositivo.
test("la vista spaziale mostra la stessa rete e si torna al piatto senza perdere niente", async ({ page }) => {
  const scritture = soloLettura(page);
  const guasti = osserva(page);
  await entra(page);
  await vaiA(page, "tonight");
  await page.locator("#dnaNodes .dna-node").first().waitFor({ state: "visible", timeout: 30_000 });

  await page.locator('#dnaViewToggle [data-dna-view="spatial"]').click();
  await expect(page.locator("#dnaSpatial")).not.toHaveClass(/hidden/);
  await expect(page.locator("#dnaCanvas")).toHaveClass(/hidden/);
  await page.locator("#dnaSpatial .dna-node.is-root").waitFor({ state: "visible" });

  // Il tocco apre i rami anche qui (stessa logica: tapNode in dna-view.js).
  await toccaNodo(page, "#dnaSpatial .dna-node.is-root");
  const aperti = await page.locator("#dnaSpatial .dna-node").count();
  expect(aperti, "nella vista spaziale il tocco non ha aperto nessun ramo").toBeGreaterThan(1);

  const vicino = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>("#dnaSpatial .dna-node")]
      .find(n => !n.classList.contains("is-focus") && n.style.display !== "none")?.dataset.node);
  expect(vicino, "nessun vicino visibile nella vista spaziale").toBeTruthy();
  await toccaNodo(page, `#dnaSpatial [data-node="${vicino}"]`);
  await expect(page.locator("#dnaSpatial .dna-node.is-focus")).toHaveAttribute("data-node", vicino!);
  const nodiRete = await page.locator("#dnaSpatial .dna-node").count();

  // La scelta resta sul dispositivo: riaprendo l'app si riparte in Spaziale.
  // La rete invece riparte da capo: rifaccio lo stesso percorso (stesso
  // motore, deterministico) e confronto i nodi con quelli di prima.
  // (L'utente è già ricordato: dopo il reload l'app entra da sola.)
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator("#app")).not.toHaveClass(/hidden/, { timeout: 30_000 });
  await vaiA(page, "tonight");
  await page.locator("#dnaSpatial .dna-node.is-root").waitFor({ state: "visible", timeout: 30_000 });
  await toccaNodo(page, "#dnaSpatial .dna-node.is-root");
  await toccaNodo(page, `#dnaSpatial [data-node="${vicino}"]`);
  expect(await page.locator("#dnaSpatial .dna-node").count(), "stesso percorso, rete diversa").toBe(nodiRete);

  await page.locator('#dnaViewToggle [data-dna-view="flat"]').click();
  await expect(page.locator("#dnaSpatial")).toHaveClass(/hidden/);
  await expect(page.locator("#dnaNodes .dna-node.is-focus")).toHaveAttribute("data-node", vicino!);
  const piatti = await page.locator("#dnaNodes .dna-node").count();
  expect(piatti, "tornando al piatto la rete aperta e' sparita").toBeGreaterThan(1);
  expect(await page.locator("#dnaSpatial .dna-node").count(), "la vista spaziale nascosta tiene ancora i nodi").toBe(0);

  expect(guasti, `guasti nella vista spaziale:\n${guasti.join("\n")}`).toEqual([]);
  expect(scritture, `la suite ha tentato di scrivere:\n${scritture.join("\n")}`).toEqual([]);
});

// "+N" della vista spaziale: un nodo aperto con altri collegamenti non
// mostrati lo dice, e un tocco sul pallino ne apre altri SENZA richiudere il
// nodo (il tocco sul nodo resta apri/richiudi). Il pannello spaziale parla
// del legame con chi guardi, non del solo nodo.
test("vista spaziale: il +N apre altri collegamenti e il pannello racconta il legame", async ({ page }) => {
  const scritture = soloLettura(page);
  const guasti = osserva(page);
  await entra(page);
  await vaiA(page, "tonight");
  await page.locator('#dnaViewToggle [data-dna-view="spatial"]').click();
  await page.locator("#dnaSpatial .dna-node.is-root").waitFor({ state: "visible", timeout: 30_000 });
  await toccaNodo(page, "#dnaSpatial .dna-node.is-root");

  const piu = page.locator("#dnaSpatial .dna-node.is-root .dna-node__more");
  await expect(piu, "la radice aperta non mostra il +N").toHaveCount(1);
  const prima = await page.locator("#dnaSpatial .dna-node").count();
  await piu.evaluate(b => (b as HTMLElement).click());
  await page.waitForTimeout(800);
  expect(await page.locator("#dnaSpatial .dna-node").count(), "il +N non ha aperto altri nodi").toBeGreaterThan(prima);
  await expect(page.locator("#dnaSpatial .dna-node.is-root"), "il +N ha richiuso il nodo").toHaveClass(/is-open/);

  // Pannello: a schermo intero nasce chiuso, si apre toccando il titolo.
  await page.locator("#dnaPanelPeek").click();
  await expect(page.locator("#dnaPanel")).toContainText("più titoli in comune");

  expect(guasti, `guasti nella vista spaziale:\n${guasti.join("\n")}`).toEqual([]);
  expect(scritture, `la suite ha tentato di scrivere:\n${scritture.join("\n")}`).toEqual([]);
});

// Il tocco sul nodo attivo apre ciò che c'è ancora da aprire e richiude solo
// quando non resta niente; chi ha sempre altro (la persona di partenza) si
// richiude dal "Richiudi" nel pannello. Stessa dinamica in tutte e due le viste.
for (const vista of ["flat", "spatial"] as const) {
  test(`vista ${vista}: il secondo tocco sul nodo attivo ne apre altri, il Richiudi nella barra lo chiude`, async ({ page }) => {
    const scritture = soloLettura(page);
    const guasti = osserva(page);
    await entra(page);
    await vaiA(page, "tonight");
    if (vista === "spatial") await page.locator('#dnaViewToggle [data-dna-view="spatial"]').click();
    const nodi = vista === "spatial" ? "#dnaSpatial .dna-node" : "#dnaNodes .dna-node";
    await page.locator(`${nodi}.is-root`).waitFor({ state: "visible", timeout: 30_000 });

    await toccaNodo(page, `${nodi}.is-root`);
    const dopoPrimo = await page.locator(nodi).count();
    expect(dopoPrimo, "il primo tocco non ha aperto niente").toBeGreaterThan(1);

    // La radice ha centinaia di collegamenti: un altro tocco ne apre altri, NON richiude.
    await toccaNodo(page, `${nodi}.is-root`);
    const dopoSecondo = await page.locator(nodi).count();
    expect(dopoSecondo, "il secondo tocco ha richiuso invece di aprire altri collegamenti").toBeGreaterThan(dopoPrimo);
    await expect(page.locator(`${nodi}.is-root`)).toHaveClass(/is-open/);

    // Il segno "+" è sul nodo, in entrambe le viste.
    await expect(page.locator(`${nodi}.is-root .dna-node__more`)).toHaveCount(1);

    // Richiudere: "Richiudi" è nella barra del titolo, sempre visibile sul nodo
    // aperto (un tocco solo, senza aprire il pannello).
    await page.locator("#dnaPanel .dna-panel__richiudi-bar").click();
    await page.waitForTimeout(600);
    await expect(page.locator(`${nodi}.is-root`)).not.toHaveClass(/is-open/);
    expect(await page.locator(nodi).count(), "il Richiudi non ha chiuso i rami").toBeLessThan(dopoSecondo);

    expect(guasti, `guasti:\n${guasti.join("\n")}`).toEqual([]);
    expect(scritture, `la suite ha tentato di scrivere:\n${scritture.join("\n")}`).toEqual([]);
  });
}

// Il pannello è uguale nelle due viste e non ripete ciò che sta nella scheda
// (regia, cast, generi, anno): quelli ora sono in alto nella scheda del film.
test("il pannello e' lo stesso nelle due viste e la scheda mostra regia, cast e generi in alto", async ({ page }) => {
  const scritture = soloLettura(page);
  const guasti = osserva(page);
  await entra(page);
  await vaiA(page, "tonight");
  await page.locator("#dnaNodes .dna-node.is-root").waitFor({ state: "visible", timeout: 30_000 });
  await toccaNodo(page, "#dnaNodes .dna-node.is-root");

  // Pannello della radice, vista piatta: "con chi hai più titoli in comune", non più generi/registi ricorrenti.
  await page.locator("#dnaPanelPeek").click();
  await expect(page.locator("#dnaPanel")).toContainText("più titoli in comune");
  await expect(page.locator("#dnaPanel")).not.toContainText("Registi ricorrenti");
  await page.locator("#dnaPanelPeek").click();

  // Un film: il pannello ha il percorso e chi l'ha amato, senza frasi in più.
  const film = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>("#dnaNodes .dna-node--film")][0]?.dataset.node);
  expect(film, "nessun film nella rete").toBeTruthy();
  await toccaNodo(page, `#dnaNodes [data-node="${film}"]`);
  await page.locator("#dnaPanelPeek").click();
  await expect(page.locator("#dnaPanel")).toContainText("Il tuo percorso");
  await expect(page.locator("#dnaPanel")).toContainText("Chi l'ha amato");
  await expect(page.locator("#dnaPanel")).not.toContainText("Non è tra i tuoi amati");
  await expect(page.locator("#dnaPanel")).not.toContainText("Lo ami anche tu");

  // La scheda: regia/cast/generi in alto, niente più card "Dati" in fondo.
  await page.evaluate(() => (document.querySelector("#dnaPanel .open-detail") as HTMLElement).click());
  await expect(page.locator("#detailTitle")).not.toHaveText("Titolo");
  await expect(page.locator("#detailCredits .detail-fact").first()).toBeAttached();
  await expect(page.locator("#detailFacts")).toHaveCount(0);

  // Stile coerente con il resto dell'app: etichette come i titoli delle card
  // (Outfit, grassetto), anno e valori alla stessa grandezza, e una riga a capo
  // allineata al valore, non all'etichetta.
  const stile = await page.evaluate(() => {
    const css = (e: Element) => getComputedStyle(e);
    const lab = document.querySelector("#detailCredits .detail-credit__l");
    const titoloCard = document.querySelector(".detail-card__title");
    const anno = document.getElementById("detailYear")!;
    const val = document.querySelector("#detailCredits .detail-credit > span:not(.detail-credit__l)");
    return {
      etichettaUgualeAlTitoloCard: !!lab && !!titoloCard && ["fontFamily", "fontSize", "fontWeight", "letterSpacing", "textTransform"].every(k => (css(lab) as any)[k] === (css(titoloCard) as any)[k]),
      annoEValoreStessaGrandezza: !!val && css(anno).fontSize === css(val).fontSize,
    };
  });
  expect(stile.etichettaUgualeAlTitoloCard, "le etichette Regia/Con non hanno lo stile dei titoli delle card").toBe(true);
  expect(stile.annoEValoreStessaGrandezza, "anno e regia/cast non hanno la stessa grandezza").toBe(true);
  // Una riga a capo (cast lungo) resta nella colonna del valore.
  const allineato = await page.evaluate(() => {
    const v = document.querySelector("#detailCredits .detail-credit > span:not(.detail-credit__l)") as HTMLElement;
    v.textContent = "Nome Cognome Molto Lungo, Altro Nome Cognome Lungo, Un Terzo Attore Con Nome Lungo, Quarto Attore Con Nome Lungo";
    const r = document.createRange(); r.selectNodeContents(v);
    const lefts = new Set([...r.getClientRects()].map(x => Math.round(x.left)));
    return { righe: Math.round(v.getBoundingClientRect().height / parseFloat(getComputedStyle(v).lineHeight)), lefts: lefts.size };
  });
  expect(allineato.righe, "la prova non è andata a capo").toBeGreaterThan(1);
  expect(allineato.lefts, "la riga a capo non è allineata al valore").toBe(1);

  expect(guasti, `guasti:\n${guasti.join("\n")}`).toEqual([]);
  expect(scritture, `la suite ha tentato di scrivere:\n${scritture.join("\n")}`).toEqual([]);
});

// Il percorso è la strada che hai FATTO (i nodi toccati), non il collegamento
// più corto: con i ponti fra rami quello è quasi sempre più breve di quello
// che si è percorso davvero.
for (const vista of ["flat", "spatial"] as const) {
  test(`vista ${vista}: il percorso e' la strada fatta e i passaggi si toccano per tornare indietro`, async ({ page }) => {
    const scritture = soloLettura(page);
    const guasti = osserva(page);
    await entra(page);
    await vaiA(page, "tonight");
    if (vista === "spatial") await page.locator('#dnaViewToggle [data-dna-view="spatial"]').click();
    const nodi = vista === "spatial" ? "#dnaSpatial" : "#dnaNodes";
    await page.locator(`${nodi} .dna-node.is-root`).waitFor({ state: "visible", timeout: 30_000 });
    const clicca = async (tipo: string) => {
      const id = await page.evaluate(([n, t]) =>
        [...document.querySelectorAll<HTMLElement>(`${n} .dna-node--${t}`)]
          .find(x => x.style.display !== "none" && !x.classList.contains("is-focus") && !x.classList.contains("is-root"))?.dataset.node, [nodi, tipo]);
      expect(id, `nessun nodo ${tipo} da toccare`).toBeTruthy();
      await page.evaluate(([n, i]) => (document.querySelector(`${n} [data-node="${i}"]`) as HTMLElement).click(), [nodi, id!]);
      await page.waitForTimeout(900);
      return id!;
    };
    const etichetta = (id: string) => page.evaluate(([n, i]) =>
      document.querySelector(`${n} [data-node="${i}"]`)!.getAttribute("aria-label")!.trim(), [nodi, id]);

    await toccaNodo(page, `${nodi} .dna-node.is-root`);
    const genere = await clicca("genere");
    const film = await clicca("film");
    await page.locator("#dnaPanelPeek").click();
    const passi = await page.locator("#dnaPanel .dna-path__chip").allInnerTexts();
    expect(passi.length, "il percorso non ha tre passaggi (radice, genere, film)").toBe(3);
    expect(passi[1].trim()).toBe(await etichetta(genere));
    expect(passi[2].trim()).toBe(await etichetta(film));

    // Tornare indietro: il primo passaggio riporta alla radice, e il percorso sparisce.
    await page.locator("#dnaPanel .dna-path__chip[data-trail]").first().click();
    await expect(page.locator(`${nodi} .dna-node.is-focus`)).toHaveClass(/is-root/);
    await expect(page.locator("#dnaPanel .dna-path")).toHaveCount(0);

    expect(guasti, `guasti:\n${guasti.join("\n")}`).toEqual([]);
    expect(scritture, `la suite ha tentato di scrivere:\n${scritture.join("\n")}`).toEqual([]);
  });
}

// Con piu' persone scelte il pannello della radice non ripete i nomi del
// selettore: una riga sul titolo amato da TUTTI.
test("con due persone il pannello della radice dice quanti titoli amano entrambe", async ({ page }) => {
  const scritture = soloLettura(page);
  const guasti = osserva(page);
  await entra(page);
  await vaiA(page, "tonight");
  await page.locator("#dnaNodes .dna-node.is-root").waitFor({ state: "visible", timeout: 30_000 });
  await page.locator("#dnaPeopleBtn").click();
  const nomi = await page.$$eval("#dnaPeopleList .dna-sheet__row", r => r.map(x => (x as HTMLElement).dataset.user!).filter(u => u !== "*"));
  for (const nome of nomi.slice(0, 2)) await page.locator(`#dnaPeopleList .dna-sheet__row[data-user="${nome}"]`).click();
  await page.locator("#dnaPeopleDoneBtn").click();
  await page.locator("#dnaNodes .dna-node").first().waitFor({ state: "visible", timeout: 30_000 });
  await toccaNodo(page, "#dnaNodes .dna-node.is-root");
  await page.locator("#dnaPanelPeek").click();
  await expect(page.locator("#dnaPanel")).toContainText(/Amati da entrambi|Nessun titolo amato da entrambi/);
  await expect(page.locator("#dnaPanel")).not.toContainText("più titoli in comune");

  expect(guasti, `guasti:\n${guasti.join("\n")}`).toEqual([]);
  expect(scritture, `la suite ha tentato di scrivere:\n${scritture.join("\n")}`).toEqual([]);
});

// Un percorso lungo mostra al massimo 5 passaggi: la radice, "…" e gli ultimi 4.
test("un percorso lungo mostra la radice, i puntini e gli ultimi quattro passaggi", async ({ page }) => {
  const scritture = soloLettura(page);
  const guasti = osserva(page);
  await entra(page);
  await vaiA(page, "tonight");
  await page.locator("#dnaNodes .dna-node.is-root").waitFor({ state: "visible", timeout: 30_000 });
  await toccaNodo(page, "#dnaNodes .dna-node.is-root");

  const toccati = new Set<string>();
  for (let i = 0; i < 7; i++) {
    const id = await page.evaluate((gia: string[]) =>
      [...document.querySelectorAll<HTMLElement>("#dnaNodes .dna-node")]
        .find(n => !n.classList.contains("is-focus") && !n.classList.contains("is-root") && !gia.includes(n.dataset.node!))?.dataset.node,
      [...toccati]);
    expect(id, "la rete non ha abbastanza nodi da toccare").toBeTruthy();
    toccati.add(id!);
    await page.evaluate((i2: string) => (document.querySelector(`#dnaNodes [data-node="${i2}"]`) as HTMLElement).click(), id!);
    await page.waitForTimeout(700);
  }
  await page.locator("#dnaPanelPeek").click();
  expect(await page.locator("#dnaPanel .dna-path__chip").count(), "il percorso lungo non ha 5 passaggi").toBe(5);
  await expect(page.locator("#dnaPanel .dna-path__sep", { hasText: "…" })).toHaveCount(1);

  expect(guasti, `guasti:\n${guasti.join("\n")}`).toEqual([]);
  expect(scritture, `la suite ha tentato di scrivere:\n${scritture.join("\n")}`).toEqual([]);
});

// Parole giuste nei pannelli: partendo da un'altra persona non si parla di
// "tuoi" amati, con una persona sola non si ripete lo stesso numero, regista e
// attore dicono quali sono i titoli più amati, e prima del primo tocco
// l'istruzione "tocca per aprire" c'è una volta sola.
test("pannelli: parole giuste, niente doppioni, titoli del regista", async ({ page }) => {
  const scritture = soloLettura(page);
  const guasti = osserva(page);
  await entra(page);
  await vaiA(page, "tonight");
  await page.locator("#dnaNodes .dna-node.is-root").waitFor({ state: "visible", timeout: 30_000 });

  // Prima del primo tocco: l'istruzione è nel riquadro, non anche nel pannello.
  await expect(page.locator("#dnaStartHint")).toBeVisible();
  await expect(page.locator("#dnaPanel")).not.toContainText("Toccalo per aprire i collegamenti");

  // La riga sotto il titolo sta intera (niente puntini) e il pannello non
  // ripete la regola "voto 7 o più", che dice già la nota in fondo.
  const troncata = await page.evaluate(() => { const e = document.querySelector("#dnaIntroToggle > span") as HTMLElement; return e.scrollWidth > e.clientWidth + 1; });
  expect(troncata, "la riga sotto il titolo e' tagliata con i puntini").toBe(false);
  await expect(page.locator("#dnaPanel")).not.toContainText("voto 7 o più");

  const clicca = async (tipo: string) => {
    const id = await page.evaluate((t: string) =>
      [...document.querySelectorAll<HTMLElement>(`#dnaNodes .dna-node--${t}`)]
        .find(n => !n.classList.contains("is-focus") && !n.classList.contains("is-root"))?.dataset.node, tipo);
    expect(id, `nessun nodo ${tipo}`).toBeTruthy();
    await page.evaluate((i: string) => (document.querySelector(`#dnaNodes [data-node="${i}"]`) as HTMLElement).click(), id!);
    await page.waitForTimeout(700);
  };
  const pannello = async () => (await page.locator("#dnaPanel .dna-panel__full").evaluate(e => e.textContent || "")).replace(/\s+/g, " ");

  // Tutto il gruppo: regista con i titoli più amati e i chip, senza frase doppia.
  await toccaNodo(page, "#dnaNodes .dna-node.is-root");
  await clicca("regista");
  let t = await pannello();
  expect(t, "il regista non dice quali sono i titoli più amati").toContain("Più amati:");
  expect(t).toContain("Chi lo ama di più (su ");
  expect(t, "la frase che ripete il numero dei chip è tornata").not.toContain("Tra i tuoi amati");
  await clicca("film");
  for (let i = 0; i < 5 && !(await page.locator("#dnaNodes .dna-node--persona:not(.is-root)").count()); i++) await clicca("film");
  if (await page.locator("#dnaNodes .dna-node--persona:not(.is-root)").count()) {
    await clicca("persona");
    t = await pannello();
    expect(t, "la persona non dice quanto ha amato").toMatch(/ha amato \d+ titol/);
  }

  // Una persona sola, diversa da te: niente "tuoi", niente numero ripetuto.
  await page.locator("#dnaPeopleBtn").click();
  await page.locator('#dnaPeopleList .dna-sheet__row[data-user="Gabri"]').click();
  await page.locator("#dnaPeopleDoneBtn").click();
  await page.locator("#dnaNodes .dna-node.is-root").waitFor({ state: "visible", timeout: 30_000 });
  await toccaNodo(page, "#dnaNodes .dna-node.is-root");
  await clicca("genere");
  t = await pannello();
  expect(t, "parla di 'tuoi' amati ma si parte da un'altra persona").not.toContain("tuoi");
  expect(t).toContain("Il percorso");
  expect(t, "il genere con una persona sola non dice 'Ha amato N titoli in questo genere'").toMatch(/Ha amato \d+ titol\w* in questo genere/);
  expect(t, "con una persona sola resta il chip che ripete il numero").not.toContain("Chi lo ama di più");

  expect(guasti, `guasti:\n${guasti.join("\n")}`).toEqual([]);
  expect(scritture, `la suite ha tentato di scrivere:\n${scritture.join("\n")}`).toEqual([]);
});

// Durante la selezione di più persone (schermo normale): la riga verde in alto
// dice quanti titoli amano tutti, da 2 persone in su; il pannello sotto non lo
// ripete e dice altro (generi, titoli, chi è più vicino a chi). A schermo
// intero, dove la riga verde non c'è, il pannello resta com'era.
test("più persone: riga verde sempre, pannello senza doppioni, schermo intero invariato", async ({ page }) => {
  const scritture = soloLettura(page);
  const guasti = osserva(page);
  await entra(page);
  await vaiA(page, "tonight");
  await page.locator("#dnaNodes .dna-node.is-root").waitFor({ state: "visible", timeout: 30_000 });
  const scegli = async (nomi: string[]) => {
    await page.locator("#dnaPeopleBtn").click();
    // Il foglio è a interruttore: si riparte da "Tutti", poi si spuntano i nomi.
    await page.locator('#dnaPeopleList .dna-sheet__row[data-user="*"]').click();
    for (const n of nomi) await page.locator(`#dnaPeopleList .dna-sheet__row[data-user="${n}"]`).click();
    await page.locator("#dnaPeopleDoneBtn").click();
    await page.locator("#dnaNodes .dna-node.is-root").waitFor({ state: "visible", timeout: 30_000 });
    await page.waitForTimeout(300);
  };
  const testo = (sel: string) => page.evaluate((s: string) => (document.querySelector(s)?.textContent || "").replace(/\s+/g, " ").trim(), sel);

  await scegli(["Cos", "Gabri", "Generalissimo"]);
  expect(await testo("#dnaAffinity")).toMatch(/\d+ titol\w+ amat\w+ da tutti e tre\./);
  let pannello = await testo("#dnaPanel");
  expect(pannello, "il pannello ripete il numero della riga verde").not.toMatch(/Amati da tutti e tre/);
  expect(pannello).toContain("In comune soprattutto");
  expect(pannello).toContain("Ad esempio:");
  expect(pannello, "con 3 persone manca chi è più vicino a chi").toMatch(/Più vicini: .+ e .+ \(\d+ titol\w+ amati insieme\)\./);

  // Con 4 persone la riga verde c'è ancora.
  await scegli(["Cos", "Gabri", "Generalissimo", "TB"]);
  expect(await testo("#dnaAffinity")).toMatch(/(\d+ titol\w+ amat\w+|Nessun titolo amato) da tutti e quattro\./);

  // Con 2 persone: niente "Più vicini" (sarebbe lo stesso numero della riga verde).
  await scegli(["Cos", "Gabri"]);
  expect(await testo("#dnaAffinity")).toMatch(/da entrambi\./);
  expect(await testo("#dnaPanel")).not.toContain("Più vicini");

  // Schermo intero (dopo il primo tocco): il pannello dice il numero, come prima.
  await toccaNodo(page, "#dnaNodes .dna-node.is-root");
  await page.locator("#dnaPanelPeek").click();
  await expect(page.locator("#dnaPanel")).toContainText(/Amati da entrambi: \d+ titol/);

  expect(guasti, `guasti:\n${guasti.join("\n")}`).toEqual([]);
  expect(scritture, `la suite ha tentato di scrivere:\n${scritture.join("\n")}`).toEqual([]);
});

// Laboratorio 3D (voce "3D" del selettore): un dito ruota la scena attorno al
// nodo attivo; "Frontale" compare solo a scena girata e la riporta dritta.
test("3D: un dito ruota la scena e Frontale la riporta dritta", async ({ page }) => {
  const scritture = soloLettura(page);
  const guasti = osserva(page);
  await entra(page);
  await vaiA(page, "tonight");
  await page.locator("#dnaNodes .dna-node.is-root").waitFor({ state: "visible", timeout: 30_000 });
  await page.locator('#dnaViewToggle [data-dna-view="orbit"]').click();
  await page.locator("#dnaSpatial .dna-node.is-root").waitFor({ state: "visible" });
  await toccaNodo(page, "#dnaSpatial .dna-node.is-root");
  await page.waitForTimeout(500);

  const posizioni = () => page.evaluate(() =>
    Object.fromEntries([...document.querySelectorAll<HTMLElement>("#dnaSpatial .dna-node")]
      .filter(n => n.style.display !== "none")
      .map(n => { const r = n.getBoundingClientRect(); return [n.dataset.node!, [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)]]; })));
  const prima = await posizioni();
  await expect(page.locator(".dna-spatial__front")).toBeHidden();

  // Un dito che trascina ruota (non sposta soltanto).
  const st = (await page.locator("#dnaStage").boundingBox())!;
  await page.mouse.move(st.x + st.width / 2, st.y + st.height * 0.7);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) { await page.mouse.move(st.x + st.width / 2 + i * 12, st.y + st.height * 0.7 - i * 6); await page.waitForTimeout(16); }
  await page.mouse.up();
  await page.waitForTimeout(700);
  const girata = await posizioni();
  const comuni = Object.keys(prima).filter(id => girata[id]);
  expect(comuni.length, "ruotando sono spariti quasi tutti i nodi").toBeGreaterThan(2);
  const spostati = comuni.filter(id => Math.hypot(girata[id][0] - prima[id][0], girata[id][1] - prima[id][1]) > 25).length;
  expect(spostati, "il trascinamento non ha ruotato la scena").toBeGreaterThan(1);
  await expect(page.locator(".dna-spatial__front")).toBeVisible();

  // "Frontale" la riporta dritta e sparisce.
  await page.locator(".dna-spatial__front").click();
  await page.waitForTimeout(900);
  await expect(page.locator(".dna-spatial__front")).toBeHidden();
  const dopo = await posizioni();
  const tornati = comuni.filter(id => dopo[id] && Math.hypot(dopo[id][0] - prima[id][0], dopo[id][1] - prima[id][1]) < 12).length;
  expect(tornati, "Frontale non riporta i nodi dov'erano").toBeGreaterThan(comuni.length / 2);

  // Il tocco sui nodi funziona anche in 3D.
  const vicino = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>("#dnaSpatial .dna-node")]
    .find(n => n.style.display !== "none" && !n.classList.contains("is-focus"))?.dataset.node);
  await page.evaluate((i: string) => (document.querySelector(`#dnaSpatial [data-node="${i}"]`) as HTMLElement).click(), vicino!);
  await page.waitForTimeout(700);
  await expect(page.locator(`#dnaSpatial [data-node="${vicino}"]`)).toHaveClass(/is-focus/);

  expect(guasti, `guasti:\n${guasti.join("\n")}`).toEqual([]);
  expect(scritture, `la suite ha tentato di scrivere:\n${scritture.join("\n")}`).toEqual([]);
});

// Laboratorio 3D, voce "Sfera": i collegamenti di un nodo stanno a profondità
// diverse (scale diverse già a vista frontale), ruotando cambiano posizione,
// e "Frontale" riporta dritto.
test("Sfera: i nodi stanno a profondità diverse e la scena ruota", async ({ page }) => {
  const scritture = soloLettura(page);
  const guasti = osserva(page);
  await entra(page);
  await vaiA(page, "tonight");
  await page.locator("#dnaNodes .dna-node.is-root").waitFor({ state: "visible", timeout: 30_000 });
  await page.locator('#dnaViewToggle [data-dna-view="sphere"]').click();
  await page.locator("#dnaSpatial .dna-node.is-root").waitFor({ state: "visible" });
  await toccaNodo(page, "#dnaSpatial .dna-node.is-root");
  await page.evaluate(() => (document.querySelector("#dnaSpatial .dna-node.is-root .dna-node__more") as HTMLElement | null)?.click());
  await page.waitForTimeout(900);

  const stato = () => page.evaluate(() => {
    const nodi = [...document.querySelectorAll<HTMLElement>("#dnaSpatial .dna-node")].filter(n => n.style.display !== "none");
    const scale = nodi.map(n => { const m = /scale\(([\d.]+)\)/.exec(n.style.transform); return m ? +m[1] : 1; });
    const pos = Object.fromEntries(nodi.map(n => { const r = n.getBoundingClientRect(); return [n.dataset.node!, [Math.round(r.left), Math.round(r.top)]]; }));
    return { distinte: new Set(scale.map(s => s.toFixed(2))).size, pos };
  });
  const prima = await stato();
  expect(prima.distinte, "i nodi stanno tutti alla stessa profondità: la sfera non è una sfera").toBeGreaterThanOrEqual(5);

  const st = (await page.locator("#dnaStage").boundingBox())!;
  await page.mouse.move(st.x + st.width / 2, st.y + st.height * 0.75);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) { await page.mouse.move(st.x + st.width / 2 - i * 10, st.y + st.height * 0.75 - i * 4); await page.waitForTimeout(16); }
  await page.mouse.up();
  await page.waitForTimeout(800);
  const dopo = await stato();
  const spostati = Object.keys(prima.pos).filter(id => dopo.pos[id] && Math.hypot(dopo.pos[id][0] - prima.pos[id][0], dopo.pos[id][1] - prima.pos[id][1]) > 25).length;
  expect(spostati, "ruotando la sfera i nodi non si sono mossi").toBeGreaterThan(2);
  await expect(page.locator(".dna-spatial__front")).toBeVisible();
  await page.locator(".dna-spatial__front").click();
  await page.waitForTimeout(900);
  await expect(page.locator(".dna-spatial__front")).toBeHidden();

  expect(guasti, `guasti:\n${guasti.join("\n")}`).toEqual([]);
  expect(scritture, `la suite ha tentato di scrivere:\n${scritture.join("\n")}`).toEqual([]);
});

// Vista Piatto: dopo uno swipe veloce la rete continua a scorrere un po' (come
// in Spaziale) e poi si ferma; uno swipe che finisce col dito fermo no.
test("piatto: la rete continua a scorrere dopo lo swipe e si ferma da sola", async ({ page }) => {
  const scritture = soloLettura(page);
  const guasti = osserva(page);
  await entra(page);
  await vaiA(page, "tonight");
  await page.locator("#dnaNodes .dna-node.is-root").waitFor({ state: "visible", timeout: 30_000 });
  await toccaNodo(page, ".dna-node.is-root");
  await page.evaluate(() => (document.querySelector("#dnaNodes .dna-node.is-root .dna-node__more") as HTMLElement | null)?.click());
  await page.waitForTimeout(900);

  const tr = () => page.evaluate(() => (document.getElementById("dnaCanvas") as HTMLElement).style.transform);
  const st = (await page.locator("#dnaStage").boundingBox())!;
  const x0 = st.x + st.width * 0.75, y0 = st.y + st.height * 0.5;
  await page.mouse.move(x0, y0); await page.mouse.down();
  for (let i = 1; i <= 8; i++) { await page.mouse.move(x0 - 6 * i, y0); await page.waitForTimeout(16); }
  await page.mouse.up();
  const alRilascio = await tr();
  await page.waitForTimeout(120);
  const dopo = await tr();
  expect(dopo, "dopo lo swipe la rete si è fermata di colpo").not.toBe(alRilascio);
  await page.waitForTimeout(1800);
  const a = await tr(); await page.waitForTimeout(200);
  expect(await tr(), "la scivolata non si ferma mai").toBe(a);

  expect(scritture).toEqual([]);
  expect(guasti).toEqual([]);
});

// Lab 3D: il nodo toccato diventa il fulcro (sta al centro dello schermo), e un
// trascinamento che parte da un nodo ruota attorno a quel nodo.
test("Sfera: il nodo toccato va al centro e il trascinamento da un nodo lo prende come fulcro", async ({ page }) => {
  const scritture = soloLettura(page);
  const guasti = osserva(page);
  await entra(page);
  await vaiA(page, "tonight");
  await page.locator("#dnaNodes .dna-node.is-root").waitFor({ state: "visible", timeout: 30_000 });
  await page.locator('#dnaViewToggle [data-dna-view="sphere"]').click();
  await page.locator("#dnaSpatial .dna-node.is-root").waitFor({ state: "visible" });
  await toccaNodo(page, "#dnaSpatial .dna-node.is-root");
  await page.waitForTimeout(900);

  const distDalCentro = (sel: string) => page.evaluate((s) => {
    const c = document.getElementById("dnaSpatial")!.getBoundingClientRect();
    const r = document.querySelector(s)!.getBoundingClientRect();
    return Math.hypot(r.left + r.width / 2 - (c.left + c.width / 2), r.top + r.height / 2 - (c.top + c.height / 2));
  }, sel);
  expect(await distDalCentro("#dnaSpatial .dna-node.is-root"), "il nodo aperto non è al centro").toBeLessThan(14);

  const vicino = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>("#dnaSpatial .dna-node")]
      .find(n => !n.classList.contains("is-focus") && n.style.display !== "none")?.dataset.node);
  expect(vicino).toBeTruthy();
  await toccaNodo(page, `#dnaSpatial [data-node="${vicino}"]`);
  await page.waitForTimeout(1200);
  expect(await distDalCentro(`#dnaSpatial [data-node="${vicino}"]`), "il nodo toccato non è al centro").toBeLessThan(14);

  // Trascinamento che parte da un nodo diverso dal fulcro.
  const altro = await page.evaluate((v) =>
    [...document.querySelectorAll<HTMLElement>("#dnaSpatial .dna-node")]
      .find(n => n.dataset.node !== v && n.style.display !== "none" && +(n.style.opacity || 1) > 0.5)?.dataset.node, vicino);
  if (altro) {
    const b = (await page.locator(`#dnaSpatial [data-node="${altro}"]`).boundingBox())!;
    const x = b.x + b.width / 2, y = b.y + b.height / 2;
    await page.mouse.move(x, y); await page.mouse.down();
    for (let i = 1; i <= 10; i++) { await page.mouse.move(x + i * 3, y + i * 2); await page.waitForTimeout(16); }
    await page.mouse.up();
    await page.waitForTimeout(1200);
    expect(await distDalCentro(`#dnaSpatial [data-node="${altro}"]`), "il nodo da cui parte il drag non è il fulcro").toBeLessThan(40);
  }

  expect(guasti, `guasti:\n${guasti.join("\n")}`).toEqual([]);
  expect(scritture, `la suite ha tentato di scrivere:\n${scritture.join("\n")}`).toEqual([]);
});

// Lab 3D: il nodo aperto e tutti i suoi collegamenti stanno sempre interi
// nel riquadro (la camera si allarga quanto serve), anche toccando nodi lontani.
test("Sfera: il nodo toccato e i suoi collegamenti non vengono mai tagliati", async ({ page }) => {
  const scritture = soloLettura(page);
  const guasti = osserva(page);
  await entra(page);
  await vaiA(page, "tonight");
  await page.locator("#dnaNodes .dna-node.is-root").waitFor({ state: "visible", timeout: 30_000 });
  await page.locator('#dnaViewToggle [data-dna-view="sphere"]').click();
  await page.locator("#dnaSpatial .dna-node.is-root").waitFor({ state: "visible" });

  const tagliati = async () => {
    await page.waitForTimeout(1300);
    return page.evaluate(() => {
      const c = document.getElementById("dnaSpatial")!.getBoundingClientRect();
      const id = (document.querySelector("#dnaSpatial .dna-node.is-focus") as HTMLElement).dataset.node!;
      const vic = new Set([id]);
      for (const l of document.querySelectorAll<SVGElement>("#dnaSpatial line")) {
        const [a, b] = (l.dataset.k || "|").split("|");
        if (a === id) vic.add(b); if (b === id) vic.add(a);
      }
      return [...document.querySelectorAll<HTMLElement>("#dnaSpatial .dna-node")]
        .filter(el => el.style.display !== "none" && vic.has(el.dataset.node!))
        .filter(el => { const q = el.getBoundingClientRect(); return q.left < c.left - 1 || q.right > c.right + 1 || q.top < c.top; })
        .map(el => el.dataset.node);
    });
  };
  await toccaNodo(page, "#dnaSpatial .dna-node.is-root");
  await page.evaluate(() => (document.querySelector("#dnaSpatial .dna-node.is-root .dna-node__more") as HTMLElement | null)?.click());
  expect(await tagliati(), "dopo l'apertura qualche collegamento è tagliato").toEqual([]);
  for (let i = 0; i < 3; i++) {
    const id = await page.evaluate(() => {
      const c = document.getElementById("dnaSpatial")!.getBoundingClientRect();
      const d = (x: Element) => { const r = x.getBoundingClientRect(); return Math.hypot(r.left + r.width / 2 - c.left - c.width / 2, r.top + r.height / 2 - c.top - c.height / 2); };
      return [...document.querySelectorAll<HTMLElement>("#dnaSpatial .dna-node")]
        .filter(n => n.style.display !== "none" && !n.classList.contains("is-focus") && +(n.style.opacity || 1) > 0.5)
        .sort((a, b) => d(b) - d(a))[0]?.dataset.node;
    });
    if (!id) break;
    await page.evaluate(i => (document.querySelector(`#dnaSpatial [data-node="${i}"]`) as HTMLElement).click(), id);
    expect(await tagliati(), `toccando ${id} qualche collegamento è tagliato`).toEqual([]);
  }
  expect(guasti, `guasti:\n${guasti.join("\n")}`).toEqual([]);
  expect(scritture, `la suite ha tentato di scrivere:\n${scritture.join("\n")}`).toEqual([]);
});
