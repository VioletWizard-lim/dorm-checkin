-- RLS·RPC 테스트. tests/db/run.sh가 shim.sql → supabase/migrations/*.sql → 이 파일 순으로 적용한다.
-- 각 역할로 로그인한 것처럼 JWT의 sub를 바꾸고(set_config) authenticated 역할로 쿼리를 실행해 결과를 확인한다.
\set ON_ERROR_STOP on
\set QUIET on

create schema tests;
grant usage on schema tests to anon, authenticated, service_role;

create function tests.login(p_uid uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, false);
end $$;

create function tests.logout() returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', '', false);
end $$;

create function tests.expect_count(p_sql text, p_expected bigint, p_label text) returns void language plpgsql as $$
declare n bigint;
begin
  execute format('select count(*) from (%s) t', p_sql) into n;
  if n is distinct from p_expected then
    raise exception 'FAIL: % — expected % rows, got %', p_label, p_expected, n;
  end if;
  raise notice 'ok: %', p_label;
end $$;

create function tests.expect_affected(p_sql text, p_expected bigint, p_label text) returns void language plpgsql as $$
declare n bigint;
begin
  execute p_sql;
  get diagnostics n = row_count;
  if n is distinct from p_expected then
    raise exception 'FAIL: % — expected % affected rows, got %', p_label, p_expected, n;
  end if;
  raise notice 'ok: %', p_label;
end $$;

create function tests.expect_true(p_sql text, p_label text) returns void language plpgsql as $$
declare v boolean;
begin
  execute format('select (%s)::boolean', p_sql) into v;
  if not coalesce(v, false) then
    raise exception 'FAIL: % — condition was not true: %', p_label, p_sql;
  end if;
  raise notice 'ok: %', p_label;
end $$;

create function tests.expect_error(p_sql text, p_label text, p_like text default null) returns void language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when others then
    if p_like is not null and sqlerrm not like p_like then
      raise exception 'FAIL: % — unexpected error: %', p_label, sqlerrm;
    end if;
    raise notice 'ok: % (%)', p_label, sqlerrm;
    return;
  end;
  raise exception 'FAIL: % — expected an error but the statement succeeded', p_label;
end $$;

-- ─────────────────────────── 픽스처 ───────────────────────────
\set admin   '''00000000-0000-0000-0000-00000000000a'''
\set dorm    '''00000000-0000-0000-0000-00000000000d'''
\set gm1     '''00000000-0000-0000-0000-0000000000a1'''
\set t13     '''00000000-0000-0000-0000-0000000000b3'''
\set tplain  '''00000000-0000-0000-0000-0000000000b0'''
\set sup     '''00000000-0000-0000-0000-0000000000c0'''
\set dis     '''00000000-0000-0000-0000-0000000000d0'''
\set norole  '''00000000-0000-0000-0000-0000000000e0'''
\set s1      '''00000000-0000-0000-0000-0000000000f1'''
\set s2      '''00000000-0000-0000-0000-0000000000f2'''
\set st1     '''10000000-0000-0000-0000-000000000001'''
\set st2     '''10000000-0000-0000-0000-000000000002'''
\set st3     '''10000000-0000-0000-0000-000000000003'''
\set room1   '''20000000-0000-0000-0000-000000000001'''
\set room2   '''20000000-0000-0000-0000-000000000002'''

insert into auth.users (id, email)
select id::uuid, id || '@test.local'
from unnest(array[:admin, :dorm, :gm1, :t13, :tplain, :sup, :dis, :norole, :s1, :s2]) as id;

insert into public.students (id, grade, name, sid, cls, login_id) values
  (:st1, 1, '홍길동', '10305', '1학년 3반', 'hong'),
  (:st2, 2, '김민준', '20101', '2학년 1반', 'kimmin'),
  (:st3, 1, '박지훈', '10101', '1학년 1반', null);

insert into public.rooms (id, name, grades, rows, cols) values
  (:room1, '1학년실', '{1}', 2, 2),
  (:room2, '2학년실', '{2}', 2, 2);

insert into public.profiles (id, login_id, kind, role, name, disabled, managed_grades, managed_rooms, managed_classes, student_id) values
  (:admin,  'admin01',  'staff',   'admin',               '관리자',   false, '{}',  '{}',          '[]', null),
  (:dorm,   'dorm01',   'staff',   'dormStaff',           '기숙사부', false, '{}',  '{}',          '[]', null),
  (:gm1,    'gm01',     'staff',   'gradeManager',        '1학년부장', false, '{1}', array[:room1]::uuid[], '[]', null),
  (:t13,    'kim01',    'staff',   'teacher',             '김담임',   false, '{}',  '{}',          '[{"grade": 1, "cls": "1학년 3반"}]', null),
  (:tplain, 'lee01',    'staff',   'teacher',             '이교사',   false, '{}',  '{}',          '[]', null),
  (:sup,    'super01',  'staff',   'studyHallSupervisor', '박감독',   false, '{}',  '{}',          '[]', null),
  (:dis,    'gone01',   'staff',   null,                  '퇴직교사', true,  '{}',  '{}',          '[]', null),
  (:norole, 'norole01', 'staff',   null,                  null,       false, '{}',  '{}',          '[]', null),
  (:s1,     'hong',     'student', 'student',             '홍길동',   false, '{}',  '{}',          '[]', :st1),
  (:s2,     'kimmin',   'student', 'student',             '김민준',   false, '{}',  '{}',          '[]', :st2);

-- ─────────────────────────── anon ───────────────────────────
select tests.logout();
set role anon;
select tests.expect_error('select * from public.students', 'anon cannot read students', '%permission denied%');
select tests.expect_error('select * from public.outings', 'anon cannot read outings', '%permission denied%');
select tests.expect_error($$select public.create_outing_request('x')$$, 'anon cannot call RPC', '%permission denied%');
reset role;

-- ─────────────────── 역할 없는 계정 · 비활성 계정 ───────────────────
select tests.login(:norole);
set role authenticated;
select tests.expect_count('select * from public.students', 0, 'role-less account sees no students');
select tests.expect_count('select * from public.rooms', 0, 'role-less account sees no rooms');
select tests.expect_count('select * from public.profiles', 1, 'role-less account sees only own profile');
select tests.expect_error(format($$insert into public.outings (date, student_id, status) values (current_date, %L, 'out')$$, :st1),
  'role-less account cannot write outings', '%row-level security%');
reset role;

select tests.login(:dis);
set role authenticated;
select tests.expect_count('select * from public.students', 0, 'disabled account sees no students');
reset role;

-- ─────────────────────────── 관리자 ───────────────────────────
select tests.login(:admin);
set role authenticated;
select tests.expect_count('select * from public.students', 3, 'admin sees all students');
select tests.expect_count('select * from public.profiles', 10, 'admin sees all profiles');
select tests.expect_affected(format($$update public.students set name = '김민준' where id = %L$$, :st2), 1, 'admin edits any student');
select tests.expect_affected(format($$update public.profiles set role = 'gradeManager', managed_grades = '{2}' where id = %L$$, :tplain), 1,
  'admin changes another staff role');
select tests.expect_affected(format($$update public.profiles set role = 'teacher', managed_grades = '{}' where id = %L$$, :tplain), 1,
  'admin changes it back');
select tests.expect_affected(format($$update public.profiles set name = '나' where id = %L$$, :admin), 0, 'admin cannot edit own profile');
select tests.expect_affected(format($$update public.profiles set name = 'x' where id = %L$$, :s1), 0, 'admin cannot edit student profiles');
select tests.expect_error(format($$update public.profiles set login_id = 'x' where id = %L$$, :tplain),
  'login_id is not updatable by clients', '%permission denied%');
select tests.expect_error(format($$update public.profiles set disabled = true where id = %L$$, :tplain),
  'disabled is not updatable by clients', '%permission denied%');
select tests.expect_error(format($$update public.profiles set role = 'student' where id = %L$$, :tplain),
  'staff cannot be turned into student', '%profiles_kind_role%');
reset role;

-- ─────────────────────────── 담임(1학년 3반) ───────────────────────────
select tests.login(:t13);
set role authenticated;
select tests.expect_count('select * from public.students', 3, 'staff reads every student');
select tests.expect_affected(format($$update public.students set sid = '10305' where id = %L$$, :st1), 1, 'homeroom edits own class');
select tests.expect_affected(format($$update public.students set sid = '10101' where id = %L$$, :st3), 0, 'homeroom cannot edit other class');
select tests.expect_error(format($$update public.students set cls = '1학년 1반' where id = %L$$, :st1),
  'homeroom cannot move student out of own class', '%row-level security%');
select tests.expect_error($$insert into public.students (grade, name, sid, cls) values (1, '새학생', '10102', '1학년 1반')$$,
  'homeroom cannot add to other class', '%row-level security%');
select tests.expect_affected($$insert into public.students (grade, name, sid, cls) values (1, '새학생', '10399', '1학년 3반')$$, 1,
  'homeroom adds to own class');
select tests.expect_affected($$delete from public.students where name = '새학생'$$, 1, 'homeroom deletes from own class');
select tests.expect_affected(format($$update public.profiles set name = 'x' where id = %L$$, :tplain), 0, 'teacher cannot edit profiles');
reset role;

-- ─────────────────────────── 학년부장(1학년, 1학년실) ───────────────────────────
select tests.login(:gm1);
set role authenticated;
select tests.expect_affected(format($$update public.students set sid = sid where id = %L$$, :st3), 1, 'grade manager edits own grade');
select tests.expect_affected(format($$update public.students set sid = sid where id = %L$$, :st2), 0, 'grade manager cannot edit other grade');
select public.assign_seat(:room1, 'r0c0', :st1);
select tests.expect_true(format($$(select seat_map ->> 'r0c0' from public.rooms where id = %L) = %L$$, :room1, :st1),
  'grade manager assigns a seat in managed room');
select tests.expect_error(format($$select public.assign_seat(%L, 'r0c0', %L)$$, :room2, :st2),
  'grade manager cannot edit unmanaged room', '%권한%');
select tests.expect_error(format($$select public.assign_seat(%L, 'r0c1', %L)$$, :room1, :st2),
  'room grade mismatch is rejected', '%대상 학년%');
select tests.expect_error(format($$select public.assign_seat(%L, 'r5c0', %L)$$, :room1, :st3),
  'out-of-range seat is rejected', '%좌석 위치%');
select tests.expect_affected(format($$update public.rooms set name = 'x' where id = %L$$, :room1), 0, 'grade manager cannot rename rooms');
select tests.expect_error(format($$select public.resize_room(%L, 1, 1)$$, :room1), 'grade manager cannot resize rooms', '%권한%');
reset role;

-- ─────────────────────────── 관리자: 실·좌석 ───────────────────────────
select tests.login(:admin);
set role authenticated;
select public.assign_seat(:room1, 'r1c1', :st3);
select tests.expect_true(format($$(select seat_map ? 'r1c1' from public.rooms where id = %L)$$, :room1), 'admin assigns any seat');
select public.resize_room(:room1, 1, 2);
select tests.expect_true(format($$(select seat_map ? 'r0c0' and not seat_map ? 'r1c1' and rows = 1 from public.rooms where id = %L)$$, :room1),
  'shrinking a room drops seats outside the new grid');
select public.assign_seat(:room1, 'r0c1', :st1);
select tests.expect_true(format($$(select not seat_map ? 'r0c0' and seat_map ->> 'r0c1' = %L from public.rooms where id = %L)$$, :st1, :room1),
  'reassigning a student moves them instead of duplicating');
select tests.expect_affected($$insert into public.rooms (name) values ('임시실')$$, 1, 'admin adds a room');
select tests.expect_affected($$delete from public.rooms where name = '임시실'$$, 1, 'admin deletes a room');
select tests.expect_affected(format($$update public.students set sid = sid where id = %L$$, :st2), 1, 'admin edits any student');
reset role;

-- ─────────────────── 기숙사부: 보기 + 명령퇴사 기간만 ───────────────────
select tests.login(:dorm);
set role authenticated;
select tests.expect_count('select * from public.students', 3, 'dorm staff reads all students');
select tests.expect_count('select * from public.rooms', 2, 'dorm staff reads rooms');
select tests.expect_affected(format($$update public.students set leave_from = current_date, leave_to = current_date + 3, leave_reason = '명령퇴사' where id = %L$$, :st2),
  1, 'dorm staff sets a leave period on any student');
select tests.expect_affected(format($$update public.students set leave_from = null, leave_to = null, leave_reason = null where id = %L$$, :st2),
  1, 'dorm staff clears a leave period');
select tests.expect_error(format($$update public.students set name = '바뀐 이름' where id = %L$$, :st2),
  'dorm staff cannot edit other student fields', '%명령퇴사 기간만%');
select tests.expect_error(format($$update public.students set leave_reason = 'x', phone = '01099998888' where id = %L$$, :st2),
  'dorm staff cannot sneak other fields into a leave update', '%명령퇴사 기간만%');
select tests.expect_error($$insert into public.students (grade, name, sid, cls) values (1, '새학생', '10199', '1학년 1반')$$,
  'dorm staff cannot add students', '%row-level security%');
select tests.expect_affected(format($$delete from public.students where id = %L$$, :st2), 0, 'dorm staff cannot delete students');
select tests.expect_error(format($$insert into public.outings (date, student_id, status) values (public.today_kst(), %L, 'out')$$, :st2),
  'dorm staff cannot check outings', '%row-level security%');
select tests.expect_affected($$update public.outings set status = 'in'$$, 0, 'dorm staff cannot return or cancel outings');
select tests.expect_error(format($$select public.assign_seat(%L, 'r0c0', %L)$$, :room1, :st2), 'dorm staff cannot assign seats', '%권한%');
select tests.expect_error(format($$select public.resize_room(%L, 2, 2)$$, :room1), 'dorm staff cannot resize rooms', '%권한%');
select tests.expect_error($$insert into public.rooms (name) values ('임시실')$$, 'dorm staff cannot add rooms', '%row-level security%');
select tests.expect_affected($$update public.rooms set name = '바뀐 실'$$, 0, 'dorm staff cannot rename rooms');
select tests.expect_affected(format($$update public.profiles set name = 'x' where id = %L$$, :tplain), 0, 'dorm staff cannot edit accounts');
reset role;

-- ─────────────────────────── 학생 ───────────────────────────
select tests.login(:s1);
set role authenticated;
select tests.expect_count('select * from public.students', 1, 'student sees only own student row');
select tests.expect_count('select * from public.profiles', 1, 'student sees only own profile');
select tests.expect_count('select * from public.rooms', 0, 'student cannot read rooms');
select tests.expect_affected(format($$update public.students set name = 'x' where id = %L$$, :st1), 0, 'student cannot edit own row');
select tests.expect_error(format($$insert into public.outings (date, student_id, status) values (current_date, %L, 'in')$$, :st1),
  'student cannot write outings', '%row-level security%');
select tests.expect_error(format($$insert into public.outing_requests (date, student_id, requested_by, reason) values (current_date, %L, %L, 'x')$$, :st1, :s1),
  'student cannot insert requests directly', '%permission denied%');
select tests.expect_error($$select public.create_outing_request('   ')$$, 'empty reason is rejected', '%사유%');
select tests.expect_error($$select public.create_outing_request('병원', '17:00', '25:00')$$, 'bad start time is rejected', '%외출 시각%');
select public.create_outing_request('병원 진료', '17:00', '15:30');
select tests.expect_count('select * from public.outing_requests', 1, 'student sees own request');
select tests.expect_error($$select public.create_outing_request('또 나가요')$$, 'second pending request is rejected', '%기다리는%');
select tests.expect_error(format($$select public.assign_seat(%L, 'r0c0', %L)$$, :room1, :st1), 'student cannot assign seats', '%권한%');
reset role;

select tests.logout();
select id as req1 from public.outing_requests where student_id = :st1 \gset

select tests.login(:s2);
set role authenticated;
select tests.expect_count('select * from public.outing_requests', 0, 'student cannot see other requests');
select tests.expect_error(format($$select public.cancel_outing_request(%L)$$, :'req1'), 'student cannot cancel other request', '%취소할 수 있는%');
reset role;

-- ─────────────────────────── 승인 ───────────────────────────
select tests.login(:tplain);
set role authenticated;
select tests.expect_error(format($$select public.approve_outing_request(%L)$$, :'req1'), 'plain teacher cannot approve', '%권한%');
reset role;

select tests.login(:sup);
set role authenticated;
select tests.expect_error(format($$select public.approve_outing_request(%L)$$, :'req1'), 'study hall supervisor cannot approve', '%권한%');
reset role;

select tests.login(:s1);
set role authenticated;
select tests.expect_error(format($$select public.approve_outing_request(%L)$$, :'req1'), 'student cannot approve', '%권한%');
reset role;

select tests.login(:t13);
set role authenticated;
select public.approve_outing_request(:'req1');
select tests.expect_error(format($$select public.approve_outing_request(%L)$$, :'req1'), 'already processed request', '%이미 처리%');
reset role;

select tests.logout();
select tests.expect_true(format($$exists (select 1 from public.outings o where o.student_id = %L and o.date = public.today_kst()
  and o.status = 'out' and o.reason = '병원 진료' and o.start_time = '15:30' and o.expected_return = '17:00' and o.checked_by = %L
  and o.checked_by_name = '김담임' and o.request_id = %L)$$, :st1, :t13, :'req1'),
  'approval writes the outing with approver as 담당 교사');
select tests.expect_true(format($$(select status = 'approved' and decided_by = %L and decided_by_name = '김담임'
  from public.outing_requests where id = %L)$$, :t13, :'req1'), 'request is marked approved');

select tests.login(:s1);
set role authenticated;
select tests.expect_error($$select public.create_outing_request('또 나가요')$$, 'student already out cannot request', '%외출 중%');
select tests.expect_count('select * from public.outings', 1, 'student sees own outing');
reset role;

-- 복귀 체크하면 외출 시각·사유·예상 복귀가 함께 비워진다
select tests.login(:t13);
set role authenticated;
select tests.expect_affected(format($$update public.outings set status = 'in' where student_id = %L and date = public.today_kst()$$, :st1), 1, 'teacher marks return');
select tests.expect_true(format($$(select start_time is null and reason is null and expected_return is null and request_id is null
  from public.outings where student_id = %L and date = public.today_kst())$$, :st1), 'return clears start time and request fields');
select tests.expect_affected(format($$update public.outings set status = 'out' where student_id = %L and date = public.today_kst()$$, :st1), 1, 'teacher marks out again');
-- 다른 학년 학생(2학년 1반)의 외출·복귀
select tests.expect_affected(format($$insert into public.outings (date, student_id, status, reason) values (public.today_kst(), %L, 'out', '학원')$$, :st2), 1, 'teacher checks out a student of another grade');
select tests.expect_affected(format($$update public.outings set status = 'in' where student_id = %L and date = public.today_kst()$$, :st2), 1, 'and marks the return');
reset role;
select tests.logout();

-- ─────────────────────────── 외출 기록(outing_log) ───────────────────────────
select tests.expect_true(format($$(select count(*) = 2
    and count(*) filter (where request_id = %L and start_time = '15:30' and reason = '병원 진료' and out_by_name = '김담임'
                           and ended_at is not null and ended_by_name = '김담임') = 1
    and count(*) filter (where request_id is null and ended_at is null) = 1
  from public.outing_log where student_id = %L and date = public.today_kst())$$, :'req1', :st1),
  'outing log keeps the approved outing with its return time, and the new open one');
select tests.expect_true(format($$(select count(*) = 1 and bool_and(reason = '학원' and ended_at >= out_at)
  from public.outing_log where student_id = %L)$$, :st2), 'outing log records a direct check-out and its return');

select tests.login(:t13);
set role authenticated;
select tests.expect_count(format($$select * from public.outing_log where student_id = %L$$, :st1), 2, 'homeroom sees own class history');
select tests.expect_count(format($$select * from public.outing_log where student_id = %L$$, :st2), 0, 'homeroom cannot see other class history');
select tests.expect_error($$insert into public.outing_log (date, student_id, out_at) values (current_date, gen_random_uuid(), now())$$,
  'nobody writes the outing log directly', '%permission denied%');
reset role;
select tests.login(:gm1);
set role authenticated;
select tests.expect_count('select * from public.outing_log', 2, 'grade manager sees own grade history only');
reset role;
select tests.login(:admin);
set role authenticated;
select tests.expect_count('select * from public.outing_log', 3, 'admin sees all history');
reset role;
select tests.login(:dorm);
set role authenticated;
select tests.expect_count('select * from public.outing_log', 0, 'dorm staff cannot see history');
reset role;
select tests.login(:tplain);
set role authenticated;
select tests.expect_count('select * from public.outing_log', 0, 'teacher without a class cannot see history');
reset role;
select tests.logout();

-- ─────────────────────────── 지난 날짜는 보기만 ───────────────────────────
insert into public.outings (date, student_id, status) values (public.today_kst() - 1, :st3, 'out');
select tests.login(:t13);
set role authenticated;
select tests.expect_affected(format($$update public.outings set status = 'in' where student_id = %L and date = public.today_kst() - 1$$, :st3),
  0, 'past outings cannot be changed');
select tests.expect_error(format($$insert into public.outings (date, student_id, status) values (public.today_kst() - 1, %L, 'out')$$, :st1),
  'past outings cannot be added', '%row-level security%');
reset role;
select tests.logout();

-- ─────────────────── 명령퇴사 기간은 관리자·기숙사부만 ───────────────────
select tests.login(:t13);
set role authenticated;
select tests.expect_error(format($$update public.students set leave_from = current_date, leave_to = current_date where id = %L$$, :st1),
  'homeroom cannot set a leave period', '%관리자·기숙사부만%');
select tests.expect_affected(format($$update public.students set name = name where id = %L$$, :st1), 1, 'homeroom still edits other fields');
reset role;
select tests.login(:gm1);
set role authenticated;
select tests.expect_error($$insert into public.students (grade, name, sid, cls, leave_from, leave_to) values (1, '새학생', '10199', '1학년 1반', current_date, current_date)$$,
  'grade manager cannot add a student with a leave period', '%관리자·기숙사부만%');
reset role;
select tests.login(:admin);
set role authenticated;
select tests.expect_affected(format($$update public.students set leave_from = current_date, leave_to = current_date where id = %L$$, :st1), 1, 'admin sets a leave period');
select tests.expect_affected(format($$update public.students set leave_from = null, leave_to = null where id = %L$$, :st1), 1, 'admin clears it');
reset role;
select tests.logout();

-- ─────────────────────────── 반려 · 취소 ───────────────────────────
select tests.login(:s2);
set role authenticated;
select public.create_outing_request('집에 다녀올게요');
reset role;
select tests.logout();
select id as req2 from public.outing_requests where student_id = :st2 and status = 'pending' \gset

select tests.login(:gm1);
set role authenticated;
select tests.expect_error(format($$select public.reject_outing_request(%L)$$, :'req2'), 'grade manager cannot reject other grade', '%권한%');
reset role;

select tests.login(:dorm);
set role authenticated;
select tests.expect_error(format($$select public.approve_outing_request(%L)$$, :'req2'), 'dorm staff cannot approve', '%권한%');
select tests.expect_error(format($$select public.reject_outing_request(%L)$$, :'req2'), 'dorm staff cannot reject', '%권한%');
reset role;

select tests.login(:admin);
set role authenticated;
select public.reject_outing_request(:'req2', '사유를 구체적으로');
reset role;
select tests.logout();
select tests.expect_true(format($$(select status = 'rejected' and reject_reason = '사유를 구체적으로' from public.outing_requests where id = %L)$$, :'req2'),
  'admin rejects with a reason');

select tests.login(:s2);
set role authenticated;
select public.create_outing_request('다시 신청');
reset role;
select tests.logout();
select id as req3 from public.outing_requests where student_id = :st2 and status = 'pending' \gset

select tests.login(:s1);
set role authenticated;
select tests.expect_error(format($$select public.cancel_outing_request(%L)$$, :'req3'), 'student cannot cancel classmate request', '%취소할 수 있는%');
reset role;

select tests.login(:s2);
set role authenticated;
select public.cancel_outing_request(:'req3');
reset role;
select tests.logout();
select tests.expect_true(format($$(select status = 'cancelled' from public.outing_requests where id = %L)$$, :'req3'), 'student cancels own request');

-- ─────────────────────────── 외출 기록 트리거 ───────────────────────────
select tests.login(:sup);
set role authenticated;
select tests.expect_affected(format($$insert into public.outings (date, student_id, status, since, checked_by, checked_by_name, reason)
  values (public.today_kst(), %L, 'away', '2000-01-01', %L, '가짜', '무시됨')$$, :st3, :admin), 1, 'supervisor writes an outing');
reset role;
select tests.logout();
select tests.expect_true(format($$(select checked_by = %L and checked_by_name = '박감독' and since > '2001-01-01' and reason is null
  from public.outings where student_id = %L and date = public.today_kst())$$, :sup, :st3),
  'trigger stamps server time and the real author, drops reason for non-out');

-- ─────────────────────────── 자동 복귀(복귀 예정 시각이 지나면) ───────────────────────────
update public.outings set status = 'out', expected_return = '0:00', reason = '자동 복귀 시험'
 where student_id = :st3 and date = public.today_kst();
select tests.expect_true('(select private.auto_return_outings() >= 1)', 'auto return runs');
select tests.expect_true(format($$(select status = 'in' and checked_by_name = '자동 복귀' and expected_return is null
  from public.outings where student_id = %L and date = public.today_kst())$$, :st3), 'an outing past its expected return becomes 재실');
select tests.expect_true(format($$(select ended_by_name = '자동 복귀' and ended_at is not null
  from public.outing_log where student_id = %L and reason = '자동 복귀 시험')$$, :st3), 'outing log records the automatic return');
select tests.expect_true(format($$(select status = 'out' from public.outings where student_id = %L and date = public.today_kst())$$, :st1),
  'an outing without an expected return stays out');
select tests.login(:admin);
set role authenticated;
select tests.expect_error('select private.auto_return_outings()', 'clients cannot run the auto return', '%permission denied%');
reset role;
select tests.logout();

-- service_role(이전 스크립트)은 보낸 값을 그대로 유지한다.
insert into public.outings (date, student_id, status, since, reason, checked_by_name)
values ('2026-01-05', :st2, 'out', '2026-01-05 09:00+09', '과거 기록', '옛 교사');
select tests.expect_true(format($$(select since = '2026-01-05 09:00+09' and checked_by_name = '옛 교사'
  from public.outings where student_id = %L and date = '2026-01-05')$$, :st2), 'migration keeps historical values');

-- ─────────────────────────── 학생 아이디 잠금 · 삭제 정리 ───────────────────────────
select tests.expect_error(format($$update public.students set login_id = 'hong2' where id = %L$$, :st1),
  'login id is locked once an account exists', '%아이디는 바꿀 수 없습니다%');
select tests.expect_affected(format($$update public.students set login_id = 'parkj' where id = %L$$, :st3), 1,
  'login id is editable before an account exists');
select tests.expect_error(format($$update public.students set login_id = 'Bad Id' where id = %L$$, :st3),
  'login id format is enforced', '%students_login_id_check%');
select tests.expect_error(format($$update public.students set phone = '02-123-4567' where id = %L$$, :st3),
  'phone format is enforced', '%students_phone_check%');

select tests.login(:admin);
set role authenticated;
select public.assign_seat(:room1, 'r0c0', :st3);
reset role;
select tests.logout();
delete from public.students where id = :st3;
select tests.expect_true(format($$(select not exists (select 1 from jsonb_each(seat_map) e where e.value = to_jsonb(%L::text))
  from public.rooms where id = %L)$$, :st3, :room1), 'deleting a student clears their seat');

-- ─────────────────────────── service_role ───────────────────────────
-- 이전 스크립트·Edge Function이 쓰는 역할: RLS를 우회하고 모든 테이블을 읽고 쓸 수 있어야 한다.
set role service_role;
select tests.expect_count('select * from public.students', 2, 'service role reads every student');
select tests.expect_count('select * from public.outing_requests', 3, 'service role reads every request');
select tests.expect_affected('update public.profiles set name = name', 10, 'service role updates every profile');
reset role;

-- ─────────────────────────── Realtime ───────────────────────────
select tests.expect_count($$select * from pg_publication_tables where pubname = 'supabase_realtime'$$, 5, 'realtime publishes the 5 app tables');

-- ─────────────────────────── API로 열린 함수 ───────────────────────────
-- Supabase 보안 점검과 같은 기준: public(API로 열린 스키마)의 security definer 함수를 anon·authenticated가 부를 수 없어야 한다.
select tests.expect_true($$not exists (
  select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.prosecdef and p.prorettype <> 'trigger'::regtype
     and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'))
)$$, 'no security definer function in public is callable through the API');
select tests.expect_true($$not has_schema_privilege('anon', 'private', 'usage')$$, 'anon cannot use the private schema');

\echo 'ALL DB TESTS PASSED'
