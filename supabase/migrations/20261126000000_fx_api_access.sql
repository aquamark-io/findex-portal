-- API access requests. A company asks from its dashboard; an admin approves or denies in /admin/api; once approved,
-- the company creates and revokes its own keys (fx_api_keys), so no one else ever sees a key.
-- One row per company. Server (service role) only: RLS on, no policies.

create table if not exists public.fx_api_access (
  account_id     uuid primary key references public.fx_accounts (id) on delete cascade,
  status         text not null check (status in ('requested', 'approved', 'denied', 'revoked')),
  use_note       text check (use_note is null or char_length(use_note) <= 1000),   -- "How will you use it?" (company)
  requested_at   timestamptz not null default now(),
  decided_at     timestamptz,
  decision_note  text check (decision_note is null or char_length(decision_note) <= 2000) -- internal, never emailed
);
create index if not exists fx_api_access_status_idx on public.fx_api_access (status, requested_at desc);
alter table public.fx_api_access enable row level security;
