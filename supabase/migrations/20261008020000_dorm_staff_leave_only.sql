-- 기숙사부(dormStaff) 권한 축소(사용자 요청): 화면은 볼 수 있지만, 바꿀 수 있는 것은 학생의 명령퇴사 기간뿐.
--   - 외출 체크·복귀·외출 취소(outings 쓰기) 불가
--   - 외출 신청 승인·반려, 학생 명단 추가·수정·삭제, 학생 계정 발급·재발급·삭제 불가(can_manage_student에서 뺌)
--   - 실 추가·삭제·이름·대상 학년·크기, 좌석 배정 불가(is_admin_like·can_edit_room에서 뺌)
--   - 명령퇴사 기간(leave_from·leave_to·leave_reason)만 모든 학생에 대해 수정 가능(students_update 정책 + 트리거)
-- 정책은 함수를 oid로 기억하므로 함수 본문만 바꾸면 기존 정책에 그대로 반영된다.

-- 실 추가·삭제·이름·대상 학년·크기: 이제 관리자만(이름은 그대로 둠 — 정책·resize_room이 이 함수를 씀)
create or replace function private.is_admin_like() returns boolean
  language sql stable security definer set search_path = ''
  as $$ select private.has_staff_role('admin') $$;

-- 학생 명단 관리·외출 신청 승인·학생 계정 범위: 관리자는 전체, 학년부장은 담당 학년, 담임은 담당 반
create or replace function private.can_manage_student(p_grade smallint, p_cls text) returns boolean
  language sql stable security definer set search_path = ''
  as $$
    select exists (
      select 1 from public.profiles p
      where p.id = (select auth.uid()) and p.kind = 'staff' and not p.disabled and (
        p.role = 'admin'
        or (p.role = 'gradeManager' and p_grade = any (p.managed_grades))
        or (p.role = 'teacher'
            and p.managed_classes @> jsonb_build_array(jsonb_build_object('grade', p_grade, 'cls', p_cls)))
      )
    )
  $$;

create or replace function private.can_edit_room(p_room_id uuid) returns boolean
  language sql stable security definer set search_path = ''
  as $$
    select exists (
      select 1 from public.profiles p
      where p.id = (select auth.uid()) and p.kind = 'staff' and not p.disabled and (
        p.role = 'admin'
        or (p.role = 'gradeManager' and p_room_id = any (p.managed_rooms))
      )
    )
  $$;

-- 외출 기록(외출 체크·복귀·자리 없음·외출 취소)을 쓸 수 있는 교직원: 기숙사부만 빠짐
create function private.can_write_outings() returns boolean
  language sql stable security definer set search_path = ''
  as $$ select private.has_staff_role('teacher', 'gradeManager', 'admin', 'studyHallSupervisor') $$;

revoke execute on function private.can_write_outings() from public, anon;
grant execute on function private.can_write_outings() to authenticated, service_role;

drop policy outings_insert on public.outings;
drop policy outings_update on public.outings;
create policy outings_insert on public.outings for insert to authenticated
  with check ((select private.can_write_outings()));
create policy outings_update on public.outings for update to authenticated
  using ((select private.can_write_outings()))
  with check ((select private.can_write_outings()));

-- students 수정: 명단을 관리할 수 있는 사람 + 기숙사부(명령퇴사 기간만 — 아래 트리거가 다른 칸을 막음)
drop policy students_update on public.students;
create policy students_update on public.students for update to authenticated
  using (private.can_manage_student(grade, cls) or (select private.has_staff_role('dormStaff')))
  with check (private.can_manage_student(grade, cls) or (select private.has_staff_role('dormStaff')));

create function private.students_leave_only() returns trigger
  language plpgsql security definer set search_path = ''
  as $$
  begin
    -- 서버 함수(service_role)·명단 관리 권한이 있는 사람은 그대로, 그 밖(기숙사부)은 명령퇴사 칸만 바꿀 수 있다
    if (select auth.uid()) is not null
       and not private.can_manage_student(old.grade, old.cls)
       and (to_jsonb(new) - array['leave_from', 'leave_to', 'leave_reason'])
           is distinct from (to_jsonb(old) - array['leave_from', 'leave_to', 'leave_reason']) then
      raise exception '기숙사부는 명령퇴사 기간만 바꿀 수 있습니다.' using errcode = '42501';
    end if;
    return new;
  end;
  $$;

revoke execute on function private.students_leave_only() from public, anon, authenticated;

create trigger students_leave_only before update on public.students
  for each row execute function private.students_leave_only();
