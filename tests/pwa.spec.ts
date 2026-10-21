import { test, expect } from "@playwright/test";
import { entra, osserva, soloLettura } from "./helpers";

// Il meccanismo di aggiornamento (cache-busting, service worker, banner
// "Aggiorna") ha logica delicata e zero copertura — se si rompe, chi ha
// l'app installata resta bloccato su una versione vecchia senza accorgersene
// (vedi i commenti in app.js su bfcache e PWA installata).
//
// Scelta deliberata: NON simuliamo qui il ciclo completo di aggiornamento
// (installare una seconda versione del service worker e aspettare che il
// browser la rilevi come "in attesa") — è la parte più delicata da orchestrare
// in test headless, a rischio concreto di flakiness che darebbe falsi
// allarmi senza un bug vero dietro. Verifichiamo invece le premesse statiche
// da cui TUTTO il meccanismo dipende: se una di queste si rompe, l'update si
// rompe di sicuro; se sono a posto, il resto (gia' scritto con cura, vedi i
// commenti in app.js) ha almeno le fondamenta giuste.

test("il manifest della PWA è valido e le icone caricano", async ({ page, request }) => {
  // "./" e non "/": vedi il commento in helpers.ts::entra — con una baseURL
  // che ha un sottopercorso, un path assoluto la scavalca e finisce sulla
  // radice del dominio invece che su /CineFighi/.
  const res = await request.get("./manifest.json");
  expect(res.ok(), "manifest.json non raggiungibile").toBe(true);
  const manifest = await res.json();

  expect(manifest.name, "manifest senza nome").toBeTruthy();
  expect(manifest.start_url, "manifest senza start_url").toBeTruthy();
  expect(Array.isArray(manifest.icons) && manifest.icons.length > 0, "manifest senza icone").toBe(true);

  for (const icona of manifest.icons) {
    const r = await request.get(`./${icona.src}`);
    expect(r.ok(), `icona "${icona.src}" del manifest non carica`).toBe(true);
    expect(Number(r.headers()["content-length"] || 0), `icona "${icona.src}" è vuota`).toBeGreaterThan(0);
  }
});

test("il service worker si registra e prende il controllo della pagina", async ({ page }) => {
  const guasti = osserva(page);
  const scritture = soloLettura(page);
  await entra(page);

  // register("./sw.js") parte al caricamento (vedi app.js), ma sw.js NON
  // reclama il tab della primissima registrazione apposta (vedi il commento
  // su claimOnActivate in sw.js — solo un aggiornamento scelto dall'utente
  // reclama il tab già aperto). Il controllo arriva quindi al giro
  // successivo: aspettiamo che il worker sia "ready", poi ricarichiamo — un
  // normale caricamento in-scope, con un worker già attivo, viene sempre
  // controllato di suo, senza bisogno di clients.claim().
  const supportato = await page.evaluate(() => "serviceWorker" in navigator);
  test.skip(!supportato, "browser senza supporto service worker in questo ambiente");
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await page.reload({ waitUntil: "domcontentloaded" });
  const controllato = await page.evaluate(() => !!navigator.serviceWorker.controller);
  expect(controllato, "il service worker non ha preso il controllo della pagina dopo l'attivazione").toBe(true);

  const sw = await page.request.get("./sw.js"); // "./" e non "/": vedi il commento in helpers.ts::entra
  expect(sw.ok(), "sw.js non raggiungibile").toBe(true);
  const testo = await sw.text();
  expect(testo, "sw.js senza SW_VERSION: il cache-busting dell'aggiornamento dipende da questo").toMatch(/SW_VERSION\s*=/);

  expect(guasti, `guasti:\n${guasti.join("\n")}`).toEqual([]);
  expect(scritture, `la suite ha tentato di scrivere:\n${scritture.join("\n")}`).toEqual([]);
});

// Il controllo "c'è una versione nuova?" (app.js::initUpdateCheck) è un best effort: quando il browser rifiuta
// registration.update() non c'è niente da correggere né da segnalare. Succede davvero: Chrome su Android risponde
// InvalidStateError ("The object is in an invalid state") se ha già scartato la registrazione del service worker
// (Sentry CINEFIGHI-5, 21/10/2026). Senza un catch diventava un errore non gestito, finito in Sentry per niente.
// Qui update() rifiuta come fa Chrome, sia all'avvio sia ai due "ritorni in primo piano" (pageshow, visibilitychange).
test("se il browser rifiuta il controllo degli aggiornamenti non nascono errori non gestiti", async ({ page }) => {
  const guasti = osserva(page);
  const scritture = soloLettura(page);
  await page.addInitScript(() => {
    (window as any).__tentativiUpdate = 0;
    ServiceWorkerRegistration.prototype.update = () => {
      (window as any).__tentativiUpdate++;
      return Promise.reject(new DOMException("Failed to update a ServiceWorker: The object is in an invalid state.", "InvalidStateError"));
    };
  });
  await entra(page);
  const supportato = await page.evaluate(() => "serviceWorker" in navigator);
  test.skip(!supportato, "browser senza supporto service worker in questo ambiente");

  // Il primo controllo parte a fine avvio (initUpdateCheck), dopo aver caricato la libreria.
  await page.waitForFunction(() => (window as any).__tentativiUpdate >= 1, null, { timeout: 30_000 });
  await page.evaluate(() => {
    window.dispatchEvent(new Event("pageshow"));
    document.dispatchEvent(new Event("visibilitychange"));
  });
  // Il test non è vuoto: l'app ha davvero richiamato update() anche ai due ritorni in primo piano.
  await page.waitForFunction(() => (window as any).__tentativiUpdate >= 3, null, { timeout: 10_000 });
  await page.waitForTimeout(500);   // il tempo che un rifiuto non gestito emerga come errore

  expect(guasti, `guasti:\n${guasti.join("\n")}`).toEqual([]);
  expect(scritture, `la suite ha tentato di scrivere:\n${scritture.join("\n")}`).toEqual([]);
});
