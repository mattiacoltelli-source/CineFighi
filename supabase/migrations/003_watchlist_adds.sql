-- Traccia CHI ha aggiunto ogni titolo alla PROPRIA watchlist, separatamente
-- da titles.added_by (che resta "chi ha catalogato il titolo per primo",
-- un dato di provenienza, non più la watchlist di una sola persona).
--
-- Prima, la watchlist era un unico campo condiviso su titles: se qualcuno
-- aveva già aggiunto un film, nessun altro poteva "aggiungerlo alla propria
-- lista" (vincolo unique su tmdb_id+media_type), e non c'era modo di sapere
-- quante persone lo volessero vedere. Ora ogni persona ha una riga propria
-- qui dentro; la watchlist di gruppo mostra "Nome (+N altri)" come già
-- succede per i voti sui titoli visti.

create table if not exists public.watchlist_adds (
  id bigint generated always as identity primary key,
  title_id uuid not null references public.titles(id) on delete cascade,
  user_name text not null,
  created_at timestamptz not null default now(),
  unique (title_id, user_name)
);

create index if not exists watchlist_adds_title_id_idx on public.watchlist_adds (title_id);

alter table public.watchlist_adds enable row level security;

create policy "public full access watchlist_adds"
  on public.watchlist_adds
  for all
  using (true)
  with check (true);

-- Backfill: registra chi aveva già ogni titolo attualmente in watchlist,
-- così i dati esistenti non spariscono dalla watchlist "Io" di nessuno.
insert into public.watchlist_adds (title_id, user_name)
select id, added_by from public.titles
where status = 'watchlist' and added_by is not null
on conflict (title_id, user_name) do nothing;
