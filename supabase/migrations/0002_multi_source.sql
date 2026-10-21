-- Items can now come from more than one place (Gmail, Webflow forms), so the Gmail-specific
-- columns become generic. Webflow ids are stored as 'webflow:<submission id>'.

alter table mail_items rename column gmail_message_id to source_id;
alter table mail_items rename column gmail_thread_id  to source_thread_id;
alter table mail_items add column source text not null default 'gmail';

alter table ingested_messages rename column gmail_message_id to source_id;
alter table ingested_messages add column source text not null default 'gmail';
