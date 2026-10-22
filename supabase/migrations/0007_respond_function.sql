-- Saving a reply is one step: the comment (with the status it set) and the item's new status and
-- comment count either all happen or none do. Two separate calls could leave a comment recorded
-- without the status change it claims to have made.
create or replace function respond_to_item(
  p_item   uuid,
  p_author text,
  p_role   text,
  p_body   text,
  p_status text
) returns json
language plpgsql
as $$
declare
  saved item_comments;
begin
  insert into item_comments (mail_item_id, author, author_role, body, status_set)
  values (p_item, p_author, p_role, p_body, p_status)
  returning * into saved;

  update mail_items
     set status        = coalesce(p_status, status),
         comment_count = comment_count + (case when p_body is not null then 1 else 0 end)
   where id = p_item;

  return json_build_object(
    'id', saved.id, 'author', saved.author, 'author_role', saved.author_role,
    'body', saved.body, 'status_set', saved.status_set, 'created_at', saved.created_at
  );
end;
$$;

-- The API exposes database functions to anyone by default. This one must only run from our backend.
revoke execute on function respond_to_item(uuid, text, text, text, text) from public, anon, authenticated;
grant  execute on function respond_to_item(uuid, text, text, text, text) to service_role;
