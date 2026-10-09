// 매 테스트 시작 시 넣는 기본 데이터. id를 고정해서 테스트에서 바로 쓸 수 있게 한다.
export const PASSWORD = "pass1234";

export const ROOM = {
  first: "20000000-0000-4000-8000-000000000001", // 1학년실
  second: "20000000-0000-4000-8000-000000000002", // 2·3학년실
};

export const STUDENT = {
  hong: "10000000-0000-4000-8000-000000000001", // 1학년 3반, 1학년실 r0c0, 이메일·리로스쿨 ID(hong123)·연락처 있음, 방과후 월~금
  minjun: "10000000-0000-4000-8000-000000000002", // 1학년 1반, 1학년실 r0c1, 오늘 자리 없음
  seoyeon: "10000000-0000-4000-8000-000000000003", // 2학년 1반, 2·3학년실 r0c0
  jihun: "10000000-0000-4000-8000-000000000004", // 3학년 2반, 2·3학년실 r1c2, 명령퇴사 중
  haneul: "10000000-0000-4000-8000-000000000005", // 1학년 3반, 좌석 없음
};

export const STAFF = [
  { id: "00000000-0000-4000-8000-000000000001", loginId: "admin01", role: "admin", name: "관리자" },
  { id: "00000000-0000-4000-8000-000000000002", loginId: "dorm01", role: "dormStaff", name: "박기숙" },
  {
    id: "00000000-0000-4000-8000-000000000003",
    loginId: "gm01",
    role: "gradeManager",
    name: "1학년부장",
    managed_grades: [1],
    managed_rooms: [ROOM.first],
  },
  { id: "00000000-0000-4000-8000-000000000004", loginId: "teacher01", role: "teacher", name: "이교사" },
  {
    id: "00000000-0000-4000-8000-000000000005",
    loginId: "homeroom01",
    role: "teacher",
    name: "김담임",
    managed_classes: [{ grade: 1, cls: "1학년 3반" }],
  },
  { id: "00000000-0000-4000-8000-000000000006", loginId: "super01", role: "studyHallSupervisor", name: "야간감독" },
  { id: "00000000-0000-4000-8000-000000000007", loginId: "gone01", role: null, name: "퇴직교사", disabled: true },
];

export const staffId = (loginId) => STAFF.find((s) => s.loginId === loginId).id;

// 날짜는 학교 기준(KST) 오늘로 맞춘다.
export const SEED_SQL = `
insert into public.students (id, grade, name, sid, cls, email, login_id, phone, parent_phone, afterschool_days, leave_from, leave_to, leave_reason) values
  ('${STUDENT.hong}', 1, '홍길동', '10305', '1학년 3반', 'hong@example.com', 'hong123', '01011112222', '01033334444', '{t,t,t,t,t}', null, null, null),
  ('${STUDENT.minjun}', 1, '김민준', '10101', '1학년 1반', null, null, null, null, '{f,f,f,f,f}', null, null, null),
  ('${STUDENT.seoyeon}', 2, '이서연', '20101', '2학년 1반', null, 'seoyeon.lee', null, null, '{f,f,f,f,f}', null, null, null),
  ('${STUDENT.jihun}', 3, '박지훈', '30202', '3학년 2반', null, 'jihun_p', null, null, '{f,f,f,f,f}',
     public.today_kst() - 1, public.today_kst() + 5, '장기 결석'),
  ('${STUDENT.haneul}', 1, '최하늘', '10302', '1학년 3반', null, null, null, null, '{f,f,f,f,f}', null, null, null);

insert into public.rooms (id, name, grades, rows, cols, seat_map, created_at) values
  ('${ROOM.first}', '1학년실', '{1}', 2, 2,
     '{"r0c0": "${STUDENT.hong}", "r0c1": "${STUDENT.minjun}"}', '2026-01-01T00:00:00Z'),
  ('${ROOM.second}', '2·3학년실', '{2,3}', 2, 3,
     '{"r0c0": "${STUDENT.seoyeon}", "r1c2": "${STUDENT.jihun}"}', '2026-01-01T00:00:01Z');

-- 오늘은 방과후가 있는 날(현황판 "오늘 방과후"·좌석 색은 방과후 있는 날에만 나온다)
insert into public.afterschool_dates (date) values (public.today_kst());

insert into public.outings (date, student_id, status, since, reason, expected_return) values
  (public.today_kst(), '${STUDENT.minjun}', 'away', now() - interval '30 minutes', null, null),
  (public.today_kst() - 1, '${STUDENT.hong}', 'out', now() - interval '1 day', '병원', '17:00');
`;
