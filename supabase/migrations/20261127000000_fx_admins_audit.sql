-- Named admins and an append-only admin audit log.
--
-- fx_admins             one row per admin (name, email, active/disabled). Admins are disabled, never deleted,
--                       so their name stays attached to past audit entries.
-- fx_admin_login_codes  emailed one-time sign-in codes for admins (stored as HMAC, never plaintext).
-- fx_admin_audit        one row per admin action. Rows can't be changed or deleted: a trigger rejects every
--                       update, delete and truncate, including from the service role.
--
-- The first admin is the email in the ADMIN_OWNER_EMAIL Render setting; the app creates their row on first sign-in.
-- Same access model as the other fx_ tables: RLS on, no policies, no grants to anon/authenticated.

create table public.fx_admins (
  id             uuid primary key default gen_random_uuid(),
  name           text not null check (length(name) between 1 and 120),
  email          text not null unique check (email = lower(email)),
  status         text not null default 'active' check (status in ('active', 'disabled')),
  added_by       uuid references public.fx_admins (id),
  last_login_at  timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create trigger fx_admins_touch before update on public.fx_admins
  for each row execute function public.fx_touch_updated_at();

create table public.fx_admin_login_codes (
  id          uuid primary key default gen_random_uuid(),
  admin_id    uuid not null references public.fx_admins (id) on delete cascade,
  code_hash   text not null,
  expires_at  timestamptz not null,
  attempts    int not null default 0,
  used_at     timestamptz,
  ip          text,
  created_at  timestamptz not null default now()
);

create index fx_admin_login_codes_admin_created_idx on public.fx_admin_login_codes (admin_id, created_at desc);

-- admin_id is null for sign-ins with the old shared password (admin_name 'Shared password').
-- target_id is plain text, not a foreign key, so deleting test records never changes an audit row.
create table public.fx_admin_audit (
  id           bigint generated always as identity primary key,
  admin_id     uuid references public.fx_admins (id),
  admin_name   text not null,
  admin_email  text,
  action       text not null,
  target_type  text,
  target_id    text,
  detail       jsonb not null default '{}'::jsonb,
  ip           text,
  created_at   timestamptz not null default now()
);

create index fx_admin_audit_created_idx on public.fx_admin_audit (created_at desc);
create index fx_admin_audit_admin_idx on public.fx_admin_audit (admin_id, created_at desc);
create index fx_admin_audit_action_idx on public.fx_admin_audit (action, created_at desc);

create or replace function public.fx_admin_audit_append_only() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'fx_admin_audit is append-only: entries cannot be changed or deleted';
end $$;

create trigger fx_admin_audit_no_update before update or delete on public.fx_admin_audit
  for each row execute function public.fx_admin_audit_append_only();
create trigger fx_admin_audit_no_truncate before truncate on public.fx_admin_audit
  for each statement execute function public.fx_admin_audit_append_only();

alter table public.fx_admins            enable row level security;
alter table public.fx_admin_login_codes enable row level security;
alter table public.fx_admin_audit       enable row level security;

revoke all on public.fx_admins, public.fx_admin_login_codes, public.fx_admin_audit from anon, authenticated;
revoke all on function public.fx_admin_audit_append_only() from public, anon, authenticated;
