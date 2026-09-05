-- Run this file by itself. Select all of it.

drop function if exists public.apply_night_story(uuid);

create or replace function public.apply_night_story(p_room_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  prior text;
  victim_name text;
  victim_alive boolean;
  mafia_target uuid;
  doctor_target uuid;
  dead_n int;
  story text;
  kills text[] := array[
    '{name} was found at first light, still in the street. Nobody heard a thing.',
    'They knocked on {name}''s door at dawn. The kettle was cold.',
    '{name} never came back from the well. The bucket was still there.',
    'A coat hung on the fence. Under it, {name} did not wake.',
    '{name} missed the morning bell. The house was unlocked.',
    'Tracks stopped in the square. That is where they found {name}.',
    '{name}''s candle burned down to the dish. The chair was empty.',
    'Someone closed {name}''s eyes before the town could gather.',
    'The river path held {name} until sunrise. No one else was in sight.',
    '{name} had set two cups out. Only one was used.'
  ];
  saves text[] := array[
    '{name} was left for dead. At dawn they were bandaged and breathing.',
    'The town almost lost {name}. They opened their eyes before anyone could explain it.',
    '{name} was attacked in the dark. Whoever stayed behind left no name.',
    'Blood on the stoop. {name} is alive. That is the whole report.',
    '{name} collapsed after midnight and sat up at first light.',
    'They came for {name}. Dawn found them shaken, not gone.',
    '{name} remembers a struggle, then waking under a blanket that was not theirs.',
    'A window broke at {name}''s house. They still answered the morning roll.',
    '{name} should have been a body in the lane. They walked home instead.',
    'The night reached for {name} and missed. They will not say more.'
  ];
begin
  select r.announcement into prior from public.rooms r where r.id = p_room_id;

  begin
    select v.id into mafia_target
    from public.players v
    join public.night_actions na
      on na.room_id = p_room_id
     and (na.target_id = v.id or na.target_id = v.user_id)
    join public.players a
      on a.room_id = p_room_id
     and (a.id = na.player_id or a.user_id = na.player_id)
    where v.room_id = p_room_id
      and a.role = 'mafia'
    order by coalesce(v.is_alive, true), v.name
    limit 1;
  exception
    when others then
      mafia_target := null;
  end;

  begin
    select v.id into doctor_target
    from public.players v
    join public.night_actions na
      on na.room_id = p_room_id
     and (na.target_id = v.id or na.target_id = v.user_id)
    join public.players a
      on a.room_id = p_room_id
     and (a.id = na.player_id or a.user_id = na.player_id)
    where v.room_id = p_room_id
      and a.role = 'doctor'
    limit 1;
  exception
    when others then
      doctor_target := null;
  end;

  if mafia_target is not null then
    select p.name, coalesce(p.is_alive, true)
      into victim_name, victim_alive
    from public.players p
    where p.id = mafia_target;
  end if;

  if victim_name is null then
    select p.name, coalesce(p.is_alive, true)
      into victim_name, victim_alive
    from public.players p
    where p.room_id = p_room_id
      and prior is not null
      and position(lower(p.name) in lower(prior)) > 0
    order by char_length(p.name) desc
    limit 1;
  end if;

  if victim_name is null then
    select count(*) into dead_n
    from public.players p
    where p.room_id = p_room_id and not coalesce(p.is_alive, true);
    if dead_n = 1 then
      select p.name, false into victim_name, victim_alive
      from public.players p
      where p.room_id = p_room_id and not coalesce(p.is_alive, true)
      limit 1;
    end if;
  end if;

  if victim_name is null then
    story := 'The streets were empty till dawn. Nobody is missing.';
  elsif victim_alive = false then
    story := replace(kills[1 + floor(random() * 10)::int], '{name}', victim_name)
      || E'\n\nKilled: ' || victim_name;
  elsif doctor_target is not distinct from mafia_target
     or (prior is not null and prior !~* 'streets were empty|nobody is missing') then
    story := replace(saves[1 + floor(random() * 10)::int], '{name}', victim_name)
      || E'\n\nSurvived: ' || victim_name;
  else
    story := 'The streets were empty till dawn. Nobody is missing.';
  end if;

  update public.rooms
  set announcement = story
  where id = p_room_id;

  return story;
end;
$$;

revoke all on function public.apply_night_story(uuid) from public;
grant execute on function public.apply_night_story(uuid) to anon, authenticated;
