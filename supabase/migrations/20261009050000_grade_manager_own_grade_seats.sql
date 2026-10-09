-- 학년부장은 자기 학년 학생의 좌석만 배정·해제·이동·일괄 등록한다(사용자 요청 — 예전에는 1학년부장이 담당 실에
-- 앉는 2학년 학생 자리도 바꿀 수 있었음). 관리자는 그대로 전체.
--   - assign_seat: 배정할 학생이 자기 학년이어야 함
--   - unassign_seat: 그 자리 학생이 자기 학년이어야 함(빈자리는 그대로 통과)
--   - move_seat: 옮기는 학생·맞바꾸는 학생 모두 자기 학년이어야 함
--   - set_room_seats: 새 좌석표의 학생은 자기 학년이어야 하고(지금 그 자리에 그대로 있는 학생은 통과),
--     다른 학년 학생의 지금 자리는 그대로 남긴다(그 자리에 다른 학생을 넣으면 거부)

create function private.can_seat_student(p_grade smallint) returns boolean
  language sql stable security definer set search_path = ''
  as $$
    select exists (
      select 1 from public.profiles p
      where p.id = (select auth.uid()) and p.kind = 'staff' and not p.disabled and (
        p.role = 'admin'
        or (p.role = 'gradeManager' and p_grade = any (p.managed_grades))
      )
    )
  $$;
revoke execute on function private.can_seat_student(smallint) from public, anon;
grant execute on function private.can_seat_student(smallint) to authenticated, service_role;

-- 자리의 학생(학생 id 문자열)을 바꿀 수 있는지. 학생이 없거나 명단에서 지워졌으면 통과
create function private.can_seat_student_id(p_student_id text) returns boolean
  language sql stable security definer set search_path = ''
  as $$
    select p_student_id is null
        or not exists (select 1 from public.students s where s.id::text = p_student_id)
        or private.can_seat_student((select s.grade from public.students s where s.id::text = p_student_id))
  $$;
revoke execute on function private.can_seat_student_id(text) from public, anon;
grant execute on function private.can_seat_student_id(text) to authenticated, service_role;

create or replace function private.assign_seat(p_room_id uuid, p_cell_key text, p_student_id uuid) returns void
  language plpgsql security definer set search_path = ''
  as $$
  declare
    v_room public.rooms;
    v_grade smallint;
  begin
    if not private.can_edit_room(p_room_id) then
      raise exception '이 실의 좌석을 편집할 권한이 없습니다.' using errcode = '42501';
    end if;
    select * into v_room from public.rooms where id = p_room_id for update;
    if v_room.id is null then
      raise exception '실을 찾을 수 없습니다.';
    end if;
    if p_cell_key !~ '^r[0-9]+c[0-9]+$'
       or substring(p_cell_key from '^r([0-9]+)c')::int >= v_room.rows
       or substring(p_cell_key from 'c([0-9]+)$')::int >= v_room.cols then
      raise exception '좌석 위치가 올바르지 않습니다.';
    end if;
    select s.grade into v_grade from public.students s where s.id = p_student_id;
    if v_grade is null then
      raise exception '학생을 찾을 수 없습니다.';
    end if;
    if not (v_grade = any (v_room.grades)) then
      raise exception '이 실의 대상 학년이 아닌 학생입니다.';
    end if;
    if not private.can_seat_student(v_grade) then
      raise exception '담당 학년 학생만 배정할 수 있습니다.' using errcode = '42501';
    end if;
    if not private.can_seat_student_id(v_room.seat_map ->> p_cell_key) then
      raise exception '다른 학년 학생의 자리입니다.' using errcode = '42501';
    end if;

    update public.rooms r
       set seat_map = (
         select coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb)
           from jsonb_each(r.seat_map) e
          where e.value <> to_jsonb(p_student_id::text)
       )
     where exists (select 1 from jsonb_each(r.seat_map) e where e.value = to_jsonb(p_student_id::text));

    update public.rooms
       set seat_map = seat_map || jsonb_build_object(p_cell_key, p_student_id::text)
     where id = p_room_id;
  end;
  $$;

create or replace function private.unassign_seat(p_room_id uuid, p_cell_key text) returns void
  language plpgsql security definer set search_path = ''
  as $$
  declare
    v_room public.rooms;
  begin
    if not private.can_edit_room(p_room_id) then
      raise exception '이 실의 좌석을 편집할 권한이 없습니다.' using errcode = '42501';
    end if;
    select * into v_room from public.rooms where id = p_room_id for update;
    if not private.can_seat_student_id(v_room.seat_map ->> p_cell_key) then
      raise exception '담당 학년 학생의 자리만 비울 수 있습니다.' using errcode = '42501';
    end if;
    update public.rooms set seat_map = seat_map - p_cell_key where id = p_room_id;
  end;
  $$;

create or replace function private.move_seat(p_room_id uuid, p_from_cell text, p_to_cell text) returns void
  language plpgsql security definer set search_path = ''
  as $$
  declare
    v_room public.rooms;
    v_moving text;
    v_other text;
    v_map jsonb;
  begin
    if not private.can_edit_room(p_room_id) then
      raise exception '이 실의 좌석을 편집할 권한이 없습니다.' using errcode = '42501';
    end if;
    select * into v_room from public.rooms where id = p_room_id for update;
    if v_room.id is null then
      raise exception '실을 찾을 수 없습니다.';
    end if;
    if p_from_cell !~ '^r[0-9]+c[0-9]+$' or p_to_cell !~ '^r[0-9]+c[0-9]+$'
       or substring(p_from_cell from '^r([0-9]+)c')::int >= v_room.rows
       or substring(p_from_cell from 'c([0-9]+)$')::int >= v_room.cols
       or substring(p_to_cell from '^r([0-9]+)c')::int >= v_room.rows
       or substring(p_to_cell from 'c([0-9]+)$')::int >= v_room.cols then
      raise exception '좌석 위치가 올바르지 않습니다.';
    end if;
    if p_from_cell = p_to_cell then
      return;
    end if;
    v_moving := v_room.seat_map ->> p_from_cell;
    if v_moving is null then
      raise exception '옮길 학생이 없는 자리입니다.';
    end if;
    v_other := v_room.seat_map ->> p_to_cell;
    if not private.can_seat_student_id(v_moving) or not private.can_seat_student_id(v_other) then
      raise exception '담당 학년 학생만 옮길 수 있습니다.' using errcode = '42501';
    end if;
    v_map := (v_room.seat_map - p_from_cell - p_to_cell) || jsonb_build_object(p_to_cell, v_moving);
    if v_other is not null then
      v_map := v_map || jsonb_build_object(p_from_cell, v_other);
    end if;
    update public.rooms set seat_map = v_map where id = p_room_id;
  end;
  $$;

create or replace function private.set_room_seats(p_room_id uuid, p_seat_map jsonb) returns void
  language plpgsql security definer set search_path = ''
  as $$
  declare
    v_room public.rooms;
    v_entry record;
    v_grade smallint;
    v_ids text[];
    v_keep jsonb := '{}'::jsonb; -- 바꿀 수 없는(다른 학년) 학생의 지금 자리 — 그대로 남긴다
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

    for v_entry in select key, value from jsonb_each(v_room.seat_map) loop
      if not private.can_seat_student_id(v_entry.value #>> '{}') then
        v_keep := v_keep || jsonb_build_object(v_entry.key, v_entry.value);
      end if;
    end loop;

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
      if v_keep ? v_entry.key then
        if v_keep -> v_entry.key <> v_entry.value then
          raise exception '다른 학년 학생의 자리입니다(%).', v_entry.key using errcode = '42501';
        end if;
      elsif not private.can_seat_student(v_grade) then
        raise exception '담당 학년 학생만 배정할 수 있습니다(%).', v_entry.key using errcode = '42501';
      end if;
    end loop;

    p_seat_map := p_seat_map || v_keep;
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
