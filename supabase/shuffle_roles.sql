-- Run this file by itself in the SQL editor (not pasted onto another script).

create or replace function public.shuffle_room_roles(p_room_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.players p
  set role = d.role
  from (
    select p2.id, d2.role
    from (
      select id, row_number() over (order by random()) as n
      from public.players
      where room_id = p_room_id
    ) p2
    join (
      select role, row_number() over (order by random()) as n
      from public.players
      where room_id = p_room_id
    ) d2 on d2.n = p2.n
  ) d
  where p.id = d.id;
end;
$$;

revoke all on function public.shuffle_room_roles(uuid) from public;
grant execute on function public.shuffle_room_roles(uuid) to anon, authenticated;
