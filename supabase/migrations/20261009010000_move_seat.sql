-- 좌석 끌어서 옮기기(사용자 요청). 같은 실 안에서 한 자리의 학생을 다른 자리로 옮긴다.
-- 놓은 자리에 다른 학생이 있으면 두 학생의 자리를 맞바꾼다(한 번에 — 중간에 한 명이 자리 없는 순간이 없게).
-- 권한은 좌석 배정과 같다(can_edit_room = 관리자 또는 담당 실의 학년부장).

create function private.move_seat(p_room_id uuid, p_from_cell text, p_to_cell text) returns void
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
    v_map := (v_room.seat_map - p_from_cell - p_to_cell) || jsonb_build_object(p_to_cell, v_moving);
    if v_other is not null then
      v_map := v_map || jsonb_build_object(p_from_cell, v_other);
    end if;
    update public.rooms set seat_map = v_map where id = p_room_id;
  end;
  $$;
revoke execute on function private.move_seat(uuid, text, text) from public, anon;
grant execute on function private.move_seat(uuid, text, text) to authenticated, service_role;

-- 화면이 부르는 껍데기(security invoker, 20261008010000과 같은 방식)
create function public.move_seat(p_room_id uuid, p_from_cell text, p_to_cell text) returns void
  language sql security invoker set search_path = ''
  as $$ select private.move_seat(p_room_id, p_from_cell, p_to_cell) $$;
revoke execute on function public.move_seat(uuid, text, text) from public, anon;
grant execute on function public.move_seat(uuid, text, text) to authenticated, service_role;
