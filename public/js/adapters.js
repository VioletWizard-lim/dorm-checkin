// Supabase(Postgres) 행 ↔ 화면 코드가 쓰는 형태 변환.
// 화면 코드는 Firebase 시절의 모양(students/{학년}/{id}, rooms/{id}.seatMap 등)을 그대로 쓰고,
// DB 열 이름(snake_case)·타입과의 차이는 여기서만 맞춘다.

export const GRADES = ["1", "2", "3"];

const EMPTY_DAYS = [false, false, false, false, false];

export function studentFromRow(row) {
  const days = Array.isArray(row.afterschool_days) ? row.afterschool_days : EMPTY_DAYS;
  const student = {
    grade: String(row.grade),
    name: row.name || "",
    sid: row.sid || "",
    cls: row.cls || "",
    email: row.email || "",
    loginId: row.login_id || "", // ID(학생 로그인 아이디)
    phone: row.phone || "",
    parentPhone: row.parent_phone || "",
    afterschoolDays: EMPTY_DAYS.map((_, i) => days[i] === true),
  };
  if (row.leave_from && row.leave_to) {
    student.leaveOfAbsence = { from: row.leave_from, to: row.leave_to, reason: row.leave_reason || "" };
  }
  return student;
}

// { "1": { [id]: student }, "2": {...}, "3": {...} }
export function groupStudentsByGrade(rows) {
  const byGrade = { "1": {}, "2": {}, "3": {} };
  for (const row of rows) {
    const student = studentFromRow(row);
    if (byGrade[student.grade]) byGrade[student.grade][row.id] = student;
  }
  return byGrade;
}

// 학생 추가·수정 폼 값 → students 행
export function studentToRow(grade, data) {
  const leave = data.leaveOfAbsence;
  return {
    grade: Number(grade),
    name: data.name,
    sid: data.sid,
    cls: data.cls,
    email: data.email || null,
    login_id: data.loginId || null,
    phone: data.phone || null,
    parent_phone: data.parentPhone || null,
    afterschool_days: EMPTY_DAYS.map((_, i) => Boolean((data.afterschoolDays || [])[i])),
    leave_from: leave ? leave.from : null,
    leave_to: leave ? leave.to : null,
    leave_reason: leave ? leave.reason || null : null,
  };
}

export function roomFromRow(row) {
  return {
    name: row.name || "",
    grades: (row.grades || []).map(String).sort(),
    rows: Number(row.rows) || 1,
    cols: Number(row.cols) || 1,
    seatMap: row.seat_map && typeof row.seat_map === "object" ? row.seat_map : {},
  };
}

// 행 순서(실 생성 순)를 유지한 { [roomId]: room }
export function roomsById(rows) {
  const rooms = {};
  for (const row of rows) rooms[row.id] = roomFromRow(row);
  return rooms;
}

// { [studentId]: { status, since(ms), reason, startTime, expectedReturn } }
// startTime = 학생이 신청한 외출 시각("19:00", 승인한 외출만). 교사가 직접 체크한 외출은 ""(since를 씀)
export function outingsByStudent(rows) {
  const outings = {};
  for (const row of rows) {
    outings[row.student_id] = {
      status: row.status,
      since: Date.parse(row.since) || 0,
      reason: row.reason || "",
      startTime: row.start_time || "",
      expectedReturn: row.expected_return || "",
    };
  }
  return outings;
}

// profiles 행 → 예전 users/{uid} 모양
//   managedGrades: { "1": true }, managedRooms: { [roomId]: true }, managedClasses: { "1": { "1학년 3반": true } }
export function userFromProfile(row) {
  const managedClasses = {};
  for (const item of Array.isArray(row.managed_classes) ? row.managed_classes : []) {
    const grade = String(item && item.grade);
    const cls = item && typeof item.cls === "string" ? item.cls : "";
    if (!GRADES.includes(grade) || !cls) continue;
    if (!managedClasses[grade]) managedClasses[grade] = {};
    managedClasses[grade][cls] = true;
  }
  return {
    id: row.login_id || "",
    role: row.role || null,
    name: row.name || "",
    managedGrades: Object.fromEntries((row.managed_grades || []).map((g) => [String(g), true])),
    managedRooms: Object.fromEntries((row.managed_rooms || []).map((roomId) => [roomId, true])),
    managedClasses,
    disabled: row.disabled === true,
  };
}

// 담임 반 { "1": ["1학년 3반"] } → profiles.managed_classes [{ grade: 1, cls: "1학년 3반" }] (grade는 숫자)
export function managedClassesToRows(classesByGrade) {
  const rows = [];
  for (const grade of GRADES) {
    for (const cls of classesByGrade[grade] || []) rows.push({ grade: Number(grade), cls });
  }
  return rows;
}

// 휴대폰 번호: 숫자만 남겨 01로 시작하는 10~11자리면 그 값, 비어 있으면 "", 형식이 틀리면 null
export function normalizePhone(raw) {
  const digits = String(raw || "").replace(/[^0-9]/g, "");
  if (!digits) return "";
  return /^01[0-9]{8,9}$/.test(digits) ? digits : null;
}

export function formatPhone(digits) {
  if (!digits) return "";
  return digits.length === 11
    ? `${digits.slice(0, 3)}-${digits.slice(3, 7)}-${digits.slice(7)}`
    : `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
}

// ID: 소문자로 바꿔 영문·숫자·. _ - 64자 이하면 그 값, 비어 있으면 "", 형식이 틀리면 null
// (supabase/functions/_shared/accounts.ts의 normalizeStudentId, DB 제약과 같은 규칙)
export function normalizeLoginId(raw) {
  const value = String(raw || "").trim().toLowerCase();
  if (!value) return "";
  return /^[a-z0-9._-]{1,64}$/.test(value) ? value : null;
}
