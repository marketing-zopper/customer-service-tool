-- Comments left by the person a query was escalated to (and, if ever needed, by the team), each
-- optionally recorded together with the status they set at the same time.
create table item_comments (
  id           uuid primary key default gen_random_uuid(),
  mail_item_id uuid not null references mail_items(id) on delete cascade,
  author       text not null,                       -- the responder's email, or a team member's name
  author_role  text not null check (author_role in ('responder', 'team')),
  body         text check (body is null or char_length(body) <= 2000),
  status_set   text check (status_set in ('active', 'in_review', 'notified', 'resolved')),
  created_at   timestamptz not null default now(),
  constraint item_comments_has_content check (body is not null or status_set is not null)
);

create index item_comments_item_idx on item_comments (mail_item_id, created_at);

-- Same as every other table: only the backend (service role) can read or write it.
alter table item_comments enable row level security;

-- How many written comments an item has, so the list can show a badge without extra queries.
alter table mail_items add column comment_count integer not null default 0;
