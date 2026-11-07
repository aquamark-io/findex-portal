# FinDex Portal

Request Access sign-up, admin approval, and passwordless (email code) sign-in for FinDex.
FinDex is independently administered by Aquamark.

Node 20+, Express 4, EJS, Supabase (service role, server-side only), Postmark. Deployed as one Render web service.

## Local development

```bash
npm install
cp .env.example .env   # fill in values
npm run dev
```

`GET /health` returns `{"status":"ok"}`.

## Database

Migrations live in `supabase/migrations/`. Tables are prefixed `fx_`, have RLS enabled with no policies,
and are reachable only through the service role.
