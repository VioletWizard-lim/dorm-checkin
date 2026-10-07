// Supabase 프로젝트 주소와 공개용(publishable) 키.
// 비밀키가 아니라 브라우저에 그대로 전달되는 값이라 커밋해도 안전하다.
// 실제 접근 제어는 Supabase Auth + RLS 정책(supabase/migrations)이 담당한다.
export const SUPABASE_URL = "https://jlgbpniutisnppunkhpc.supabase.co";
export const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_SVaLD8KJkhm70yeTi16gow_QYYqvmue";

// 아이디 로그인을 이메일 형식으로 바꿀 때 쓰는 가짜 도메인(화면에는 보이지 않음).
// supabase/functions/_shared/accounts.ts의 STAFF_EMAIL_DOMAIN·STUDENT_EMAIL_DOMAIN과 같은 값이어야 한다.
export const STAFF_EMAIL_DOMAIN = "donghall.local";
export const STUDENT_EMAIL_DOMAIN = "student.donghall.local";
