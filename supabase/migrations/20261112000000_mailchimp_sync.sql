-- Mailchimp sync for CardCue Pro.
--
-- waitlist: every new signup is sent to the mailchimp-sync edge function.
-- profiles: app users are sent ONLY once they opt in (marketing_opt_in), and again
--           when they opt out, change email, change plan or name, or delete the account.
--           Nobody is added to Mailchimp without opting in.
--
-- Same shape as on_waitlist_signup_notify: pg_net + two vault secrets, and the
-- signup or profile write never fails because of the sync.
--   vault secret 'mailchimp_sync_url'  = https://<ref>.supabase.co/functions/v1/mailchimp-sync
--   vault secret 'service_role_key'    = already present

alter table public.profiles
  add column if not exists marketing_opt_in boolean not null default false,
  add column if not exists marketing_opt_in_at timestamptz;

comment on column public.profiles.marketing_opt_in is
  'The user asked for CardCue marketing email. Only opted-in accounts reach Mailchimp (mailchimp-sync).';
comment on column public.profiles.marketing_opt_in_at is
  'When marketing_opt_in last changed. Set by trigger; a record of consent.';

-- Stamp the consent time whenever the flag changes.
create or replace function public._stamp_marketing_opt_in()
returns trigger language plpgsql set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    if new.marketing_opt_in then new.marketing_opt_in_at := now(); end if;
  elsif new.marketing_opt_in is distinct from old.marketing_opt_in then
    new.marketing_opt_in_at := now();
  end if;
  return new;
end $$;

drop trigger if exists trg_stamp_marketing_opt_in on public.profiles;
create trigger trg_stamp_marketing_opt_in
  before insert or update of marketing_opt_in on public.profiles
  for each row execute function public._stamp_marketing_opt_in();

-- POST one record to mailchimp-sync. Swallows every error.
create or replace function public._mailchimp_sync_post(payload jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare
  sync_url    text;
  service_key text;
begin
  select decrypted_secret into sync_url from vault.decrypted_secrets where name = 'mailchimp_sync_url';
  select decrypted_secret into service_key from vault.decrypted_secrets where name = 'service_role_key';
  if coalesce(sync_url, '') = '' or coalesce(service_key, '') = '' then
    raise warning '_mailchimp_sync_post: vault secrets missing, sync skipped';
    return;
  end if;
  perform net.http_post(
    url     := sync_url,
    headers := jsonb_build_object('Authorization', 'Bearer ' || service_key,
                                  'Content-Type', 'application/json'),
    body    := payload
  );
exception when others then
  raise warning '_mailchimp_sync_post: sync skipped, SQLSTATE %', sqlstate;
end $$;

revoke all on function public._mailchimp_sync_post(jsonb) from public, anon, authenticated;

create or replace function public.on_waitlist_mailchimp_sync()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform public._mailchimp_sync_post(jsonb_build_object(
    'kind', 'waitlist',
    'name', new.name,
    'email', new.email,
    'source', new.source,
    'wants_to_test', new.wants_to_test
  ));
  return new;
end $$;

drop trigger if exists waitlist_mailchimp_sync on public.waitlist;
create trigger waitlist_mailchimp_sync
  after insert on public.waitlist
  for each row execute function public.on_waitlist_mailchimp_sync();

create or replace function public.on_profile_mailchimp_sync()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  relevant boolean;
begin
  if tg_op = 'DELETE' then
    if not old.marketing_opt_in then return old; end if;
    perform public._mailchimp_sync_post(jsonb_build_object(
      'kind', 'profile', 'email', old.email, 'old_email', null,
      'display_name', old.display_name, 'pro_subscriber', old.pro_subscriber,
      'marketing_opt_in', false, 'deletion_requested', true));
    return old;
  end if;

  if tg_op = 'INSERT' then
    relevant := new.marketing_opt_in;
  else
    relevant :=
      new.marketing_opt_in is distinct from old.marketing_opt_in
      or (old.marketing_opt_in and (
            new.email is distinct from old.email
         or new.display_name is distinct from old.display_name
         or new.pro_subscriber is distinct from old.pro_subscriber
         or (new.deletion_requested_at is not null and old.deletion_requested_at is null)));
  end if;
  if not relevant then return new; end if;

  perform public._mailchimp_sync_post(jsonb_build_object(
    'kind', 'profile',
    'email', new.email,
    'old_email', case when tg_op = 'UPDATE' and old.marketing_opt_in
                       and new.email is distinct from old.email then old.email end,
    'display_name', new.display_name,
    'pro_subscriber', new.pro_subscriber,
    'marketing_opt_in', new.marketing_opt_in,
    'deletion_requested', new.deletion_requested_at is not null
  ));
  return new;
end $$;

drop trigger if exists profiles_mailchimp_sync on public.profiles;
create trigger profiles_mailchimp_sync
  after insert or update or delete on public.profiles
  for each row execute function public.on_profile_mailchimp_sync();
