-- Social publishing schema (PRD section 10.1)
-- RLS on, no policies: only server code using the service role touches these tables.
-- Browsers never write. This migration is the reference copy for local development;
-- the site repo (Track A) owns the authoritative migration in production.

-- Brands
create table social_brands (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null,
  name text not null,
  logo_path text,
  created_at timestamptz default now()
);
alter table social_brands enable row level security;

-- Accounts (connected social channels)
create table social_accounts (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid references social_brands(id),
  platform text not null, -- facebook, instagram, linkedin-page, x, devto, hashnode, substack, producthunt
  mode text not null default 'auto' check (mode in ('auto', 'manual')),
  status text not null default 'connected' check (status in ('connected', 'reconnect_required', 'developer_setup_required', 'approval_pending', 'manual')),
  postiz_integration_id text unique,
  display_name text not null,
  picture_url text,
  profile_url text,
  open_editor_url text,
  daily_cap int not null default 5 check (daily_cap between 1 and 5),
  paused boolean not null default false,
  rules jsonb default '{}',
  last_synced_at timestamptz,
  created_at timestamptz default now()
);
alter table social_accounts enable row level security;

-- Media (images for posts)
create table social_media (
  id uuid primary key default gen_random_uuid(),
  kind text not null default 'image' check (kind in ('image')),
  source text not null check (source in ('generated', 'upload')),
  storage_path text not null,
  mime text not null,
  width int,
  height int,
  bytes int,
  sha256 text not null,
  alt_text text,
  card_spec jsonb,
  format text, -- square, portrait, x, devto_cover, hashnode_cover, ph_gallery
  created_by uuid,
  created_at timestamptz default now()
);
alter table social_media enable row level security;

-- Generation requests
create table social_generation_requests (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null references social_brands(id),
  input jsonb not null,
  status text not null default 'queued' check (status in ('queued', 'running', 'done', 'failed')),
  requested_by uuid,
  workflow text,
  event_id text,
  lease_owner text,
  lease_expires_at timestamptz,
  attempts int not null default 0,
  error_code text,
  error_message text,
  finished_at timestamptz,
  created_at timestamptz default now(),
  unique(workflow, event_id)
);
alter table social_generation_requests enable row level security;

-- Posts
create table social_posts (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null references social_brands(id),
  kind text not null default 'social' check (kind in ('social', 'article', 'launch')),
  title text,
  source_url text,
  generation_request_id uuid references social_generation_requests(id),
  generation_ref text unique, -- request_id + client_ref for idempotency
  status text not null default 'draft' check (status in ('draft', 'approved', 'publishing', 'published', 'partial', 'failed', 'cancelled')),
  current_revision_id uuid,
  created_by uuid,
  created_at timestamptz default now()
);
alter table social_posts enable row level security;

-- Revisions (immutable once approved)
create table social_post_revisions (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references social_posts(id) on delete cascade,
  number int not null default 1,
  canonical_text text,
  body_markdown text,
  created_by uuid,
  created_at timestamptz default now(),
  unique(post_id, number)
);
alter table social_post_revisions enable row level security;

-- Update post.current_revision_id FK after both tables exist
alter table social_posts
  add constraint fk_current_revision
  foreign key (current_revision_id) references social_post_revisions(id);

-- Destinations (per-account version of a revision)
create table social_destinations (
  id uuid primary key default gen_random_uuid(),
  revision_id uuid not null references social_post_revisions(id) on delete cascade,
  account_id uuid not null references social_accounts(id),
  text text not null,
  settings jsonb not null default '{}',
  scheduled_at timestamptz,
  scheduled_tz text not null default 'Europe/Bucharest',
  contains_figures boolean not null default false,
  figures jsonb default '[]',
  validation jsonb default '{}',
  destination_hash text
);
alter table social_destinations enable row level security;

-- Destination media (ordered)
create table social_destination_media (
  destination_id uuid not null references social_destinations(id) on delete cascade,
  media_id uuid not null references social_media(id),
  position int not null,
  primary key (destination_id, position)
);
alter table social_destination_media enable row level security;

-- Approvals
create table social_approvals (
  id uuid primary key default gen_random_uuid(),
  revision_id uuid not null references social_post_revisions(id),
  approved_by uuid not null,
  approved_at timestamptz not null default now(),
  approval_hash text not null,
  figures_checked boolean not null default false,
  revoked_at timestamptz,
  revoked_reason text
);
alter table social_approvals enable row level security;

-- Delivery jobs (one per destination, unique constraint prevents duplicates)
create table social_delivery_jobs (
  id uuid primary key default gen_random_uuid(),
  destination_id uuid unique not null references social_destinations(id),
  status text not null default 'queued' check (status in (
    'queued', 'claimed', 'submitting', 'submitted',
    'published', 'failed', 'reconciling', 'cancelled',
    'manual_pending', 'manual_done'
  )),
  run_at timestamptz not null,
  stale_after interval not null default '2 hours',
  attempts int not null default 0,
  lease_owner text,
  lease_expires_at timestamptz,
  postiz_post_id text,
  postiz_group text,
  remote_url text,
  published_at timestamptz,
  last_error_code text,
  last_error_message text,
  manual_done_by uuid,
  manual_done_at timestamptz,
  created_at timestamptz default now()
);
alter table social_delivery_jobs enable row level security;

-- Publish attempts (audit trail)
create table social_publish_attempts (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references social_delivery_jobs(id),
  attempt_no int not null,
  worker_id text,
  started_at timestamptz not null default now(),
  submitting_at timestamptz,
  finished_at timestamptz,
  outcome text, -- published, failed, retry, reconciling, not_found
  error_code text,
  http_status int,
  details jsonb,
  unique(job_id, attempt_no)
);
alter table social_publish_attempts enable row level security;

-- Events (outbox)
create table social_events (
  id bigserial primary key,
  type text not null,
  payload jsonb not null default '{}',
  seen boolean not null default false,
  created_at timestamptz not null default now()
);
alter table social_events enable row level security;

-- Workers
create table social_workers (
  worker_id text primary key,
  version text,
  last_seen_at timestamptz not null default now()
);
alter table social_workers enable row level security;

-- Seed brands
insert into social_brands (slug, name) values
  ('the-crypto-support', 'The Crypto Support'),
  ('taxes-support', 'Taxes Support'),
  ('comets-of-web3', 'Comets of Web3');
