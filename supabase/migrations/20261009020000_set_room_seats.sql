-- 좌석 일괄 등록(사용자 요청). 실 하나의 좌석표 전체를 한 번에 바꾼다(엑셀에 자리 모양대로 적은 학번표를 붙여넣기).
-- 권한은 좌석 배정과 같다(can_edit_room). 한 번에 처리해서 중간에 일부만 바뀐 상태가 남지 않는다.
--   p_seat_map: {"r0c0": "<students.id>", ...} — 여기 없는 자리는 빈자리가 된다
--   학생은 이 실의 대상 학년이어야 하고, 한 학생이 두 자리에 있으면 안 된다
--   다른 실에 앉아 있던 학생은 그 자리를 비운다(assign_seat와 같음)

create function private.set_room_seats(p_room_id uuid, p_seat_map jsonb) returns void
  language plpgsql security definer set search_path = ''
  as $$
  declare
    v_room public.rooms;
    v_entry record;
    v_grade smallint;
    v_ids text[];
  begin
    if not private.can_edit_room(p_room_id) then
      raise exception '이 실의 좌석을 편집할 권한이 없습니다.' using errcode = '42501';
    end if;
    select * into v_room from public.rooms where id = p_room_id for update;
    if v_room.id is null then
      raise exception '실을 찾을 수 없습니다.';
    end if;
    if p_seat_map is null or jsonb_typeof(p_seat_map) <> 'object' then
      raise exception '좌석표 형식이 올바르지 않습니다.';
    end if;

    for v_entry in select key, value from jsonb_each(p_seat_map) loop
      if v_entry.key !~ '^r[0-9]+c[0-9]+$'
         or substring(v_entry.key from '^r([0-9]+)c')::int >= v_room.rows
         or substring(v_entry.key from 'c([0-9]+)$')::int >= v_room.cols then
        raise exception '좌석 위치가 올바르지 않습니다(%).', v_entry.key;
      end if;
      if jsonb_typeof(v_entry.value) <> 'string' or v_entry.value #>> '{}' !~ '^[0-9a-f-]{36}$' then
        raise exception '학생 정보가 올바르지 않습니다(%).', v_entry.key;
      end if;
      select s.grade into v_grade from public.students s where s.id = (v_entry.value #>> '{}')::uuid;
      if v_grade is null then
        raise exception '학생을 찾을 수 없습니다(%).', v_entry.key;
      end if;
      if not (v_grade = any (v_room.grades)) then
        raise exception '이 실의 대상 학년이 아닌 학생이 있습니다(%).', v_entry.key;
      end if;
    end loop;

    select array_agg(value #>> '{}') into v_ids from jsonb_each(p_seat_map);
    if v_ids is not null and cardinality(v_ids) <> (select count(distinct x) from unnest(v_ids) x) then
      raise exception '한 학생이 두 자리에 있습니다.';
    end if;

    -- 다른 실에 앉아 있던 학생은 그 자리를 비운다
    if v_ids is not null then
      update public.rooms r
         set seat_map = (
           select coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb)
             from jsonb_each(r.seat_map) e
            where not ((e.value #>> '{}') = any (v_ids))
         )
       where r.id <> p_room_id
         and exists (select 1 from jsonb_each(r.seat_map) e where (e.value #>> '{}') = any (v_ids));
    end if;

    update public.rooms set seat_map = p_seat_map where id = p_room_id;
  end;
  $$;
revoke execute on function private.set_room_seats(uuid, jsonb) from public, anon;
grant execute on function private.set_room_seats(uuid, jsonb) to authenticated, service_role;

create function public.set_room_seats(p_room_id uuid, p_seat_map jsonb) returns void
  language sql security invoker set search_path = ''
  as $$ select private.set_room_seats(p_room_id, p_seat_map) $$;
revoke execute on function public.set_room_seats(uuid, jsonb) from public, anon;
grant execute on function public.set_room_seats(uuid, jsonb) to authenticated, service_role;
