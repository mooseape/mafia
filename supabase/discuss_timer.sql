-- Run this file by itself. Makes dawn use the host's lobby timer.

create or replace function public.rooms_set_discuss_ends_at()
returns trigger
language plpgsql
as $$
begin
  if new.status in ('dawn', 'discuss')
     and (old.status is distinct from new.status) then
    new.discuss_ends_at :=
      now() + make_interval(
        secs => greatest(15, coalesce(new.discuss_seconds, 150))
      );
  end if;
  return new;
end;
$$;
