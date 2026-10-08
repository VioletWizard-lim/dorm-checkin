// 외출이 시작되면(교사의 "외출 체크" 또는 학생 신청 승인) 문자를 보낸다 — 교직원만 호출 가능.
//   학생: 외출증(화면에서 만든 JPEG가 있으면 MMS, 없거나 올리지 못하면 장문 문자)
//   학부모: 외출 안내 문자
// 결과는 outings.notice에 기록한다(화면이 실시간으로 "문자 발송됨/실패"를 보여 줌).
// 같은 외출에는 한 번만 보낸다: notice가 비어 있는 'out' 기록만 먼저 차지(claim)하고 보낸다.
// 외부 호출(테이블, 솔라피)은 deps로 받아서 테스트에서 가짜로 바꿀 수 있게 한다.

import { HttpError } from "../_shared/http.ts";
import type { SmsMessage, SmsSender } from "../_shared/solapi.ts";
import type { Profile } from "../_shared/types.ts";

const MAX_IMAGE_BYTES = 200 * 1024; // 솔라피 MMS 이미지 한도

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

export type NoticeStudent = { id: string; name: string; sid: string; cls: string; phone: string | null; parent_phone: string | null };

export type TargetResult = { result: "sent" | "failed" | "no-phone"; error?: string; mms?: boolean };

export type DoneNotice = { status: "done"; at: string; student: TargetResult; parent: TargetResult };
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
  const notice: DoneNotice = {
    status: "done",
    at,
    student: { result: "no-phone" },
    parent: { result: "no-phone" },
  };
  if (!student) {
    notice.student = notice.parent = { result: "failed", error: "학생을 찾을 수 없습니다." };
    await deps.outings.finish(date, studentId, notice);
    return notice;
  }

  const messages: SmsMessage[] = [];
  if (student.phone) {
    const imageId = await uploadPassImage(body.image, deps.sms);
    messages.push({
      key: "student",
      to: student.phone,
      subject: "외출증",
      text: studentPassText(student, outing),
      ...(imageId ? { imageId } : {}),
    });
  }
  if (student.parent_phone) {
    messages.push({ key: "parent", to: student.parent_phone, subject: "외출 안내", text: parentNoticeText(student, outing) });
  }

  const results = await deps.sms.send(messages);
  for (const m of messages) {
    const r = results.get(m.key);
    const target: TargetResult = r?.ok
      ? { result: "sent" }
      : { result: "failed", error: (r && !r.ok && r.error) || "발송 실패" };
    if (m.key === "student") notice.student = { ...target, mms: Boolean(m.imageId) };
    else notice.parent = target;
  }
  await deps.outings.finish(date, studentId, notice);
  return notice;
}

// 화면이 보낸 외출증 이미지를 확인하고 올린다. 없거나 올리지 못하면 null(장문 문자로 대신 보냄).
async function uploadPassImage(raw: unknown, sms: SmsSender): Promise<string | null> {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 4) return null;
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(atob(raw), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
  // JPEG(FF D8 FF)만 받는다
  if (bytes.length > MAX_IMAGE_BYTES || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) return null;
  try {
    return await sms.uploadMmsImage(raw);
  } catch (err) {
    console.warn("외출증 이미지 업로드 실패, 장문으로 보냄:", err instanceof Error ? err.message : err);
    return null;
  }
}

// ─── 문자 내용 ───

// timestamptz → 한국 시각 "HH:MM"
export function kstTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Seoul", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d);
}

// 학번 마지막 2자리 = 번호 (예: "10305" → "5")
function seatNumber(sid: string): string {
  const m = /^\d{3}(\d{2})$/.exec((sid || "").trim());
  return m ? String(Number(m[1])) : "";
}

function dateLabel(date: string): string {
  const [, m, d] = date.split("-").map(Number);
  return `${m}월 ${d}일`;
}

function timesOf(outing: OutingRow): { start: string; back: string } {
  return { start: outing.start_time || kstTime(outing.since), back: outing.expected_return || "미정" };
}

export function studentPassText(student: NoticeStudent, outing: OutingRow): string {
  const { start, back } = timesOf(outing);
  const no = seatNumber(student.sid);
  return [
    "[기숙사 외출증]",
    `${student.name} (${student.cls}${no ? ` ${no}번` : ""})`,
    `${dateLabel(outing.date)} ${start} ~ ${back}`,
    `사유: ${outing.reason || "사유 미기재"}`,
    `확인 교사: ${outing.checked_by_name || "-"}`,
  ].join("\n");
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
