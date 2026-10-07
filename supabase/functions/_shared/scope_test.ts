import { assertEquals } from "jsr:@std/assert@1";
import { canManageStudent } from "./scope.ts";
import type { Profile } from "./types.ts";

const base: Profile = {
  id: "u1",
  login_id: "t1",
  kind: "staff",
  role: "teacher",
  name: null,
  disabled: false,
  managed_grades: [],
  managed_rooms: [],
  managed_classes: [],
  student_id: null,
};
const student = { grade: 1, cls: "1학년 3반" };

Deno.test("admin and dorm staff manage everyone", () => {
  assertEquals(canManageStudent({ ...base, role: "admin" }, student), true);
  assertEquals(canManageStudent({ ...base, role: "dormStaff" }, student), true);
});

Deno.test("grade managers manage their grades only", () => {
  assertEquals(canManageStudent({ ...base, role: "gradeManager", managed_grades: [1] }, student), true);
  assertEquals(canManageStudent({ ...base, role: "gradeManager", managed_grades: [2] }, student), false);
});

Deno.test("homeroom teachers manage their classes only (grade must match as a number)", () => {
  const teacher = { ...base, managed_classes: [{ grade: 1, cls: "1학년 3반" }] };
  assertEquals(canManageStudent(teacher, student), true);
  assertEquals(canManageStudent(teacher, { grade: 1, cls: "1학년 1반" }), false);
  assertEquals(canManageStudent(teacher, { grade: 2, cls: "1학년 3반" }), false);
  assertEquals(canManageStudent(base, student), false);
});

Deno.test("supervisors, students, disabled or role-less accounts manage nobody", () => {
  assertEquals(canManageStudent({ ...base, role: "studyHallSupervisor" }, student), false);
  assertEquals(canManageStudent({ ...base, kind: "student", role: "student" }, student), false);
  assertEquals(canManageStudent({ ...base, role: "admin", disabled: true }, student), false);
  assertEquals(canManageStudent({ ...base, role: null }, student), false);
});
