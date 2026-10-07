import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveCls, roomUuid, studentUuid, transform } from "./transform.mjs";

const rtdb = {
  users: {
    "uid-admin": { id: "Admin01", role: "admin", name: "임재성" },
    "uid-gm": { id: "gm01", role: "gradeManager", name: "1학년부장", managedGrades: { 1: true }, managedRooms: { roomA: true, gone: true } },
    "uid-t": { id: "kim01", role: "teacher", managedClasses: { 1: { "1학년 3반": true } } },
    "uid-noid": { role: "teacher" },
    "uid-gone": { id: "gone01", name: "퇴직", disabled: true },
    "uid-dup": { id: "kim01", role: "teacher" },
    "uid-legacy": { id: "old01" },
  },
  students: {
    1: {
      stA: { name: "홍길동", sid: "10305", cls: "1학년 3반", email: "hong@example.com", afterschoolDays: [true, false, true] },
      stB: { name: "박지훈", sid: "10102", leaveOfAbsence: { from: "2026-09-18", to: "2026-09-25", reason: "가정 사정" } },
      stBad: "not an object",
    },
    2: {
      stC: { name: "김민준", sid: "20101", cls: "2학년 1반", leaveOfAbsence: { from: "2026-09-25", to: "2026-09-18" } },
    },
  },
  rooms: {
    roomB: { name: "2학년실", grades: ["2"], rows: 2, cols: 2, seatMap: { r0c0: "stC" } },
    roomA: { name: "1학년실", grades: ["1", "x"], rows: 1, cols: 2, seatMap: { r0c0: "stA", r0c1: "stA", r1c0: "stB", r0c5: "stB", bad: "stB" } },
  },
  outings: {
    "2026-09-20": {
      stA: { status: "out", since: 1758340800000, reason: "병원", expectedReturn: "17:00" },
      stB: { status: "unauthorized", since: 1758340900000, reason: "남은 값" },
      stC: { status: "in" },
      ghost: { status: "out" },
      stD: { status: "weird" },
    },
    "-legacyPushKey": { status: "out" },
  },
};

const authUsers = [
  { uid: "uid-admin", email: "admin01@donghall.local" },
  { uid: "uid-gm", email: "gm01@donghall.local" },
  { uid: "uid-t", email: "kim01@donghall.local" },
  { uid: "uid-gone", email: "gone01@donghall.local" },
  { uid: "uid-dup", email: "kim01x@gmail.com" },
];

test("class name follows the students page rule", () => {
  assert.equal(deriveCls("10305"), "1학년 3반");
  assert.equal(deriveCls("21012"), "2학년 10반");
  assert.equal(deriveCls("abc"), "");
});

test("students keep their data under deterministic ids", () => {
  const { students, stats } = transform(rtdb, authUsers);
  assert.equal(stats.students, 3);
  assert.equal(stats.skippedStudents, 1);
  const hong = students.find((s) => s.legacy_key === "stA");
  assert.deepEqual(hong, {
    id: studentUuid("stA"),
    legacy_key: "stA",
    grade: 1,
    name: "홍길동",
    sid: "10305",
    cls: "1학년 3반",
    email: "hong@example.com",
    afterschool_days: [true, false, true, false, false],
    leave_from: null,
    leave_to: null,
    leave_reason: null,
  });
  assert.equal(studentUuid("stA"), transform(rtdb, authUsers).students[0].id, "re-running gives the same id");

  const park = students.find((s) => s.legacy_key === "stB");
  assert.equal(park.cls, "1학년 1반", "missing class is derived from 학번");
  assert.deepEqual([park.leave_from, park.leave_to, park.leave_reason], ["2026-09-18", "2026-09-25", "가정 사정"]);

  const kim = students.find((s) => s.legacy_key === "stC");
  assert.equal(kim.leave_from, null, "reversed leave range is dropped");
});

test("rooms keep order, grades and only valid, unique seats", () => {
  const { rooms, stats } = transform(rtdb, authUsers);
  assert.deepEqual(rooms.map((r) => r.legacy_key), ["roomA", "roomB"]);
  assert.ok(rooms[0].created_at < rooms[1].created_at);
  const roomA = rooms[0];
  assert.equal(roomA.id, roomUuid("roomA"));
  assert.deepEqual(roomA.grades, [1]);
  assert.deepEqual(roomA.seat_map, { r0c0: studentUuid("stA") });
  assert.equal(stats.droppedSeats, 4, "duplicate seat, out of range x2, malformed key");
});

test("outings map unauthorized to away and drop unknown students and legacy keys", () => {
  const { outings, stats } = transform(rtdb, authUsers);
  assert.deepEqual(outings, [
    {
      date: "2026-09-20",
      student_id: studentUuid("stA"),
      status: "out",
      since: new Date(1758340800000).toISOString(),
      reason: "병원",
      expected_return: "17:00",
    },
    {
      date: "2026-09-20",
      student_id: studentUuid("stB"),
      status: "away",
      since: new Date(1758340900000).toISOString(),
      reason: null,
      expected_return: null,
    },
    {
      date: "2026-09-20",
      student_id: studentUuid("stC"),
      status: "in",
      since: "2026-09-20T00:00:00+09:00",
      reason: null,
      expected_return: null,
    },
  ]);
  assert.equal(stats.droppedOutings, 2);
  assert.equal(stats.legacyOutingKeys, 1);
});

test("staff keep role and scopes, with lowercase login ids from the auth email", () => {
  const { staff, stats } = transform(rtdb, authUsers);
  const byId = Object.fromEntries(staff.map((s) => [s.loginId, s.profile]));
  assert.deepEqual(Object.keys(byId).sort(), ["admin01", "gm01", "gone01", "kim01", "old01"]);
  assert.equal(byId.admin01.role, "admin");
  assert.equal(byId.admin01.name, "임재성");
  assert.deepEqual(byId.gm01.managed_grades, [1]);
  assert.deepEqual(byId.gm01.managed_rooms, [roomUuid("roomA")], "missing rooms are dropped");
  assert.deepEqual(byId.kim01.managed_classes, [{ grade: 1, cls: "1학년 3반" }]);
  assert.deepEqual(byId.gone01, {
    login_id: "gone01",
    kind: "staff",
    role: null,
    name: "퇴직",
    disabled: true,
    managed_grades: [],
    managed_rooms: [],
    managed_classes: [],
  });
  assert.equal(byId.old01.role, "teacher", "missing role falls back to teacher like the old pages did");
  assert.equal(stats.skippedStaff, 2, "no id at all, and a non-staff email");
});
