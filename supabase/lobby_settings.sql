-- Run the whole file once in the Supabase SQL editor.

alter table public.rooms add column if not exists mafia_can_kill boolean not null default true;
alter table public.rooms add column if not exists include_mafia boolean not null default true;
alter table public.rooms add column if not exists include_doctor boolean not null default true;
alter table public.rooms add column if not exists include_detective boolean not null default true;
alter table public.rooms add column if not exists include_jester boolean not null default true;

drop function if exists public.deal_configured_roles(uuid);
drop function if exists public.deal_configured_roles(uuid, boolean, boolean, boolean);
drop function if exists public.skip_disarmed_mafia(uuid);
drop function if exists public.host_begin_day();

-- Always includes mafia. Optional town roles come from the arguments, not
-- leftover assignments from start_game. Deck and seats are shuffled independently.
create or replace function public.deal_configured_roles(
  p_room_id uuid,
  p_include_doctor boolean default true,
  p_include_detective boolean default true,
  p_include_jester boolean default true
)
returns void
language plpgsql
security definer
set search_path = public
as $fn_deal$
declare
  n int;
  mafia_n int;
  deck text[] := array[]::text[];
  ids uuid[];
  i int;
  want_doctor boolean := coalesce(p_include_doctor, true);
  want_detective boolean := coalesce(p_include_detective, true);
  want_jester boolean := coalesce(p_include_jester, true);
begin
  if not exists (select 1 from public.rooms where id = p_room_id) then
    raise exception 'Room not found';
  end if;

  update public.rooms
  set
    include_mafia = true,
    include_doctor = want_doctor,
    include_detective = want_detective,
    include_jester = want_jester
  where id = p_room_id;

  select count(*) into n from public.players where room_id = p_room_id;
  if n < 1 then
    return;
  end if;

  mafia_n := case when n >= 10 then 3 when n >= 7 then 2 else 1 end;
  if mafia_n > n then
    mafia_n := n;
  end if;

  for i in 1 .. mafia_n loop
    deck := deck || array['mafia'];
  end loop;

  if want_doctor and coalesce(array_length(deck, 1), 0) < n then
    deck := deck || array['doctor'];
  end if;
  if want_detective and coalesce(array_length(deck, 1), 0) < n then
    deck := deck || array['detective'];
  end if;
  if want_jester and coalesce(array_length(deck, 1), 0) < n then
    deck := deck || array['jester'];
  end if;

  while coalesce(array_length(deck, 1), 0) < n loop
    deck := deck || array['civilian'];
  end loop;

  select array_agg(role_name order by random())
  into deck
  from unnest(deck) as role_name;

  select array_agg(id order by random())
  into ids
  from public.players
  where room_id = p_room_id;

  for i in 1 .. n loop
    update public.players
    set role = deck[i]
    where id = ids[i];
  end loop;
end;
$fn_deal$;

create or replace function public.skip_disarmed_mafia(p_room_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $fn_skip$
declare
  r public.rooms%rowtype;
  m public.players%rowtype;
begin
  select * into r from public.rooms where id = p_room_id;
  if r.id is null then
    return;
  end if;
  if coalesce(r.mafia_can_kill, true) then
    return;
  end if;

  for m in
    select * from public.players
    where room_id = p_room_id
      and role = 'mafia'
      and coalesce(is_alive, true)
  loop
    begin
      insert into public.night_actions (room_id, player_id, target_id)
      values (p_room_id, m.id, null);
    exception
      when others then
        begin
          insert into public.night_actions (room_id, player_id, target_id)
          values (p_room_id, m.id, m.id);
        exception
          when others then
            null;
        end;
    end;
  end loop;
end;
$fn_skip$;

-- Host-only skip of the discuss timer. Non-hosts must wait for maybe_begin_day.
create or replace function public.host_begin_day()
returns void
language plpgsql
security definer
set search_path = public
as $fn_host_day$
declare
  rid uuid;
  is_host boolean;
  st text;
begin
  select p.room_id, p.is_host into rid, is_host
  from public.players p
  where p.user_id = auth.uid()
  order by p.created_at desc
  limit 1;

  if rid is null then
    raise exception 'Not in a room';
  end if;
  if not coalesce(is_host, false) then
    raise exception 'Only the host can start the vote';
  end if;

  select r.status into st from public.rooms r where r.id = rid;
  if st is distinct from 'dawn' and st is distinct from 'discuss' then
    return;
  end if;

  update public.rooms
  set status = 'day'
  where id = rid
    and status in ('dawn', 'discuss');
end;
$fn_host_day$;

revoke all on function public.deal_configured_roles(uuid, boolean, boolean, boolean) from public;
revoke all on function public.skip_disarmed_mafia(uuid) from public;
revoke all on function public.host_begin_day() from public;
grant execute on function public.deal_configured_roles(uuid, boolean, boolean, boolean) to anon, authenticated;
grant execute on function public.skip_disarmed_mafia(uuid) to anon, authenticated;
grant execute on function public.host_begin_day() to anon, authenticated;

notify pgrst, 'reload schema';
