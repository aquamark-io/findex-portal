-- Drop the slow pay category, and store Claude's evidence-review summaries (an aid for the admin; never a decision).
alter table public.fx_reports drop constraint fx_reports_category_check;
alter table public.fx_reports add constraint fx_reports_category_check check (category in (
  'data_theft', 'merchant_deception', 'fraud', 'data_mishandling', 'missed_payments', 'default'
));

create table public.fx_evidence_reviews (
  id              uuid primary key default gen_random_uuid(),
  report_id       uuid not null references public.fx_reports (id) on delete cascade,
  status          text not null check (status in ('running', 'complete', 'failed')),
  model           text not null,
  prompt_version  text not null,
  result          jsonb,                 -- summary, per-file notes, checks, concerns, missing
  files_reviewed  integer not null default 0,
  files_skipped   jsonb not null default '[]'::jsonb,
  error           text,
  input_tokens    integer,
  output_tokens   integer,
  requested_by    text not null check (requested_by in ('system', 'admin')),
  created_at      timestamptz not null default now(),
  completed_at    timestamptz
);
create index fx_evidence_reviews_report_idx on public.fx_evidence_reviews (report_id, created_at desc);

alter table public.fx_evidence_reviews enable row level security;
revoke all on public.fx_evidence_reviews from anon, authenticated;
