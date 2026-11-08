-- FinDex phase two, step 2: notices to reported parties, and links between reported parties and accounts.
-- Same access model: RLS on, no policies, no grants to anon/authenticated.

-- ---------------------------------------------------------------------------
-- fx_notices: every notice sent (or to be mailed) about a report. A report can have several,
-- e.g. an email that bounced, then a second email or a mailed letter.
-- ---------------------------------------------------------------------------
create table public.fx_notices (
  id                   uuid primary key default gen_random_uuid(),
  report_id            uuid not null references public.fx_reports (id) on delete cascade,
  channel              text not null check (channel in ('email', 'mail')),
  email                text check (email = lower(email)),
  mailing_address      text,
  status               text not null check (status in (
                         'sent',        -- email handed to Postmark
                         'bounced',     -- Postmark reported a hard bounce
                         'failed',      -- Postmark refused to send
                         'to_mail',     -- reporter gave a mailing address; waiting for admin to post it
                         'mailed'       -- admin marked the letter as posted
                       )),
  postmark_message_id  text unique,
  bounce_detail        text,
  sent_at              timestamptz,
  bounced_at           timestamptz,
  mailed_at            timestamptz,
  created_at           timestamptz not null default now(),
  constraint fx_notices_channel check (
    (channel = 'email' and email is not null) or (channel = 'mail' and mailing_address is not null)
  )
);
create index fx_notices_report_idx on public.fx_notices (report_id, created_at desc);
create index fx_notices_status_idx on public.fx_notices (status) where status in ('bounced', 'to_mail');

-- ---------------------------------------------------------------------------
-- fx_subject_links: which account is the reported party, so they can see reports about themselves.
-- Created automatically when an approved account matches a subject (same notice email, same
-- DOB + SSN last 4, same EIN, or same company domain), or by the admin.
-- ---------------------------------------------------------------------------
create table public.fx_subject_links (
  subject_id  uuid not null references public.fx_subjects (id) on delete cascade,
  account_id  uuid not null references public.fx_accounts (id) on delete cascade,
  linked_by   text not null check (linked_by in ('email', 'identity', 'domain', 'admin')),
  created_at  timestamptz not null default now(),
  primary key (subject_id, account_id)
);
create index fx_subject_links_account_idx on public.fx_subject_links (account_id);

alter table public.fx_notices       enable row level security;
alter table public.fx_subject_links enable row level security;
revoke all on public.fx_notices, public.fx_subject_links from anon, authenticated;
