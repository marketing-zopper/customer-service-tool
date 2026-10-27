-- Deleting a comment is one step too: the comment goes and the item's comment count drops with it,
-- but only if the comment was written by the person asking (checked here as well as in the API).
-- Status-only entries (no text) are a record of a change and can't be deleted.
create or replace function delete_item_comment(
  p_item    uuid,
  p_comment uuid,
  p_author  text,
  p_role    text
) returns boolean
language plpgsql
as $$
declare
  removed uuid;
begin
  delete from item_comments
   where id = p_comment
     and mail_item_id = p_item
     and author = p_author
     and author_role = p_role
     and body is not null
  returning id into removed;

  if removed is null then
    return false;
  end if;

  update mail_items set comment_count = greatest(comment_count - 1, 0) where id = p_item;
  return true;
end;
$$;

revoke execute on function delete_item_comment(uuid, uuid, text, text) from public, anon, authenticated;
grant  execute on function delete_item_comment(uuid, uuid, text, text) to service_role;
