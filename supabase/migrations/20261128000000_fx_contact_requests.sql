-- Contact form (app.joinfindex.com/contact): one row per message. Reference shown to the sender = FX- + the first
-- 6 characters of the id. Admins work them at /admin/contact (open / in progress / closed, internal note).
-- Same access model as the other fx_ tables: RLS on, no policies, no grants to anon/authenticated.

create table public.fx_contact_requests (
  id             uuid primary key default gen_random_uuid(),
  account_id     uuid references public.fx_accounts (id) on delete set null,  -- signed in, or the email matches an account
  name           text,
  contact_email  text not null check (contact_email = lower(contact_email)),
  topic          text not null check (topic in ('account_access', 'access_request', 'report_about_me', 'report_i_submitted',
                                                'search_api', 'my_information', 'other')),
  message        text not null check (length(message) between 1 and 5000),
  status         text not null default 'open' check (status in ('open', 'in_progress', 'closed')),
  admin_note     text,
  ip             text,
  closed_at      timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index fx_contact_requests_status_idx on public.fx_contact_requests (status, created_at desc);
create index fx_contact_requests_account_idx on public.fx_contact_requests (account_id) where account_id is not null;

create trigger fx_contact_requests_touch before update on public.fx_contact_requests
  for each row execute function public.fx_touch_updated_at();

alter table public.fx_contact_requests enable row level security;
revoke all on public.fx_contact_requests from anon, authenticated;
