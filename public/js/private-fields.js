// 열 권한으로 막아 둔 칸(사유·연락처)을 허용된 사람만 RPC로 읽어 행에 붙인다(사용자 요청, 개인정보 점검).
// liveTable의 augment로 쓴다: 실패하면 error를 돌려줘서 조회 실패처럼 다시 시도한다.
// 허용되지 않은 사람에게는 서버가 빈 목록을 주므로 칸이 비어 있는 채로 그대로 그린다.
//   - 외출·신청 사유: 관리자·학년부장·담임·자습 감독, 학생은 자기 것(마이그레이션 20261010020000_reason_scope)
//   - 명령퇴사 사유: 관리자·학년부장·담임·기숙사부, 학생은 자기 것
//   - 아이디·연락처·이메일: 담당 범위(can_manage_student)(마이그레이션 20261010010000_student_contacts_scope)
import { supabase } from "./supabase-client.js";

async function merge(rows, rpc, args, key, fields) {
  const { data, error } = await supabase.rpc(rpc, args);
  if (error) return error;
  const byKey = new Map(data.map((d) => [d[key], d]));
  for (const row of rows) {
    const d = byKey.get(row[key]);
    if (d) for (const [from, to] of fields) row[to] = d[from];
  }
  return null;
}

export const addOutingReasons = (dateKey) => (rows) =>
  merge(rows, "outing_reasons", { p_date: dateKey }, "student_id", [["reason", "reason"]]);

export const addRequestReasons = (dateKey) => (rows) =>
  merge(rows, "outing_request_reasons", { p_date: dateKey }, "id", [["reason", "reason"]]);

export const addLeaveReasons = (rows) => merge(rows, "leave_reasons", {}, "id", [["leave_reason", "leave_reason"]]);

export const addContacts = (rows) =>
  merge(rows, "student_contacts", {}, "id", [
    ["login_id", "login_id"],
    ["phone", "phone"],
    ["parent_phone", "parent_phone"],
    ["email", "email"],
  ]);

// 여러 augment를 차례로(앞의 것이 실패하면 멈춤)
export const allOf = (...fns) => async (rows) => {
  for (const fn of fns) {
    const error = await fn(rows);
    if (error) return error;
  }
  return null;
};
