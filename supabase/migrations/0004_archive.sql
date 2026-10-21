-- Archived items drop out of the active Partnership / Complaints lists but stay restorable.
alter table mail_items add column archived_at timestamptz;
create index mail_items_archived_idx on mail_items (category, archived_at) where archived_at is not null;
