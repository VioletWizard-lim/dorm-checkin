export type ManagedClass = { grade: number; cls: string };

export type Profile = {
  id: string;
  login_id: string;
  kind: "staff" | "student";
  role: "teacher" | "gradeManager" | "admin" | "studyHallSupervisor" | "dormStaff" | "student" | null;
  name: string | null;
  disabled: boolean;
  managed_grades: number[];
  managed_rooms: string[];
  managed_classes: ManagedClass[];
  student_id: string | null;
};

// supabase-js의 AuthError에서 실제로 쓰는 부분만.
export type AuthLikeError = { message: string; code?: string; status?: number };
