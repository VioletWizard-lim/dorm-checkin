-- 사유 글은 필요한 교직원에게만(사용자 요청, 개인정보 점검):
--   - 외출 사유(outings.reason)·외출 신청 사유(outing_requests.reason): 관리자·학년부장·담임(담당 반이 있는 teacher)·자습 감독
--     — 기숙사부·방과후 선생님·담당 반 없는 교사는 못 봄(외출증에는 "사유 미기재"로 보임)
--   - 명령퇴사 사유(students.leave_reason): 관리자·학년부장·담임·기숙사부
--   - 학생은 자기 사유를 그대로 봄
-- 사유 칸은 열 권한에서 빼고(행 범위는 기존 RLS 그대로), 아래 RPC로 허용된 사람만 읽는다.
-- 쓰기(외출 체크의 사유 저장, 명령퇴사 설정)는 그대로. 외출 기록(outing_log)은 원래 담당 범위만 읽으므로 그대로.

create function private.has_homeroom() returns boolean
  language sql stable security definer set search_path = ''
  as $$
    select exists (
      select 1 from public.profiles p
      where p.id = (select auth.uid()) and p.kind = 'staff' and not p.disabled
        and p.role = 'teacher' and jsonb_array_length(coalesce(p.managed_classes, '[]'::jsonb)) > 0
    )
  $$;
revoke execute on function private.has_homeroom() from public, anon;
grant execute on function private.has_homeroom() to authenticated, service_role;

create function private.can_read_outing_reasons() returns boolean
  language sql stable security definer set search_path = ''
  as $$ select private.has_staff_role('admin', 'gradeManager', 'studyHallSupervisor') or private.has_homeroom() $$;
revoke execute on function private.can_read_outing_reasons() from public, anon;
grant execute on function private.can_read_outing_reasons() to authenticated, service_role;

create function private.can_read_leave_reasons() returns boolean
  language sql stable security definer set search_path = ''
  as $$ select private.has_staff_role('admin', 'gradeManager', 'dormStaff') or private.has_homeroom() $$;
revoke execute on function private.can_read_leave_reasons() from public, anon;
grant execute on function private.can_read_leave_reasons() to authenticated, service_role;

-- ─────────── 열 권한 ───────────
revoke select on public.outings from anon, authenticated;
grant select (date, student_id, status, since, start_time, expected_return, checked_by, checked_by_name, request_id, notice)
  on public.outings to authenticated;

revoke select on public.outing_requests from anon, authenticated;
grant select (id, date, student_id, requested_by, start_time, expected_return, status, decided_by, decided_by_name,
              decided_at, reject_reason, created_at)
  on public.outing_requests to authenticated;

revoke select (leave_reason) on public.students from authenticated;

-- ─────────── 사유 읽기 RPC(본체는 private, public은 껍데기) ───────────
-- 그 날짜의 외출 사유. 행 범위는 RLS와 같다(교직원 전체 / 학생은 자기 것)
create function private.outing_reasons(p_date date) returns table (student_id uuid, reason text)
  language sql stable security definer set search_path = ''
  as $$
    select o.student_id, o.reason from public.outings o
    where o.date = p_date and o.reason is not null
      and (private.can_read_outing_reasons() or o.student_id = private.my_student_id())
  $$;
revoke execute on function private.outing_reasons(date) from public, anon;
grant execute on function private.outing_reasons(date) to authenticated;
create function public.outing_reasons(p_date date) returns table (student_id uuid, reason text)
  language sql stable security invoker set search_path = ''
  as $$ select * from private.outing_reasons(p_date) $$;
revoke execute on function public.outing_reasons(date) from public, anon;
grant execute on function public.outing_reasons(date) to authenticated;

create function private.outing_request_reasons(p_date date) returns table (id uuid, reason text)
  language sql stable security definer set search_path = ''
  as $$
    select r.id, r.reason from public.outing_requests r
    where r.date = p_date
      and (private.can_read_outing_reasons() or r.requested_by = (select auth.uid()))
  $$;
revoke execute on function private.outing_request_reasons(date) from public, anon;
grant execute on function private.outing_request_reasons(date) to authenticated;
create function public.outing_request_reasons(p_date date) returns table (id uuid, reason text)
  language sql stable security invoker set search_path = ''
  as $$ select * from private.outing_request_reasons(p_date) $$;
revoke execute on function public.outing_request_reasons(date) from public, anon;
grant execute on function public.outing_request_reasons(date) to authenticated;

create function private.leave_reasons() returns table (id uuid, leave_reason text)
  language sql stable security definer set search_path = ''
  as $$
    select s.id, s.leave_reason from public.students s
    where s.leave_reason is not null
      and ((private.is_staff() and private.can_read_leave_reasons()) or s.id = private.my_student_id())
  $$;
revoke execute on function private.leave_reasons() from public, anon;
grant execute on function private.leave_reasons() to authenticated;
create function public.leave_reasons() returns table (id uuid, leave_reason text)
  language sql stable security invoker set search_path = ''
  as $$ select * from private.leave_reasons() $$;
revoke execute on function public.leave_reasons() from public, anon;
grant execute on function public.leave_reasons() to authenticated;
