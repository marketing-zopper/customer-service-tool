-- Whether the escalation email actually went out ('sent' | 'failed'), so the dashboard never
-- claims an item was escalated to someone who was never emailed. Null = escalated before this existed.
alter table mail_items add column assigned_email_status text
  check (assigned_email_status in ('sent', 'failed'));
