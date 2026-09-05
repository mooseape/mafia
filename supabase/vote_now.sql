-- Run this file by itself in the SQL editor.
-- Hosts can start the day vote immediately. Everyone else waits out the timer.

drop function if exists public.begin_day();

create or replace function public.begin_day()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  rid uuid;
  st text;
  ends_at timestamptz;
  hostish boolean;
begin
  select p.room_id, r.status, r.discuss_ends_at,
         (coalesce(p.is_host, false) or r.host_id = auth.uid())
    into rid, st, ends_at, hostish
  from public.players p
  join public.rooms r on r.id = p.room_id
  where p.user_id = auth.uid()
    and r.status in ('dawn', 'discuss', 'day')
  limit 1;

  if rid is null then
    raise exception 'Not in a room';
  end if;

  if st = 'day' then
    return;
  end if;

  if not hostish and ends_at is not null and now() < ends_at then
    return;
  end if;

  begin
    delete from public.votes where room_id = rid;
  exception
    when others then
      null;
  end;

  update public.rooms
  set
    status = 'day',
    discuss_ends_at = null
  where id = rid
    and status in ('dawn', 'discuss');
end;
$$;

revoke all on function public.begin_day() from public;
grant execute on function public.begin_day() to anon, authenticated;
