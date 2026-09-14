-- Il cron "weekly-group-report" (creato dalla migrazione
-- weekly_group_report_cron, applicata direttamente al progetto e mai
-- committata in questo repo — verificato via Supabase MCP) chiama
-- net.http_post verso generate-group-report SENZA nessun controllo
-- sull'intervallo: gira ogni lunedì e rigenera sempre, quindi la Edge
-- Function consuma una chiamata Claude vera ogni settimana, non "una volta
-- all'anno"/ogni N mesi come suggerivano i commenti nel codice client.
--
-- Stesso pattern già usato in Cos90 (maybe_trigger_report_regen): il cron
-- resta settimanale come "sveglia", ma la vera decisione se rigenerare
-- (>= 4 mesi dall'ultimo report di gruppo) si sposta qui, in una funzione
-- SQL che il cron chiama al posto della http_post diretta. Il gesto
-- nascosto dei 7 tap continua a chiamare generate-group-report
-- direttamente da app.js (vedi handleGroupReportRefresh), bypassando
-- questo controllo — è il comportamento voluto per una rigenerazione
-- manuale forzata.

-- security definer: deve poter leggere group_report anche se il cron gira
-- senza un utente anon/autenticato (RLS su quella tabella concede SELECT
-- solo al ruolo "anon"). Legge solo generated_at, nessun dato sensibile.
create or replace function public.maybe_trigger_group_report_regen()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  last_gen timestamptz;
begin
  select generated_at into last_gen
  from public.group_report
  order by generated_at desc
  limit 1;

  if last_gen is null or now() - last_gen >= interval '4 months' then
    -- Stessa chiave anon già usata dal job esistente "weekly-group-report"
    -- (verificata via Supabase MCP, cron.job) — non è un segreto, è
    -- già nel bundle servito a chiunque apra l'app. La Edge Function usa
    -- poi la service_role key (mai esposta) per leggere/scrivere.
    perform net.http_post(
      url := 'https://dxzukpujouayxlomwryc.supabase.co/functions/v1/generate-group-report',
      headers := jsonb_build_object(
        'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImR4enVrcHVqb3VheXhsb213cnljIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODY5NzE4NjQsImV4cCI6MjEwMjU0Nzg2NH0.safhetwN-KiccNBuTznfq9N0LtWMLdY-XmlDetqP1Z8',
        'apikey', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImR4enVrcHVqb3VheXhsb213cnljIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODY5NzE4NjQsImV4cCI6MjEwMjU0Nzg2NH0.safhetwN-KiccNBuTznfq9N0LtWMLdY-XmlDetqP1Z8',
        'Content-Type', 'application/json'
      ),
      body := '{}'::jsonb
    );
  end if;
end;
$$;

-- Sostituisce il comando del job esistente (stesso nome, stesso schedule
-- settimanale) per farlo passare dal controllo sopra invece di chiamare
-- http_post direttamente.
select cron.alter_job(
  (select jobid from cron.job where jobname = 'weekly-group-report'),
  command := $$select public.maybe_trigger_group_report_regen();$$
);
