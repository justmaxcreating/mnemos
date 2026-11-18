-- ============================================================
--  Mnemos — Supabase schema
--  Accounts + cloud-synced swipe file + brand rank tracking.
--  Run this once in the Supabase SQL editor (Dashboard → SQL).
--  Safe to re-run: everything is idempotent.
-- ============================================================

-- ---------- Extensions ----------
create extension if not exists "pgcrypto";      -- gen_random_uuid()
-- pg_cron / pg_net are enabled from Dashboard → Database → Extensions
-- (only needed for the optional always-on daily tracker, see track-brands function).

-- ============================================================
--  1. FOLDERS  (swipe-file folders)
-- ============================================================
create table if not exists public.folders (
    user_id     uuid        not null references auth.users (id) on delete cascade,
    id          text        not null,                    -- client-generated id ("f...")
    name        text        not null,
    parent_id   text,                                    -- Eltern-Ordner-id (Baum) oder null = Root
    created_at  timestamptz not null default now(),
    primary key (user_id, id)
);
-- Bestehende Deployments: Spalte nachrüsten (Ordnerstruktur-Update, sicher erneut ausführbar).
alter table public.folders add column if not exists parent_id text;

-- ============================================================
--  2. BRANDS  (watchlist / tracked brands)
-- ============================================================
create table if not exists public.brands (
    user_id     uuid        not null references auth.users (id) on delete cascade,
    id          text        not null,                    -- Meta page_id
    name        text        not null,
    tracked     boolean      not null default true,       -- include in daily rank snapshots
    created_at  timestamptz not null default now(),
    primary key (user_id, id)
);

-- ============================================================
--  3. SAVED ADS  (swipe file — full ad object kept in `data`)
-- ============================================================
create table if not exists public.saved_ads (
    user_id     uuid        not null references auth.users (id) on delete cascade,
    ad_id       text        not null,
    folder      text,                                    -- folder id or null
    data        jsonb       not null,                    -- the full ad object the client renders
    saved_at    timestamptz not null default now(),
    primary key (user_id, ad_id)
);

-- ============================================================
--  4. BRAND SNAPSHOTS  (the Parker-style rank history)
--     One row per (brand, day, ad). Rank is computed within
--     the brand for that day (1 = highest reach / impressions).
-- ============================================================
create table if not exists public.brand_snapshots (
    user_id         uuid        not null references auth.users (id) on delete cascade,
    brand_id        text        not null,
    snapshot_date   date        not null default current_date,
    ad_id           text        not null,
    page_name       text,
    headline        text,
    reach           bigint,                              -- eu_total_reach (EU) — best public signal
    impressions     text,                                -- ScrapeCreators impressions_text, if present
    runtime_days    integer,
    is_active       boolean     not null default true,
    rank            integer,                             -- 1-based rank within brand for that day
    created_at      timestamptz not null default now(),
    primary key (user_id, brand_id, snapshot_date, ad_id)
);

create index if not exists brand_snapshots_lookup
    on public.brand_snapshots (user_id, brand_id, snapshot_date desc);

-- ============================================================
--  5. USER SECRETS  (optional — only for the always-on cron)
--     Holds the Meta token so the scheduled Edge Function can
--     fetch on the user's behalf. Never exposed to the client.
-- ============================================================
create table if not exists public.user_secrets (
    user_id     uuid        primary key references auth.users (id) on delete cascade,
    meta_token  text,
    country     text        not null default 'DE',
    updated_at  timestamptz not null default now()
);

-- ============================================================
--  ROW LEVEL SECURITY  — every table: a user only sees their rows
-- ============================================================
alter table public.folders          enable row level security;
alter table public.brands           enable row level security;
alter table public.saved_ads        enable row level security;
alter table public.brand_snapshots  enable row level security;
alter table public.user_secrets     enable row level security;

-- Helper: create an "owner can do everything" policy per table.
do $$
declare t text;
begin
    foreach t in array array['folders','brands','saved_ads','brand_snapshots','user_secrets']
    loop
        execute format('drop policy if exists "own rows select" on public.%I;', t);
        execute format('drop policy if exists "own rows insert" on public.%I;', t);
        execute format('drop policy if exists "own rows update" on public.%I;', t);
        execute format('drop policy if exists "own rows delete" on public.%I;', t);

        execute format($p$create policy "own rows select" on public.%I
            for select using (auth.uid() = user_id);$p$, t);
        execute format($p$create policy "own rows insert" on public.%I
            for insert with check (auth.uid() = user_id);$p$, t);
        execute format($p$create policy "own rows update" on public.%I
            for update using (auth.uid() = user_id) with check (auth.uid() = user_id);$p$, t);
        execute format($p$create policy "own rows delete" on public.%I
            for delete using (auth.uid() = user_id);$p$, t);
    end loop;
end $$;

-- The Edge Function uses the service-role key, which bypasses RLS by design,
-- so no extra policy is needed for the background tracker.
