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
  if (row.ban_from && row.ban_to) {
    student.outingBan = { from: row.ban_from, to: row.ban_to, reason: row.ban_reason || "" };
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
  const ban = data.outingBan;
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
    ban_from: ban ? ban.from : null,
    ban_to: ban ? ban.to : null,
    ban_reason: ban ? ban.reason || null : null,
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

// { [studentId]: { status, since(ms), reason, startTime, expectedReturn, checkedByName, notice } }
// notice = 외출 문자 결과(notify-outing이 기록): { status: "sending" | "not-configured" | "done", student, parent }
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
      checkedByName: row.checked_by_name || "",
      notice: row.notice && typeof row.notice === "object" ? row.notice : null,
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

// 학년부장의 화면 범위(사용자 요청): 체크·현황판·좌석 배치판에서 담당 학년 학생과 담당 실(+ 담당 학년이 앉는 실)만 보인다.
// 다른 역할은 전체. 화면에서 보이는 것만 줄이는 것이고, 읽기 권한(RLS)은 그대로다
export function isGradeInView(profile, grade) {
  if (!profile || profile.role !== "gradeManager") return true;
  return Boolean((profile.managedGrades || {})[String(grade)]);
}

export function isRoomInView(profile, roomId, room) {
  if (!profile || profile.role !== "gradeManager") return true;
  if ((profile.managedRooms || {})[roomId]) return true;
  return ((room && room.grades) || []).some((g) => isGradeInView(profile, g));
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

// ─── 외출 예정 ───
// 학생 신청을 승인하면 DB에는 바로 'out'으로 기록되지만, 신청한 외출 시각(start_time)이 아직 안 됐으면
// 화면에는 "외출 예정"으로 보여 주고 그 시각이 되면 "외출중"으로 바꾼다. 오늘 기록에만 해당.

// 이 컴퓨터의 지금 시각 "HH:MM"
export function currentHHMM(now = new Date()) {
  return `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
}

// outing.startTime(adapters 모양) 또는 start_time(DB 행) 둘 다 받는다.
export function isScheduledOuting(outing, dateKey, todayKey, now = new Date()) {
  const startTime = outing && (outing.startTime || outing.start_time);
  return Boolean(outing && outing.status === "out" && startTime && dateKey === todayKey && currentHHMM(now) < startTime);
}

// 가장 가까운 외출 시각이 되면 onTick을 부른다(그때 화면을 다시 그림). 화면마다 하나씩 만들어
// 그릴 때마다 update(오늘 외출 기록들)를 부르면 된다.
export function createStartTimeTicker(onTick) {
  let timer = null;
  return function update(outings) {
    if (timer) clearTimeout(timer);
    timer = null;
    const now = new Date();
    const nowText = currentHHMM(now);
    const upcoming = outings
      .filter((o) => o && o.status === "out")
      .map((o) => o.startTime || o.start_time)
      .filter((t) => /^\d{2}:\d{2}$/.test(t || "") && t > nowText)
      .sort();
    if (upcoming.length === 0) return;
    const [h, m] = upcoming[0].split(":").map(Number);
    const target = new Date(now);
    target.setHours(h, m, 0, 0);
    timer = setTimeout(onTick, Math.max(0, target - now) + 500);
  };
}
