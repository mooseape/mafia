-- Run this once in the Supabase SQL editor.
-- Re-deals whatever roles start_game just assigned so the host is not always mafia.

create or replace function public.shuffle_room_roles(p_room_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  ids uuid[];
  roles text[];
  i int;
begin
  select array_agg(id order by random())
  into ids
  from public.players
  where room_id = p_room_id;

  select array_agg(role order by random())
  into roles
  from public.players
  where room_id = p_room_id;

  if ids is null or roles is null then
    return;
  end if;

  for i in 1 .. array_length(ids, 1) loop
    update public.players
    set role = roles[i]
    where id = ids[i];
  end loop;
end;
$$;

revoke all on function public.shuffle_room_roles(uuid) from public;
grant execute on function public.shuffle_room_roles(uuid) to anon, authenticated;
