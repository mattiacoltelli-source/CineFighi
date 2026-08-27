# CineFighi

App di cinema multiutente (gruppo condiviso), Supabase come backend. Vedi
`README.md` per l'architettura.

## Test dal vivo: mai account creati a mano

Il gruppo utenti (`users`) è quello **reale**, condiviso con gli amici del
gruppo — non un ambiente di test separato. Se devi verificare manualmente un
flusso multiutente (user picker, watchlist, voti, ecc.) sull'app live:

- **Riusa `_QA_Agent_`**, lo stesso account dedicato usato dalla suite
  Playwright in [`qa-agent`](https://github.com/mattiacoltelli-source/qa-agent)
  (vedi `apps/cinefighi/fixtures/cinefighi-page.ts`). Non crearne uno nuovo
  con un nome a piacere (es. "TestUser") — resterebbe visibile per sempre
  agli utenti reali nella lista di selezione profilo.
- Se lo crei o lo usi per una prova manuale, **cancellalo a fine sessione**
  (dall'app: seleziona il profilo, poi elimina) esattamente come fa
  `qa-agent/scripts/cleanup-write-residue.mjs` a fine run automatico.
- Stessa logica per eventuali titoli o voti aggiunti durante una prova
  manuale: rimuovili prima di finire, non lasciarli nella libreria condivisa.
