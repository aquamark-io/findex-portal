-- FinDex phase two, step 4: disputes. RLS on, no policies, no grants to anon/authenticated.
create table public.fx_disputes (
  id                     uuid primary key default gen_random_uuid(),
  report_id              uuid not null references public.fx_reports (id) on delete cascade,
  account_id             uuid not null references public.fx_accounts (id) on delete restrict,  -- the reported party who disputed
  reason                 text not null check (char_length(reason) between 20 and 5000),
  prior_status           text not null check (prior_status in ('notice_sent', 'published')),
  status                 text not null default 'open' check (status in ('open', 'upheld', 'amended', 'removed')),
  due_at                 timestamptz not null,           -- 30 days after the dispute was opened
  reporter_response      text,
  reporter_responded_at  timestamptz,
  resolution_note        text,                           -- shared with both sides
  resolved_at            timestamptz,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  constraint fx_disputes_resolved check (status = 'open' or (resolution_note is not null and resolved_at is not null))
);
create unique index fx_disputes_one_open_uq on public.fx_disputes (report_id) where status = 'open';
create index fx_disputes_status_due_idx on public.fx_disputes (status, due_at);
create trigger fx_disputes_touch before update on public.fx_disputes for each row execute function public.fx_touch_updated_at();

create table public.fx_dispute_files (
  id            uuid primary key default gen_random_uuid(),
  dispute_id    uuid not null references public.fx_disputes (id) on delete cascade,
  party         text not null check (party in ('subject', 'reporter')),
  storage_path  text not null unique,
  file_name     text not null,
  mime_type     text not null,
  size_bytes    integer not null check (size_bytes > 0),
  sha256        text not null,
  created_at    timestamptz not null default now()
);
create index fx_dispute_files_dispute_idx on public.fx_dispute_files (dispute_id);

alter table public.fx_disputes      enable row level security;
alter table public.fx_dispute_files enable row level security;
revoke all on public.fx_disputes, public.fx_dispute_files from anon, authenticated;
