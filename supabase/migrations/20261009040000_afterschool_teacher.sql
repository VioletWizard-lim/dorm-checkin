-- 방과후 선생님(afterschoolTeacher) 역할(사용자 요청): 방과후 일정만 관리한다.
--   - 방과후 있는 날(afterschool_dates) 추가·삭제: 관리자 + 방과후 선생님
--   - 학생의 방과후 요일(students.afterschool_days)만 모든 학생에 대해 수정(students_update 정책 + 트리거가 다른 칸을 막음)
--   - 외출 기록 쓰기(can_write_outings)·명단 관리(can_manage_student)·좌석 편집(can_edit_room)에는 넣지 않음
--     (그 함수들은 역할을 하나씩 나열하므로 따로 고칠 것 없음)

alter table public.profiles drop constraint profiles_role_check;
alter table public.profiles add constraint profiles_role_check
  check (role in ('teacher', 'gradeManager', 'admin', 'studyHallSupervisor', 'dormStaff', 'afterschoolTeacher', 'student'));

drop policy afterschool_dates_insert on public.afterschool_dates;
drop policy afterschool_dates_delete on public.afterschool_dates;
create policy afterschool_dates_insert on public.afterschool_dates for insert to authenticated
  with check ((select private.has_staff_role('admin', 'afterschoolTeacher')));
create policy afterschool_dates_delete on public.afterschool_dates for delete to authenticated
  using ((select private.has_staff_role('admin', 'afterschoolTeacher')));

drop policy students_update on public.students;
create policy students_update on public.students for update to authenticated
  using (private.can_manage_student(grade, cls) or (select private.has_staff_role('dormStaff', 'afterschoolTeacher')))
  with check (private.can_manage_student(grade, cls) or (select private.has_staff_role('dormStaff', 'afterschoolTeacher')));

-- 명단 관리 권한이 없는 사람이 바꿀 수 있는 칸: 기숙사부는 명령퇴사 기간, 방과후 선생님은 방과후 요일
create or replace function private.students_leave_only() returns trigger
  language plpgsql security definer set search_path = ''
  as $$
  declare
    v_allowed text[];
  begin
    -- 서버 함수(service_role)·명단 관리 권한이 있는 사람은 그대로
    if (select auth.uid()) is null or private.can_manage_student(old.grade, old.cls) then
      return new;
    end if;
    if private.has_staff_role('dormStaff') then
      v_allowed := array['leave_from', 'leave_to', 'leave_reason'];
    elsif private.has_staff_role('afterschoolTeacher') then
      v_allowed := array['afterschool_days'];
    else
      v_allowed := array[]::text[];
    end if;
    if (to_jsonb(new) - v_allowed) is distinct from (to_jsonb(old) - v_allowed) then
      if private.has_staff_role('afterschoolTeacher') then
        raise exception '방과후 선생님은 방과후 요일만 바꿀 수 있습니다.' using errcode = '42501';
      end if;
      raise exception '기숙사부는 명령퇴사 기간만 바꿀 수 있습니다.' using errcode = '42501';
    end if;
    return new;
  end;
  $$;
