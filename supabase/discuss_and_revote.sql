-- Run the whole file once in the Supabase SQL editor (don't split it).

alter table public.rooms
  add column if not exists discuss_seconds int not null default 150;

alter table public.rooms
  add column if not exists discuss_ends_at timestamptz;

drop trigger if exists trg_rooms_set_discuss_ends_at on public.rooms;
drop function if exists public.rooms_set_discuss_ends_at();
drop function if exists public.maybe_begin_day();
drop function if exists public.submit_vote(uuid);

create or replace function public.rooms_set_discuss_ends_at()
returns trigger
language plpgsql
as $fn_rooms$
begin
  if new.status = 'dawn' and (old.status is distinct from 'dawn') then
    new.discuss_ends_at :=
      now() + make_interval(secs => coalesce(new.discuss_seconds, 150));
  end if;
  return new;
end;
$fn_rooms$;

create trigger trg_rooms_set_discuss_ends_at
before update of status on public.rooms
for each row
execute procedure public.rooms_set_discuss_ends_at();

create or replace function public.maybe_begin_day()
returns void
language plpgsql
security definer
set search_path = public
as $fn_day$
declare
  rid uuid;
  ends_at timestamptz;
  st text;
begin
  select p.room_id into rid
  from public.players p
  where p.user_id = auth.uid()
  order by p.created_at desc
  limit 1;

  if rid is null then
    raise exception 'Not in a room';
  end if;

  select r.status, r.discuss_ends_at into st, ends_at
  from public.rooms r
  where r.id = rid;

  if st is distinct from 'dawn' then
    return;
  end if;

  if ends_at is not null and now() < ends_at then
    return;
  end if;

  update public.rooms
  set status = 'day'
  where id = rid
    and status = 'dawn';
end;
$fn_day$;

revoke all on function public.maybe_begin_day() from public;
grant execute on function public.maybe_begin_day() to anon, authenticated;

create or replace function public.submit_vote(p_target_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $fn_vote$
declare
  me public.players%rowtype;
  voter_col text;
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
  order by created_at desc
  limit 1;

  if me.id is null then
    raise exception 'Not in a day vote';
  end if;
  if not coalesce(me.is_alive, true) then
    raise exception 'Dead players cannot vote';
  end if;

  select c.column_name into voter_col
  from information_schema.columns c
  where c.table_schema = 'public'
    and c.table_name = 'votes'
    and c.column_name in ('voter_id', 'player_id')
  order by case c.column_name when 'voter_id' then 0 else 1 end
  limit 1;

  if voter_col is null then
    raise exception 'votes table needs voter_id or player_id';
  end if;

  execute format('delete from public.votes where room_id = $1 and %I = $2', voter_col)
    using me.room_id, me.id;
  execute format(
    'insert into public.votes (room_id, %I, target_id) values ($1, $2, $3)',
    voter_col
  ) using me.room_id, me.id, p_target_id;

  update public.rooms
  set announcement = 'Votes are in…'
  where id = me.room_id
    and announcement ilike '%tied%';

  select count(*) into living_n
  from public.players
  where room_id = me.room_id and coalesce(is_alive, true);

  execute format(
    'select count(distinct %I) from public.votes where room_id = $1',
    voter_col
  ) into voted_n using me.room_id;

  if voted_n < living_n then
    return;
  end if;

  execute
    'with counts as (
       select target_id, count(*)::int as c
       from public.votes
       where room_id = $1
       group by target_id
     )
     select target_id, c
     from counts
     order by c desc
     limit 1'
    into top_id, top_n
    using me.room_id;

  execute
    'with counts as (
       select count(*)::int as c
       from public.votes
       where room_id = $1
       group by target_id
     )
     select count(*) > 1
     from counts
     where c = $2'
    into tied
    using me.room_id, top_n;

  if tied or top_id is null then
    execute 'delete from public.votes where room_id = $1' using me.room_id;
    update public.rooms
    set announcement = 'The vote is tied. Vote again.'
    where id = me.room_id;
    return;
  end if;

  update public.players
  set is_alive = false
  where id = top_id
  returning * into victim;

  victim_name := coalesce(victim.name, 'Someone');

  execute 'delete from public.votes where room_id = $1' using me.room_id;

  if victim.role = 'jester' then
    update public.rooms
    set
      status = 'ended',
      winner = 'jester',
      announcement = victim_name || ' was voted out. The Jester wins.'
    where id = me.room_id;
    return;
  end if;

  select count(*) into mafia_alive
  from public.players
  where room_id = me.room_id
    and coalesce(is_alive, true)
    and role = 'mafia';

  select count(*) into others_alive
  from public.players
  where room_id = me.room_id
    and coalesce(is_alive, true)
    and role is distinct from 'mafia';

  if mafia_alive = 0 then
    update public.rooms
    set
      status = 'ended',
      winner = 'town',
      announcement = victim_name || ' was voted out. Town wins.'
    where id = me.room_id;
    return;
  end if;

  if mafia_alive >= others_alive then
    update public.rooms
    set
      status = 'ended',
      winner = 'mafia',
      announcement = victim_name || ' was voted out. Mafia wins.'
    where id = me.room_id;
    return;
  end if;

  update public.rooms
  set
    status = 'night',
    announcement = victim_name || ' was voted out. Night falls.'
  where id = me.room_id;
end;
$fn_vote$;

revoke all on function public.submit_vote(uuid) from public;
grant execute on function public.submit_vote(uuid) to anon, authenticated;
