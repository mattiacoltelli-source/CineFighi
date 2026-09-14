-- Tabella per il report di gruppo generato da Claude (un record per
-- generazione, niente user_name: è uno solo condiviso da tutto il gruppo),
-- tramite la Edge Function "generate-group-report". Stesso schema di
-- accesso di user_report: scrittura solo lato server (service_role, dentro
-- la funzione), il client ha accesso in sola lettura.

create table if not exists public.group_report (
  id bigint generated always as identity primary key,
  generated_at timestamptz not null default now(),
  payload jsonb not null
);

create index if not exists group_report_generated_at_idx
  on public.group_report (generated_at desc);

alter table public.group_report enable row level security;

create policy "Chiunque può leggere il report di gruppo"
  on public.group_report
  for select
  using (true);
