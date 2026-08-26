-- Tabella per i report personali generati da Claude (uno o più per utente,
-- tramite la Edge Function "generate-report"). Scrittura solo lato server
-- (service_role, dentro la funzione): il client ha accesso in sola lettura.

create table if not exists public.user_report (
  id bigint generated always as identity primary key,
  user_name text not null,
  generated_at timestamptz not null default now(),
  payload jsonb not null
);

create index if not exists user_report_user_name_idx
  on public.user_report (user_name, generated_at desc);

alter table public.user_report enable row level security;

create policy "Chiunque può leggere i report"
  on public.user_report
  for select
  using (true);
