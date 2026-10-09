import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { HttpError } from "../_shared/http.ts";
import type { SmsMessage, SmsResult, SmsSender } from "../_shared/solapi.ts";
import type { Profile } from "../_shared/types.ts";
import {
  handleNotifyOuting,
  kstTime,
  type Notice,
  type NoticeStudent,
  type NotifyOutingDeps,
  type OutingRow,
  parentNoticeText,
} from "./handler.ts";

const TODAY = "2026-10-08";

function profile(overrides: Partial<Profile> = {}): Profile {
  return {
    id: "u-t",
    login_id: "kim01",
    kind: "staff",
    role: "teacher",
    name: "김담임",
    disabled: false,
    managed_grades: [],
    managed_rooms: [],
    managed_classes: [],
    student_id: null,
    ...overrides,
  };
}

const HONG: NoticeStudent = { id: "st1", name: "홍길동", parent_phone: "01033334444" };

const OUTING: OutingRow = {
  date: TODAY,
  student_id: "st1",
  status: "out",
  since: "2026-10-08T08:40:00Z", // KST 17:40
  reason: "병원",
  start_time: "19:00",
  expected_return: "21:00",
  checked_by_name: "김담임",
};

function fakeDeps(options: {
  caller?: Profile;
  outing?: OutingRow | null;
  student?: NoticeStudent | null;
  sms?: "on" | "off";
  fail?: boolean;
} = {}) {
  const calls = { claims: [] as Notice[], finished: [] as Notice[], sent: [] as SmsMessage[] };
  const sms: SmsSender = {
    async send(messages) {
      calls.sent.push(...messages);
      const results = new Map<string, SmsResult>();
      for (const m of messages) results.set(m.key, options.fail ? { ok: false, error: "수신 거부" } : { ok: true });
      return results;
    },
  };
  let claimed = false;
  const deps: NotifyOutingDeps = {
    caller: options.caller ?? profile(),
    todayKst: () => TODAY,
    now: () => new Date("2026-10-08T10:00:00Z"),
    outings: {
      async claim(_date, _id, notice) {
        calls.claims.push(notice);
        const outing = options.outing === undefined ? OUTING : options.outing;
        if (!outing || claimed) return null;
        claimed = true;
        return outing;
      },
      async finish(_date, _id, notice) {
        calls.finished.push(notice);
      },
    },
    students: { get: async () => (options.student === undefined ? HONG : options.student) },
    sms: options.sms === "off" ? null : sms,
  };
  return { deps, calls };
}

async function assertHttpError(promise: Promise<unknown>, status: number) {
  const err = await assertRejects(() => promise, HttpError);
  assertEquals(err.status, status);
}

Deno.test("sends the outing notice to the parent only (the pass is shown on the student page) and records it", async () => {
  const { deps, calls } = fakeDeps();
  const result = await handleNotifyOuting({ date: TODAY, studentId: "st1" }, deps);
  assertEquals(calls.sent.map((m) => [m.key, m.to, m.subject]), [["parent", "01033334444", "외출 안내"]]);
  const expected: Notice = { status: "done", at: "2026-10-08T10:00:00.000Z", parent: { result: "sent" } };
  assertEquals(result, expected);
  assertEquals(calls.claims, [{ status: "sending", at: "2026-10-08T10:00:00.000Z" }]);
  assertEquals(calls.finished, [expected]);
});

Deno.test("sends only once per outing", async () => {
  const { deps, calls } = fakeDeps();
  await handleNotifyOuting({ date: TODAY, studentId: "st1" }, deps);
  assertEquals(await handleNotifyOuting({ date: TODAY, studentId: "st1" }, deps), { status: "skipped" });
  assertEquals(calls.sent.length, 1);
});

Deno.test("skips when the student is not out (or already notified)", async () => {
  const { deps, calls } = fakeDeps({ outing: null });
  assertEquals(await handleNotifyOuting({ date: TODAY, studentId: "st1" }, deps), { status: "skipped" });
  assertEquals(calls.sent, []);
});

Deno.test("without Solapi keys it records not-configured and sends nothing", async () => {
  const { deps, calls } = fakeDeps({ sms: "off" });
  assertEquals(await handleNotifyOuting({ date: TODAY, studentId: "st1" }, deps), { status: "not-configured" });
  assertEquals(calls.claims, [{ status: "not-configured", at: "2026-10-08T10:00:00.000Z" }]);
  assertEquals(calls.sent, []);
});

Deno.test("a missing parent number or a failed send is recorded", async () => {
  const noPhone = fakeDeps({ student: { ...HONG, parent_phone: null } });
  assertEquals(await handleNotifyOuting({ date: TODAY, studentId: "st1" }, noPhone.deps), {
    status: "done",
    at: "2026-10-08T10:00:00.000Z",
    parent: { result: "no-phone" },
  });
  assertEquals(noPhone.calls.sent, []);

  const failed = fakeDeps({ fail: true });
  const result = (await handleNotifyOuting({ date: TODAY, studentId: "st1" }, failed.deps)) as Record<string, unknown>;
  assertEquals(result.parent, { result: "failed", error: "수신 거부" });
});

Deno.test("only active staff may call, and only for today's outings", async () => {
  await assertHttpError(handleNotifyOuting({ date: TODAY, studentId: "st1" }, fakeDeps({ caller: profile({ kind: "student", role: "student" }) }).deps), 403);
  await assertHttpError(handleNotifyOuting({ date: TODAY, studentId: "st1" }, fakeDeps({ caller: profile({ role: null }) }).deps), 403);
  await assertHttpError(handleNotifyOuting({ date: TODAY, studentId: "st1" }, fakeDeps({ caller: profile({ role: "dormStaff" }) }).deps), 403);
  await assertHttpError(handleNotifyOuting({ date: TODAY, studentId: "st1" }, fakeDeps({ caller: profile({ role: "afterschoolTeacher" }) }).deps), 403);
  await assertHttpError(handleNotifyOuting({ date: "2026-10-07", studentId: "st1" }, fakeDeps().deps), 400);
  await assertHttpError(handleNotifyOuting({ date: TODAY }, fakeDeps().deps), 400);
});

Deno.test("the parent text uses the requested start time, or the check time in KST", () => {
  assertEquals(
    parentNoticeText(HONG, OUTING),
    "[기숙사 외출 안내]\n홍길동 학생이 10월 8일 19:00에 외출합니다.\n복귀 예정: 21:00\n사유: 병원\n확인 교사: 김담임",
  );
  assertEquals(
    parentNoticeText(HONG, { ...OUTING, start_time: null, expected_return: null, reason: null }),
    "[기숙사 외출 안내]\n홍길동 학생이 10월 8일 17:40에 외출합니다.\n복귀 예정: 미정\n사유: 사유 미기재\n확인 교사: 김담임",
  );
  assertEquals(kstTime("2026-10-08T15:05:00Z"), "00:05");
});
