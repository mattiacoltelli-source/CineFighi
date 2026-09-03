-- Traccia quando un titolo è stato davvero segnato come "visto", separato
-- da created_at (quando è stato CATALOGATO). Senza questo, "Ultimi film
-- visti"/"Ultime serie viste" in Home (che dovrebbero mostrare i più
-- recenti VISTI) finivano per ordinare per data di catalogazione: un
-- titolo in watchlist da tempo, appena votato, restava sepolto nella sua
-- vecchia posizione invece di comparire in cima.

alter table titles add column if not exists seen_at timestamptz;

-- Backfill per i titoli già "visti": usiamo created_at come approssimazione
-- ragionevole (non abbiamo mai tracciato il momento vero finora), così
-- l'ordine relativo non si mescola di colpo al rollout — da questo punto
-- in poi seen_at riflette il momento reale del cambio di stato.
update titles set seen_at = created_at where status = 'seen' and seen_at is null;
