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
  if new.status in ('dawn', 'discuss')
     and (old.status is distinct from new.status) then
    new.discuss_seconds := 150;
    new.discuss_ends_at := now() + make_interval(secs => 150);
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
  room_col text;
  voter_col text;
  target_col text;
  voter_val uuid;
  living_n int;
  voted_n int;
  top_id uuid;
  top_n int;
  tied boolean;
  victim public.players%rowtype;
  mafia_alive int;
  others_alive int;
  victim_name text;
  cols text;
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

  select string_agg(c.column_name, ', ' order by c.ordinal_position)
  into cols
  from information_schema.columns c
  where c.table_schema = 'public'
    and c.table_name = 'votes';

  select c.column_name into room_col
  from information_schema.columns c
  where c.table_schema = 'public'
    and c.table_name = 'votes'
    and c.column_name in ('room_id', 'game_id')
  order by case c.column_name when 'room_id' then 0 else 1 end
  limit 1;

  select c.column_name into voter_col
  from information_schema.columns c
  where c.table_schema = 'public'
    and c.table_name = 'votes'
    and c.column_name in (
      'voter_id', 'player_id', 'user_id', 'from_id', 'voter', 'voted_by'
    )
  order by case c.column_name
    when 'voter_id' then 0
    when 'player_id' then 1
    when 'user_id' then 2
    when 'from_id' then 3
    when 'voted_by' then 4
    else 5
  end
  limit 1;

  select c.column_name into target_col
  from information_schema.columns c
  where c.table_schema = 'public'
    and c.table_name = 'votes'
    and c.column_name in (
      'target_id', 'voted_for', 'votee_id', 'against_id',
      'nominee_id', 'candidate_id', 'to_id'
    )
  order by case c.column_name
    when 'target_id' then 0
    when 'voted_for' then 1
    else 2
  end
  limit 1;

  if room_col is null or voter_col is null or target_col is null then
    raise exception 'votes table columns are %', coalesce(cols, '(none)');
  end if;

  if voter_col in ('user_id', 'voted_by') then
    voter_val := me.user_id;
  else
    voter_val := me.id;
  end if;

  execute format(
    'delete from public.votes where %I = $1 and %I = $2',
    room_col, voter_col
  ) using me.room_id, voter_val;
  execute format(
    'insert into public.votes (%I, %I, %I) values ($1, $2, $3)',
    room_col, voter_col, target_col
  ) using me.room_id, voter_val, p_target_id;

  update public.rooms
  set announcement = 'Votes are in…'
  where id = me.room_id
    and announcement ilike '%tied%';

  select count(*) into living_n
  from public.players
  where room_id = me.room_id and coalesce(is_alive, true);

  execute format(
    'select count(distinct %I) from public.votes where %I = $1',
    voter_col, room_col
  ) into voted_n using me.room_id;

  if voted_n < living_n then
    return;
  end if;

  execute format(
    'with counts as (
       select %I as tid, count(*)::int as c
       from public.votes
       where %I = $1
       group by 1
     )
     select tid, c
     from counts
     order by c desc
     limit 1',
    target_col, room_col
  ) into top_id, top_n using me.room_id;

  execute format(
    'with counts as (
       select count(*)::int as c
       from public.votes
       where %I = $1
       group by %I
     )
     select count(*) > 1
     from counts
     where c = $2',
    room_col, target_col
  ) into tied using me.room_id, top_n;

  if tied or top_id is null then
    execute format('delete from public.votes where %I = $1', room_col)
      using me.room_id;
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

  execute format('delete from public.votes where %I = $1', room_col)
    using me.room_id;

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
