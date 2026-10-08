// 학생 명단 관리·외출 신청 승인 범위. DB의 can_manage_student(supabase/migrations)와 같은 규칙이어야 한다.
//   관리자: 전체 / 학년부장: 담당 학년 / 담임(teacher): 담당 반
//   기숙사부는 명령퇴사 기간만 바꿀 수 있어서(DB 트리거) 명단·계정·승인 범위에는 들어가지 않는다.
import type { Profile } from "./types.ts";

export type StudentScope = { grade: number; cls: string };

export function canManageStudent(caller: Profile, student: StudentScope): boolean {
  if (caller.kind !== "staff" || caller.disabled || !caller.role) return false;
  if (caller.role === "admin") return true;
  if (caller.role === "gradeManager") return caller.managed_grades.includes(student.grade);
  if (caller.role === "teacher") {
    return caller.managed_classes.some((c) => c.grade === student.grade && c.cls === student.cls);
  }
  return false;
}
