-- Run this file by itself. After Game over, the host can keep the same room.

create or replace function public.return_to_lobby()
returns void
language plpgsql
security definer
set search_path = public
as $fn_lobby$
declare
  rid uuid;
  hosty boolean;
  st text;
begin
  select p.room_id, p.is_host into rid, hosty
  from public.players p
  where p.user_id = auth.uid()
  order by p.created_at desc
  limit 1;

  if rid is null then
    raise exception 'Not in a room';
  end if;
  if not coalesce(hosty, false) then
    raise exception 'Only the host can start another game';
  end if;

  select r.status into st from public.rooms r where r.id = rid;
  if st is distinct from 'ended' then
    return;
  end if;

  begin
    delete from public.votes where room_id = rid;
  exception
    when undefined_table then
      null;
  end;
  begin
    delete from public.night_actions where room_id = rid;
  exception
    when undefined_table then
      null;
  end;
  begin
    delete from public.private_notes where room_id = rid;
  exception
    when undefined_table then
      null;
  end;

  update public.players
  set
    role = null,
    is_alive = true
  where room_id = rid;

  update public.rooms
  set
    status = 'lobby',
    discuss_seconds = 150,
    discuss_ends_at = null,
    next_status = null,
    next_winner = null,
    next_announcement = null
  where id = rid;
end;
$fn_lobby$;

revoke all on function public.return_to_lobby() from public;
grant execute on function public.return_to_lobby() to anon, authenticated;

notify pgrst, 'reload schema';
