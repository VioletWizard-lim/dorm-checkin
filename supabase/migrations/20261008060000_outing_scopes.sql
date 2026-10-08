-- 역할별 외출 처리 범위 정리(사용자 요청)
--   - 외출 체크(→외출)·외출 취소(외출 예정→재실): 담임은 담당 반, 학년부장은 담당 학년, 관리자는 전체(= can_manage_student)
--   - 복귀 체크(외출→재실): 위와 같고, 자습 감독은 모든 학생 복귀 가능(외출 예정을 취소하는 건 안 됨)
--   - 자리 없음 표시/해제: 지금처럼 기숙사부 빼고 모두(can_write_outings) — 자습 감독 포함
--   - 계정이 있는 학생을 명단에서 지우는 건 관리자만(서버 함수는 service_role이라 그대로 지울 수 있음)
-- BEFORE 트리거라 RLS보다 먼저 돈다. 쓸 권한이 없거나 지난 날짜면 RLS가 거부하도록 넘긴다.

create function private.outings_check_scope() returns trigger
  language plpgsql security definer set search_path = ''
  as $$
  declare
    v_old text := case when tg_op = 'UPDATE' then old.status else 'in' end;
    v_old_start text := case when tg_op = 'UPDATE' then old.start_time end;
    v_student public.students;
    v_now text := to_char(now() at time zone 'Asia/Seoul', 'HH24:MI');
  begin
    if (select auth.uid()) is null or new.status = v_old
       or not private.can_write_outings() or new.date <> public.today_kst() then
      return new;
    end if;
    select * into v_student from public.students where id = new.student_id;
    if v_student.id is null or private.can_manage_student(v_student.grade, v_student.cls) then
      return new;
    end if;
    -- 담당 범위 밖: 자리 없음 표시/해제(재실↔자리 없음)는 누구나
    if (v_old = 'in' and new.status = 'away') or (v_old = 'away' and new.status = 'in') then
      return new;
    end if;
    -- 자습 감독은 외출 중인 학생의 복귀만(외출 시각 전인 '외출 예정'을 취소하는 건 안 됨)
    if v_old = 'out' and new.status = 'in' and private.has_staff_role('studyHallSupervisor')
       and (v_old_start is null or v_old_start <= v_now) then
      return new;
    end if;
    raise exception '이 학생의 외출을 처리할 권한이 없습니다.' using errcode = '42501';
  end;
  $$;
revoke execute on function private.outings_check_scope() from public, anon, authenticated;

-- 이름 순서: outings_before_write → outings_check_scope → outings_require_return
create trigger outings_check_scope before insert or update on public.outings
  for each row execute function private.outings_check_scope();

create function private.students_delete_guard() returns trigger
  language plpgsql security definer set search_path = ''
  as $$
  begin
    if (select auth.uid()) is not null and not private.has_staff_role('admin')
       and exists (select 1 from public.profiles p where p.student_id = old.id) then
      raise exception '계정이 있는 학생은 관리자만 삭제할 수 있습니다.' using errcode = '42501';
    end if;
    return old;
  end;
  $$;
revoke execute on function private.students_delete_guard() from public, anon, authenticated;

create trigger students_delete_guard before delete on public.students
  for each row execute function private.students_delete_guard();
