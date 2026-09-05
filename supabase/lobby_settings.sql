-- Run the whole file once in the Supabase SQL editor.

alter table public.rooms add column if not exists mafia_can_kill boolean not null default true;
alter table public.rooms add column if not exists include_mafia boolean not null default true;
alter table public.rooms add column if not exists include_doctor boolean not null default true;
alter table public.rooms add column if not exists include_detective boolean not null default true;
alter table public.rooms add column if not exists include_jester boolean not null default true;

drop function if exists public.deal_configured_roles(uuid);
drop function if exists public.skip_disarmed_mafia(uuid);

create or replace function public.deal_configured_roles(p_room_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $fn_deal$
declare
  n int;
  r public.rooms%rowtype;
  deck text[] := array[]::text[];
  mafia_n int;
  ids uuid[];
  i int;
begin
  select * into r from public.rooms where id = p_room_id;
  if r.id is null then
    raise exception 'Room not found';
  end if;

  select count(*) into n from public.players where room_id = p_room_id;
  if n < 1 then
    return;
  end if;

  mafia_n := 0;
  if coalesce(r.include_mafia, true) then
    mafia_n := case when n >= 10 then 3 when n >= 7 then 2 else 1 end;
  end if;

  for i in 1 .. mafia_n loop
    deck := deck || array['mafia'];
  end loop;

  if coalesce(r.include_doctor, true) and array_length(deck, 1) < n then
    deck := deck || array['doctor'];
  end if;
  if coalesce(r.include_detective, true) and array_length(deck, 1) < n then
    deck := deck || array['detective'];
  end if;
  if coalesce(r.include_jester, true) and array_length(deck, 1) < n then
    deck := deck || array['jester'];
  end if;

  while coalesce(array_length(deck, 1), 0) < n loop
    deck := deck || array['civilian'];
  end loop;

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

revoke all on function public.deal_configured_roles(uuid) from public;
revoke all on function public.skip_disarmed_mafia(uuid) from public;
grant execute on function public.deal_configured_roles(uuid) to anon, authenticated;
grant execute on function public.skip_disarmed_mafia(uuid) to anon, authenticated;
