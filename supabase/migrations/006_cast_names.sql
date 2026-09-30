-- I primi 3 attori di ogni titolo (ordine di importanza TMDB), per i nodi
-- "attore" del DNA e le statistiche. Colonna nuova e nullable-con-default:
-- non tocca niente di esistente, e il client vecchio (che non la conosce)
-- continua a funzionare. `cast` sarebbe una parola riservata di Postgres,
-- da qui `cast_names`.
alter table titles add column if not exists cast_names jsonb not null default '[]'::jsonb;
