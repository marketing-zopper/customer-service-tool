-- Zopper Service Triage — initial schema
-- All access goes through the backend using the service-role key, so RLS is
-- enabled with NO policies: the anon/authenticated roles can read and write nothing.

create extension if not exists pgcrypto;

-- 'unsorted' = the rules couldn't place it; it waits on the admin-only "Needs sorting" tab
create type category as enum ('partnership', 'complaint_enquiry', 'unsorted');

-- Allowed statuses per category are enforced by the check constraint below
-- (and again in the API layer), instead of separate per-category enum types.
create table mail_items (
  id               uuid primary key default gen_random_uuid(),
  gmail_message_id text unique,
  gmail_thread_id  text,
  -- null only for leads, which belong to neither dashboard view
  category         category,
  status           text not null default 'in_review',
  subject          text,
  sender_email     text not null,
  sender_name      text,
  body_snippet     text,
  body_full        text,
  received_at      timestamptz not null,
  is_lead          boolean not null default false,
  assigned_to      text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  constraint mail_items_category_required check (is_lead or category is not null),
  constraint mail_items_status_valid check (
    category is null
    or (category = 'partnership'       and status in ('in_review', 'accepted', 'rejected'))
    or (category = 'complaint_enquiry' and status in ('in_review', 'escalated_to_team', 'resolved'))
    or (category = 'unsorted'          and status = 'in_review')
  )
);

create index mail_items_view_idx on mail_items (category, received_at desc) where not is_lead;

-- Every Gmail message the poller has looked at, including ones it chose to ignore
-- (auto-replies, spam, newsletters) so they are not re-classified on each run.
create table ingested_messages (
  gmail_message_id text primary key,
  outcome          text not null,
  created_at       timestamptz not null default now()
);

create table magic_links (
  id              uuid primary key default gen_random_uuid(),
  -- SHA-256 of the token that appears in the URL; the raw token is never stored
  token_hash      text unique not null,
  scope           category not null,
  mail_item_id    uuid references mail_items(id) on delete cascade, -- null = whole section
  recipient_email text,
  expires_at      timestamptz,
  created_at      timestamptz not null default now(),
  created_by      text
);

create index magic_links_item_idx on magic_links (mail_item_id);

create table admin_names (
  name text primary key
);

insert into admin_names (name) values
  ('Arpit Jain'),
  ('Vasundhra Khatter'),
  ('Shreesh Singh'),
  ('Ritika Yadav'),
  ('Farman Khan');

create or replace function set_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger mail_items_updated_at
  before update on mail_items
  for each row execute function set_updated_at();

alter table mail_items        enable row level security;
alter table ingested_messages enable row level security;
alter table magic_links       enable row level security;
alter table admin_names       enable row level security;
