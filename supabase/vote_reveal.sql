-- Run this file by itself. Select all of it.

alter table public.rooms add column if not exists next_status text;
alter table public.rooms add column if not exists next_winner text;
alter table public.rooms add column if not exists next_announcement text;

drop function if exists public.finish_vote_reveal();

create or replace function public.finish_vote_reveal()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  rid uuid;
  nxt text;
  win text;
  ann text;
  st text;
begin
  select p.room_id into rid
  from public.players p
  where p.user_id = auth.uid()
  limit 1;

  if rid is null then
    return;
  end if;

  select r.status, r.next_status, r.next_winner, r.next_announcement
    into st, nxt, win, ann
  from public.rooms r
  where r.id = rid;

  if st is distinct from 'vote_reveal' then
    return;
  end if;

  update public.rooms
  set
    status = coalesce(nxt, 'night'),
    winner = win,
    announcement = coalesce(ann, announcement),
    next_status = null,
    next_winner = null,
    next_announcement = null
  where id = rid
    and status = 'vote_reveal';
end;
$$;

revoke all on function public.finish_vote_reveal() from public;
grant execute on function public.finish_vote_reveal() to anon, authenticated;

notify pgrst, 'reload schema';
