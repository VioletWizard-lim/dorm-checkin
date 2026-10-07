// Firebase RTDB 데이터 → Supabase 테이블 행으로 변환하는 순수 함수(입출력 없음, 단위 테스트 대상).
// 예전 RTDB 키는 UUIDv5로 바꿔서 몇 번을 다시 돌려도 같은 id가 나오게 한다(좌석표·담당 실 참조가 유지됨).
import { v5 as uuidv5 } from "uuid";

export const NAMESPACE = "6f0b3c2a-6d4e-4c1b-9f43-3a8f2b7c9d10";
export const STAFF_EMAIL_DOMAIN = "donghall.local";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const STAFF_ID_RE = /^[a-z0-9]{1,32}$/;
const ROLES = new Set(["teacher", "gradeManager", "admin", "studyHallSupervisor", "dormStaff"]);
const OUTING_STATUSES = new Set(["in", "out", "away"]);
// 예전 실들의 순서(RTDB push 키 순)를 created_at으로 보존하기 위한 기준 시각.
const ROOM_ORDER_BASE = Date.UTC(2026, 0, 1);

export const studentUuid = (key) => uuidv5(`student:${key}`, NAMESPACE);
export const roomUuid = (key) => uuidv5(`room:${key}`, NAMESPACE);

const text = (value) => String(value ?? "").trim();

// students.js의 deriveClsFromSid와 같은 규칙: "10305" → "1학년 3반"
export function deriveCls(sid) {
  const match = /^(\d)(\d{2})\d{2}$/.exec(sid);
  return match ? `${match[1]}학년 ${Number(match[2])}반` : "";
}

function toGradeList(value) {
  const raw = Array.isArray(value) ? value : Object.values(value ?? {});
  const grades = raw.map(Number).filter((g) => g >= 1 && g <= 3);
  return [...new Set(grades)].sort();
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}

export function transform(rtdb = {}, authUsers = []) {
  const stats = {
    students: 0,
    skippedStudents: 0,
    rooms: 0,
    droppedSeats: 0,
    outings: 0,
    droppedOutings: 0,
    legacyOutingKeys: 0,
    staff: 0,
    skippedStaff: 0,
  };

  const students = [];
  const studentKeys = new Set();
  for (const grade of ["1", "2", "3"]) {
    const byKey = (rtdb.students ?? {})[grade] ?? {};
    for (const key of Object.keys(byKey).sort()) {
      const s = byKey[key];
      if (!s || typeof s !== "object") {
        stats.skippedStudents++;
        continue;
      }
      const sid = text(s.sid);
      const leave = s.leaveOfAbsence ?? {};
      const leaveValid = DATE_RE.test(leave.from ?? "") && DATE_RE.test(leave.to ?? "") && leave.from <= leave.to;
      students.push({
        id: studentUuid(key),
        legacy_key: key,
        grade: Number(grade),
        name: text(s.name).slice(0, 100) || "(이름 없음)",
        sid,
        cls: text(s.cls) || deriveCls(sid),
        email: text(s.email) || null,
        afterschool_days: [0, 1, 2, 3, 4].map((i) => Boolean((s.afterschoolDays ?? [])[i])),
        leave_from: leaveValid ? leave.from : null,
        leave_to: leaveValid ? leave.to : null,
        leave_reason: leaveValid ? text(leave.reason) || null : null,
      });
      studentKeys.add(key);
    }
  }
  stats.students = students.length;

  const rooms = [];
  const roomKeys = Object.keys(rtdb.rooms ?? {}).sort();
  const seated = new Set();
  roomKeys.forEach((key, index) => {
    const r = rtdb.rooms[key] ?? {};
    const rows = clampInt(r.rows, 1, 50, 3);
    const cols = clampInt(r.cols, 1, 50, 4);
    const seatMap = {};
    for (const cell of Object.keys(r.seatMap ?? {}).sort()) {
      const studentKey = r.seatMap[cell];
      const m = /^r(\d+)c(\d+)$/.exec(cell);
      if (!m || Number(m[1]) >= rows || Number(m[2]) >= cols || !studentKeys.has(studentKey) || seated.has(studentKey)) {
        stats.droppedSeats++;
        continue;
      }
      seatMap[cell] = studentUuid(studentKey);
      seated.add(studentKey);
    }
    rooms.push({
      id: roomUuid(key),
      legacy_key: key,
      name: text(r.name) || "이름 없음",
      grades: toGradeList(r.grades),
      rows,
      cols,
      seat_map: seatMap,
      created_at: new Date(ROOM_ORDER_BASE + index * 1000).toISOString(),
    });
  });
  stats.rooms = rooms.length;

  const outings = [];
  for (const date of Object.keys(rtdb.outings ?? {}).sort()) {
    // 날짜 키가 아닌 것은 outings/{studentId} 시절의 옛 데이터 — 옮기지 않는다.
    if (!DATE_RE.test(date)) {
      stats.legacyOutingKeys++;
      continue;
    }
    const byStudent = rtdb.outings[date] ?? {};
    for (const studentKey of Object.keys(byStudent).sort()) {
      const o = byStudent[studentKey];
      const status = o && o.status === "unauthorized" ? "away" : o && o.status;
      if (!studentKeys.has(studentKey) || !OUTING_STATUSES.has(status)) {
        stats.droppedOutings++;
        continue;
      }
      outings.push({
        date,
        student_id: studentUuid(studentKey),
        status,
        since: Number.isFinite(o.since) ? new Date(o.since).toISOString() : `${date}T00:00:00+09:00`,
        reason: status === "out" ? text(o.reason) || null : null,
        expected_return: status === "out" ? text(o.expectedReturn) || null : null,
      });
    }
  }
  stats.outings = outings.length;

  // 교직원은 관리자가 만든 계정(users/{uid} 항목이 있는 것)만 옮긴다. 아이디는 Auth 이메일 앞부분, 없으면 users.id.
  const emailByUid = new Map(authUsers.map((u) => [u.uid, u.email ?? ""]));
  const roomIdByKey = new Map(roomKeys.map((k) => [k, roomUuid(k)]));
  const staff = [];
  const usedIds = new Set();
  for (const uid of Object.keys(rtdb.users ?? {}).sort()) {
    const u = rtdb.users[uid] ?? {};
    const email = emailByUid.get(uid) ?? "";
    if (email && !email.endsWith(`@${STAFF_EMAIL_DOMAIN}`)) {
      stats.skippedStaff++;
      continue;
    }
    const loginId = text(email ? email.split("@")[0] : u.id).toLowerCase();
    if (!STAFF_ID_RE.test(loginId) || usedIds.has(loginId)) {
      stats.skippedStaff++;
      continue;
    }
    usedIds.add(loginId);

    const disabled = u.disabled === true;
    const role = disabled ? null : ROLES.has(u.role) ? u.role : "teacher";
    const managedClasses = [];
    if (role === "teacher") {
      for (const grade of Object.keys(u.managedClasses ?? {}).sort()) {
        for (const cls of Object.keys(u.managedClasses[grade] ?? {}).sort()) {
          if (Number(grade) >= 1 && Number(grade) <= 3) managedClasses.push({ grade: Number(grade), cls });
        }
      }
    }
    staff.push({
      loginId,
      profile: {
        login_id: loginId,
        kind: "staff",
        role,
        name: text(u.name) || null,
        disabled,
        managed_grades: role === "gradeManager" ? toGradeList(Object.keys(u.managedGrades ?? {})) : [],
        managed_rooms: role === "gradeManager"
          ? Object.keys(u.managedRooms ?? {}).map((k) => roomIdByKey.get(k)).filter(Boolean)
          : [],
        managed_classes: managedClasses,
      },
    });
  }
  stats.staff = staff.length;

  return { students, rooms, outings, staff, stats };
}
