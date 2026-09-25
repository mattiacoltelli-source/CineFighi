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
  const res = await request.get("/manifest.json");
  expect(res.ok(), "manifest.json non raggiungibile").toBe(true);
  const manifest = await res.json();

  expect(manifest.name, "manifest senza nome").toBeTruthy();
  expect(manifest.start_url, "manifest senza start_url").toBeTruthy();
  expect(Array.isArray(manifest.icons) && manifest.icons.length > 0, "manifest senza icone").toBe(true);

  for (const icona of manifest.icons) {
    const r = await request.get(`/${icona.src}`);
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

  const sw = await page.request.get("/sw.js");
  expect(sw.ok(), "sw.js non raggiungibile").toBe(true);
  const testo = await sw.text();
  expect(testo, "sw.js senza SW_VERSION: il cache-busting dell'aggiornamento dipende da questo").toMatch(/SW_VERSION\s*=/);

  expect(guasti, `guasti:\n${guasti.join("\n")}`).toEqual([]);
  expect(scritture, `la suite ha tentato di scrivere:\n${scritture.join("\n")}`).toEqual([]);
});
