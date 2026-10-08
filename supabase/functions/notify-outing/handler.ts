// 외출이 시작되면(교사의 "외출 체크" 또는 학생 신청 승인) 학부모에게 외출 안내 문자를 보낸다 — 교직원만 호출 가능.
// 학생 외출증은 문자(MMS) 대신 학생 화면(student.html)에 띄운다(문자 비용을 줄이려고).
// 결과는 outings.notice에 기록한다(화면이 실시간으로 "문자 발송됨/실패"를 보여 줌).
// 같은 외출에는 한 번만 보낸다: notice가 비어 있는 'out' 기록만 먼저 차지(claim)하고 보낸다.
// 외부 호출(테이블, 솔라피)은 deps로 받아서 테스트에서 가짜로 바꿀 수 있게 한다.

import { HttpError } from "../_shared/http.ts";
import type { SmsSender } from "../_shared/solapi.ts";
import type { Profile } from "../_shared/types.ts";

export type OutingRow = {
  date: string;
  student_id: string;
  status: string;
  since: string;
  reason: string | null;
  start_time: string | null;
  expected_return: string | null;
  checked_by_name: string | null;
};

export type NoticeStudent = { id: string; name: string; parent_phone: string | null };

export type TargetResult = { result: "sent" | "failed" | "no-phone"; error?: string };

export type DoneNotice = { status: "done"; at: string; parent: TargetResult };
export type Notice = { status: "sending"; at: string } | { status: "not-configured"; at: string } | DoneNotice;

export type NotifyOutingDeps = {
  caller: Profile;
  todayKst(): string;
  now(): Date;
  outings: {
    // notice가 비어 있는 오늘의 'out' 기록에 notice를 써서 차지한다. 이미 보냈거나 외출이 아니면 null
    claim(date: string, studentId: string, notice: Notice): Promise<OutingRow | null>;
    finish(date: string, studentId: string, notice: Notice): Promise<void>;
  };
  students: { get(id: string): Promise<NoticeStudent | null> };
  sms: SmsSender | null;
};

export async function handleNotifyOuting(body: Record<string, unknown>, deps: NotifyOutingDeps): Promise<unknown> {
  const { caller } = deps;
  if (caller.kind !== "staff" || caller.disabled || !caller.role) {
    throw new HttpError(403, "교직원만 사용할 수 있습니다.");
  }
  const date = typeof body.date === "string" ? body.date : "";
  const studentId = typeof body.studentId === "string" ? body.studentId : "";
  if (!studentId) throw new HttpError(400, "대상 학생이 지정되지 않았습니다.");
  if (date !== deps.todayKst()) throw new HttpError(400, "오늘 외출만 문자를 보낼 수 있습니다.");

  const at = deps.now().toISOString();
  const outing = await deps.outings.claim(date, studentId, { status: deps.sms ? "sending" : "not-configured", at });
  if (!outing) return { status: "skipped" };
  if (!deps.sms) return { status: "not-configured" };

  const student = await deps.students.get(studentId);
  const notice: DoneNotice = { status: "done", at, parent: { result: "no-phone" } };
  if (!student) {
    notice.parent = { result: "failed", error: "학생을 찾을 수 없습니다." };
  } else if (student.parent_phone) {
    const results = await deps.sms.send([
      { key: "parent", to: student.parent_phone, subject: "외출 안내", text: parentNoticeText(student, outing) },
    ]);
    const r = results.get("parent");
    notice.parent = r?.ok ? { result: "sent" } : { result: "failed", error: (r && !r.ok && r.error) || "발송 실패" };
  }
  await deps.outings.finish(date, studentId, notice);
  return notice;
}

// ─── 문자 내용 ───

// timestamptz → 한국 시각 "HH:MM"
export function kstTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Seoul", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d);
}

function dateLabel(date: string): string {
  const [, m, d] = date.split("-").map(Number);
  return `${m}월 ${d}일`;
}

function timesOf(outing: OutingRow): { start: string; back: string } {
  return { start: outing.start_time || kstTime(outing.since), back: outing.expected_return || "미정" };
}

export function parentNoticeText(student: NoticeStudent, outing: OutingRow): string {
  const { start, back } = timesOf(outing);
  return [
    "[기숙사 외출 안내]",
    `${student.name} 학생이 ${dateLabel(outing.date)} ${start}에 외출합니다.`,
    `복귀 예정: ${back}`,
    `사유: ${outing.reason || "사유 미기재"}`,
    `확인 교사: ${outing.checked_by_name || "-"}`,
  ].join("\n");
}
