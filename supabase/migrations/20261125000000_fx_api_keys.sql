-- Default-search API for approved companies.
-- Keys are issued by an admin from the account page and shown once. Only an HMAC of the key is stored
-- (FIELD_HASH_KEY), plus a short prefix so a key can be recognized in the admin list.
-- The server (service role) is the only reader: RLS on, no policies.

create table if not exists public.fx_api_keys (
  id            uuid primary key default gen_random_uuid(),
  account_id    uuid not null references public.fx_accounts (id) on delete cascade,
  label         text not null check (char_length(label) between 1 and 100),
  key_prefix    text not null check (key_prefix ~ '^fdx_[A-Za-z0-9_-]{6}$'),
  key_hash      text not null unique check (key_hash ~ '^[0-9a-f]{64}$'),
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz,
  revoked_at    timestamptz
);
create index if not exists fx_api_keys_account_idx on public.fx_api_keys (account_id);
alter table public.fx_api_keys enable row level security;

-- Each API lookup is logged like a portal search, with the key that ran it.
alter table public.fx_searches add column if not exists api_key_id uuid references public.fx_api_keys (id) on delete set null;
create index if not exists fx_searches_api_key_idx on public.fx_searches (api_key_id) where api_key_id is not null;
