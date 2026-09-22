-- Private bucket for direct Zyvano chat attachments.
-- The backend uses the server-only Supabase service role to upload and issue
-- short-lived signed download URLs. Do not expose the service role key to clients.

insert into storage.buckets (id, name, public)
values ('zyvano-chat', 'zyvano-chat', false)
on conflict (id) do update set public = false;
