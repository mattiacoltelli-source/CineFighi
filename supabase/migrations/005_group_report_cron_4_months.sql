-- Cambia la cadenza del cron reale del report di gruppo da settimanale
-- (ogni lunedì alle 6 UTC) a ogni 4 mesi (1° gennaio, maggio, settembre
-- alle 6 UTC). Il report personale non ha un cron lato Supabase: resta
-- gestito solo lato client (maybeAutoRefreshReport in app.js), già a
-- cadenza annuale, quindi non richiede nessuna modifica qui.

select cron.alter_job(job_id := 1, schedule := '0 6 1 */4 *');
