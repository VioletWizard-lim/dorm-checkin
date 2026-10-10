-- 학생 아이디(리로스쿨 ID)·연락처·이메일은 그 학생을 관리하는 교직원(관리자·담당 학년 학년부장·담당 반 담임,
-- = can_manage_student)에게만 내준다(사용자 요청 — 예전에는 교직원이면 누구나 F12로 전교생 연락처를 볼 수 있었음).
--   - students: 이 네 칸은 열 권한에서 빼고, 나머지 칸만 읽게 한다(행 범위는 지금처럼 RLS students_select)
--   - 네 칸은 RPC student_contacts()로 담당 범위 학생 것만 읽는다(학생 명단 화면)
--   - profiles: 학생 계정 행(login_id = 리로스쿨 ID)도 담당 범위 교직원과 본인만 읽는다
-- 문자 발송·계정 발급(Edge Function, service_role)은 그대로 모든 칸을 읽는다.

revoke select on public.students from anon, authenticated;
grant select (id, grade, name, sid, cls, afterschool_days, leave_from, leave_to, leave_reason,
              ban_from, ban_to, ban_reason, created_at)
  on public.students to authenticated;

create function private.student_contacts()
  returns table (id uuid, login_id text, phone text, parent_phone text, email text)
  language sql stable security definer set search_path = ''
  as $$
    select s.id, s.login_id, s.phone, s.parent_phone, s.email
    from public.students s
    where private.can_manage_student(s.grade, s.cls)
  $$;
revoke execute on function private.student_contacts() from public, anon;
grant execute on function private.student_contacts() to authenticated;

create function public.student_contacts()
  returns table (id uuid, login_id text, phone text, parent_phone text, email text)
  language sql stable security invoker set search_path = ''
  as $$ select * from private.student_contacts() $$;
revoke execute on function public.student_contacts() from public, anon;
grant execute on function public.student_contacts() to authenticated;

-- 학생 계정 행을 볼 수 있는지(학생 명단 화면의 "계정 있음" 표시용)
create function private.can_manage_student_id(p_student_id uuid) returns boolean
  language sql stable security definer set search_path = ''
  as $$
    select exists (
      select 1 from public.students s
      where s.id = p_student_id and private.can_manage_student(s.grade, s.cls)
    )
  $$;
revoke execute on function private.can_manage_student_id(uuid) from public, anon;
grant execute on function private.can_manage_student_id(uuid) to authenticated;

drop policy profiles_select on public.profiles;
create policy profiles_select on public.profiles for select to authenticated
  using (
    id = (select auth.uid())
    or ((select private.is_staff()) and (kind = 'staff' or private.can_manage_student_id(student_id)))
  );
