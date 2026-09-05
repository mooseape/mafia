-- Run this file by itself. Select all of it. Do not run a collapsed preview.

alter table public.rooms add column if not exists next_status text;
alter table public.rooms add column if not exists next_winner text;
alter table public.rooms add column if not exists next_announcement text;

create table if not exists public.votes (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null,
  voter_id uuid not null,
  target_id uuid not null,
  user_id uuid,
  created_at timestamptz not null default now(),
  unique (room_id, voter_id)
);

create index if not exists votes_room_id_idx on public.votes (room_id);

grant select, insert, update, delete on public.votes to anon, authenticated;

drop function if exists public.submit_vote(uuid);

create or replace function public.submit_vote(p_target_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  me public.players%rowtype;
  living_n int;
  voted_n int;
  top_id uuid;
  top_n int;
  tied boolean;
  victim public.players%rowtype;
  mafia_alive int;
  others_alive int;
  victim_name text;
begin
  select * into me
  from public.players
  where user_id = auth.uid()
    and room_id in (select id from public.rooms where status = 'day')
  limit 1;

  if me.id is null then
    raise exception 'Not in a day vote';
  end if;
  if not coalesce(me.is_alive, true) then
    raise exception 'Dead players cannot vote';
  end if;

  delete from public.votes
  where room_id = me.room_id
    and voter_id = me.id;

  insert into public.votes (room_id, voter_id, target_id, user_id)
  values (me.room_id, me.id, p_target_id, me.user_id);

  select count(*) into living_n
  from public.players
  where room_id = me.room_id and coalesce(is_alive, true);

  select count(distinct voter_id) into voted_n
  from public.votes
  where room_id = me.room_id;

  if voted_n < living_n then
    return;
  end if;

  select s.target_id, s.c into top_id, top_n
  from (
    select v.target_id, count(*)::int as c
    from public.votes v
    where v.room_id = me.room_id
    group by v.target_id
  ) s
  order by s.c desc
  limit 1;

  select count(*) > 1 into tied
  from (
    select count(*)::int as c
    from public.votes v
    where v.room_id = me.room_id
    group by v.target_id
  ) s
  where s.c = top_n;

  if tied or top_id is null then
    delete from public.votes where room_id = me.room_id;
    update public.rooms
    set announcement = 'The vote is tied. Vote again.'
    where id = me.room_id;
    return;
  end if;

  update public.players
  set is_alive = false
  where room_id = me.room_id
    and (id = top_id or user_id = top_id)
  returning * into victim;

  victim_name := coalesce(victim.name, 'Someone');
  delete from public.votes where room_id = me.room_id;

  if victim.role = 'jester' then
    update public.rooms
    set
      status = 'vote_reveal',
      announcement = victim_name || ' was voted out.',
      next_status = 'ended',
      next_winner = 'jester',
      next_announcement = victim_name || ' was voted out. The Jester wins.'
    where id = me.room_id;
    return;
  end if;

  select count(*) into mafia_alive
  from public.players
  where room_id = me.room_id and coalesce(is_alive, true) and role = 'mafia';

  select count(*) into others_alive
  from public.players
  where room_id = me.room_id
    and coalesce(is_alive, true)
    and role is distinct from 'mafia';

  if mafia_alive = 0 then
    update public.rooms
    set
      status = 'vote_reveal',
      announcement = victim_name || ' was voted out.',
      next_status = 'ended',
      next_winner = 'town',
      next_announcement = victim_name || ' was voted out. Town wins.'
    where id = me.room_id;
    return;
  end if;

  if mafia_alive >= others_alive then
    update public.rooms
    set
      status = 'vote_reveal',
      announcement = victim_name || ' was voted out.',
      next_status = 'ended',
      next_winner = 'mafia',
      next_announcement = victim_name || ' was voted out. Mafia wins.'
    where id = me.room_id;
    return;
  end if;

  update public.rooms
  set
    status = 'vote_reveal',
    announcement = victim_name || ' was voted out.',
    next_status = 'night',
    next_winner = null,
    next_announcement = victim_name || ' was voted out. Night falls.'
  where id = me.room_id;
end;
$$;

revoke all on function public.submit_vote(uuid) from public;
grant execute on function public.submit_vote(uuid) to anon, authenticated;

notify pgrst, 'reload schema';
