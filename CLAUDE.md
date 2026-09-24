# CineFighi

App di cinema multiutente (gruppo condiviso), Supabase come backend. Vedi
`README.md` per l'architettura.

## Test dal vivo: mai account creati a mano

Il gruppo utenti (`users`) è quello **reale**, condiviso con gli amici del
gruppo — non un ambiente di test separato. Se devi verificare manualmente un
flusso multiutente (user picker, watchlist, voti, ecc.) sull'app live:

- **Riusa `_QA_Agent_`**, il nome convenzionale già usato per questo scopo.
  Non crearne uno nuovo con un nome a piacere (es. "TestUser") — resterebbe
  visibile per sempre agli utenti reali nella lista di selezione profilo.
  (Nota: `qa-agent`, il repo di test separato, non copre più CineFighi in
  nessuna forma — vedi il suo README — quindi non esiste più una suite
  automatica che usi già questo account.)
- Se lo crei o lo usi per una prova manuale, **cancellalo a fine sessione**.
  L'app non offre più un modo client-side per farlo (dal 2026-09-18 la
  tabella `users` non ha più una policy RLS DELETE pubblica, vedi
  `storage.js`), quindi serve la service role key dalla dashboard Supabase.
- Stessa logica per eventuali titoli o voti aggiunti durante una prova
  manuale: rimuovili prima di finire, non lasciarli nella libreria condivisa
  (questi restano cancellabili con la chiave pubblica, come fa già l'app).
