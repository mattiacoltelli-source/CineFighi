import { test, expect } from "@playwright/test";

// Controllo GIORNALIERO (solo sul sito vero, vedi il gate sotto) che i report
// siano in salute, senza mai generarne uno.
//
// Regola di playwright.config.ts: la suite non scrive niente e non spende niente.
// Le funzioni dei report (generate-report, generate-group-report) scrivono sul
// database e costano una chiamata a pagamento, e quella di gruppo si rigenera
// da sola se l'ultimo report ha piu' di 90 giorni: chiamarle con un POST dal
// Guardiano, un giorno, innescherebbe proprio quello. Quindi qui:
//   1. OPTIONS (la richiesta "preliminare" dei browser): la funzione la
//      gestisce prima di toccare database o Claude, risponde "ok" e non fa
//      altro. Basta a sapere che la funzione e' pubblicata e si avvia (un
//      deploy rotto o una funzione cancellata risponde 404/5xx).
//   2. Lettura dell'ultimo report di gruppo: il cron lo rigenera ogni 4 mesi
//      (1 gennaio, maggio, settembre, ~122 giorni al massimo fra l'uno e
//      l'altro). Se l'ultimo ha piu' di 150 giorni, il cron non sta girando.
// Non verifica la chiave di Anthropic ne' che la generazione riesca: per
// quello servirebbe generare un report davvero.

const SUPABASE_URL = "https://dxzukpujouayxlomwryc.supabase.co";
const ANON_KEY = "sb_publishable_6kaInTs-_PDPHUszpj8N5w_Sb1zCXI9";   // la stessa pubblica dell'app (supabase.js)
const ETA_MAX_GIORNI = 150;

const soloSitoVero = !/github\.io/.test(process.env.CINEFIGHI_URL ?? "");

for (const funzione of ["generate-report", "generate-group-report"]) {
  test(`la funzione ${funzione} e' pubblicata e si avvia`, async ({ request }) => {
    test.skip(soloSitoVero, "controllo giornaliero: gira solo sul sito pubblicato (CINEFIGHI_URL su github.io)");
    const res = await request.fetch(`${SUPABASE_URL}/functions/v1/${funzione}`, {
      method: "OPTIONS",
      headers: { Origin: "https://mattiacoltelli-source.github.io", "Access-Control-Request-Method": "POST" },
    });
    expect(res.status(), `${funzione} non risponde: e' stata cancellata o il deploy e' rotto?`).toBe(200);
  });
}

test("l'ultimo report di gruppo non e' piu' vecchio di 150 giorni", async ({ request }) => {
  test.skip(soloSitoVero, "controllo giornaliero: gira solo sul sito pubblicato (CINEFIGHI_URL su github.io)");
  const res = await request.get(`${SUPABASE_URL}/rest/v1/group_report?select=generated_at&order=generated_at.desc&limit=1`, {
    headers: { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}` },
  });
  expect(res.ok(), `lettura group_report fallita: ${res.status()}`).toBe(true);
  const [ultimo] = await res.json();
  expect(ultimo?.generated_at, "non esiste nessun report di gruppo").toBeTruthy();
  const giorni = (Date.now() - new Date(ultimo.generated_at).getTime()) / 86_400_000;
  expect(giorni, `l'ultimo report di gruppo ha ${Math.round(giorni)} giorni: il cron quadrimestrale non sta girando?`).toBeLessThan(ETA_MAX_GIORNI);
});
