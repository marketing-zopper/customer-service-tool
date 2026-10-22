-- 1. "Needs sorting" is merged into Partnership: anything unsorted becomes a Partnership item.
update mail_items set category = 'partnership' where category = 'unsorted';

-- 2. Both tabs now share one status set: active (default), in_review, notified, resolved.
alter table mail_items drop constraint mail_items_status_valid;

update mail_items set status = case
  when status in ('accepted', 'rejected')    then 'resolved'
  when status = 'escalated_to_team'          then 'notified'
  when status = 'in_review' and assigned_to is not null then 'notified'
  when status = 'in_review'                  then 'active'   -- the old default
  else status
end;

alter table mail_items alter column status set default 'active';
alter table mail_items add constraint mail_items_status_valid
  check (status in ('active', 'in_review', 'notified', 'resolved'));
