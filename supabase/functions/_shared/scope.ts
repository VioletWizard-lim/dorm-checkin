// 학생 명단 관리·외출 신청 승인 범위. DB의 can_manage_student(supabase/migrations)와 같은 규칙이어야 한다.
//   관리자·기숙사부: 전체 / 학년부장: 담당 학년 / 담임(teacher): 담당 반
import type { Profile } from "./types.ts";

export type StudentScope = { grade: number; cls: string };

export function canManageStudent(caller: Profile, student: StudentScope): boolean {
  if (caller.kind !== "staff" || caller.disabled || !caller.role) return false;
  if (caller.role === "admin" || caller.role === "dormStaff") return true;
  if (caller.role === "gradeManager") return caller.managed_grades.includes(student.grade);
  if (caller.role === "teacher") {
    return caller.managed_classes.some((c) => c.grade === student.grade && c.cls === student.cls);
  }
  return false;
}
