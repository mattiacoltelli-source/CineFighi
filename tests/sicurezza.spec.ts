import { test, expect, APIRequestContext } from "@playwright/test";

// Verifica diretta della policy RLS che ha chiuso l'incidente del 18/9/2026
// (tutti gli utenti cancellati sfruttando una policy "public full access" su
// `users` aperta a chiunque conoscesse la chiave anon — vedi CLAUDE.md e lo
// storico di storage.js::deleteUser). Se questa policy dovesse mai tornare
// permissiva, questo test se ne accorge.
//
// Richiede la SERVICE ROLE key di Supabase (mai quella pubblica: serve per
// creare/eliminare in sicurezza una riga usa-e-getta, bypassando RLS) come
// variabile d'ambiente SUPABASE_SERVICE_ROLE_KEY. Senza, il test si salta
// da solo — non fallisce, non blocca la pipeline — perché:
//   1. non è un valore da generare o dedurre: va copiato dalla dashboard
//      Supabase (Project Settings → API) direttamente nei secret di GitHub
//      Actions (Settings → Secrets and variables → Actions), mai incollato
//      in una chat o in un file del repo;
//   2. finché non esiste, non c'è modo di far girare questo test SENZA
//      rischiare — con la sola chiave pubblica, l'unico modo di provare
//      "il DELETE è bloccato" sarebbe provarlo su un utente vero: se la
//      policy fosse davvero tornata permissiva, il test stesso causerebbe
//      l'incidente che vuole scoprire.
// Stesso pattern già usato altrove nella suite per i secret Telegram
// (guardiano.yml) e per i test che richiedono un gruppo abbastanza grande
// (dna.spec.ts, test.skip).

const SUPABASE_URL = "https://dxzukpujouayxlomwryc.supabase.co";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

test("RLS blocca il DELETE pubblico su users (chiave anon)", async ({ request }) => {
  test.skip(!SERVICE_KEY, "manca SUPABASE_SERVICE_ROLE_KEY: va aggiunta come secret di GitHub Actions dalla dashboard Supabase, mai in chat o nel repo");

  const ANON_KEY = "sb_publishable_6kaInTs-_PDPHUszpj8N5w_Sb1zCXI9"; // stessa chiave pubblica dell'app (supabase.js)
  const nomeTest = `_rls_check_${Date.now()}`;
  const headerService = { apikey: SERVICE_KEY!, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" };
  const headerAnon = { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}` };

  async function pulisci(request: APIRequestContext) {
    await request.delete(`${SUPABASE_URL}/rest/v1/users?name=eq.${nomeTest}`, { headers: headerService });
  }

  // Riga usa-e-getta creata con la service role (bypassa RLS, sicuro).
  const crea = await request.post(`${SUPABASE_URL}/rest/v1/users`, { headers: headerService, data: { name: nomeTest } });
  expect(crea.ok(), `impossibile creare la riga di test: ${crea.status()} ${await crea.text()}`).toBe(true);

  try {
    // Il vero test: prova a cancellarla con la chiave PUBBLICA, quella che
    // gira nel client dell'app — deve fallire (o meglio, non toccare nulla:
    // Postgres non solleva errore, filtra 0 righe, vedi storage.js).
    await request.delete(`${SUPABASE_URL}/rest/v1/users?name=eq.${nomeTest}`, { headers: headerAnon });

    const verifica = await request.get(`${SUPABASE_URL}/rest/v1/users?name=eq.${nomeTest}&select=name`, { headers: headerService });
    const righe = await verifica.json();
    expect(righe.length, "la chiave pubblica ha cancellato la riga: la policy RLS DELETE su users è tornata permissiva!").toBe(1);
  } finally {
    // Pulizia sempre, che il test sia passato o fallito.
    await pulisci(request);
  }
});
