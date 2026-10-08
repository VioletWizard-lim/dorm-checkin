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
  studentPassText,
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

const HONG: NoticeStudent = {
  id: "st1",
  name: "홍길동",
  sid: "10305",
  cls: "1학년 3반",
  phone: "01011112222",
  parent_phone: "01033334444",
};

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

// 가장 작은 JPEG 머리(FF D8 FF) + 데이터
const JPEG_BASE64 = btoa(String.fromCharCode(0xff, 0xd8, 0xff, 0xe0, 1, 2, 3));

function fakeDeps(options: {
  caller?: Profile;
  outing?: OutingRow | null;
  student?: NoticeStudent | null;
  sms?: "on" | "off";
  failKeys?: string[];
  failUpload?: boolean;
} = {}) {
  const calls = { claims: [] as Notice[], finished: [] as Notice[], sent: [] as SmsMessage[], uploads: [] as string[] };
  const sms: SmsSender = {
    async uploadMmsImage(b64) {
      calls.uploads.push(b64);
      if (options.failUpload) throw new Error("업로드 실패");
      return "IMG1";
    },
    async send(messages) {
      calls.sent.push(...messages);
      const results = new Map<string, SmsResult>();
      for (const m of messages) {
        results.set(m.key, options.failKeys?.includes(m.key) ? { ok: false, error: "수신 거부" } : { ok: true });
      }
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

Deno.test("sends the pass (MMS) to the student and a notice to the parent, and records both", async () => {
  const { deps, calls } = fakeDeps();
  const result = await handleNotifyOuting({ date: TODAY, studentId: "st1", image: JPEG_BASE64 }, deps);
  assertEquals(calls.uploads, [JPEG_BASE64]);
  assertEquals(calls.sent.map((m) => [m.key, m.to, m.imageId ?? null]), [
    ["student", "01011112222", "IMG1"],
    ["parent", "01033334444", null],
  ]);
  const expected: Notice = {
    status: "done",
    at: "2026-10-08T10:00:00.000Z",
    student: { result: "sent", mms: true },
    parent: { result: "sent" },
  };
  assertEquals(result, expected);
  assertEquals(calls.claims, [{ status: "sending", at: "2026-10-08T10:00:00.000Z" }]);
  assertEquals(calls.finished, [expected]);
});

Deno.test("sends only once per outing", async () => {
  const { deps, calls } = fakeDeps();
  await handleNotifyOuting({ date: TODAY, studentId: "st1" }, deps);
  assertEquals(await handleNotifyOuting({ date: TODAY, studentId: "st1" }, deps), { status: "skipped" });
  assertEquals(calls.sent.length, 2);
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

Deno.test("no image, a bad image or a failed upload falls back to a long text message", async () => {
  for (const image of [undefined, btoa("not a jpeg"), "%%%"]) {
    const { deps, calls } = fakeDeps();
    const result = (await handleNotifyOuting({ date: TODAY, studentId: "st1", image }, deps)) as { student: unknown };
    assertEquals(calls.uploads, []);
    assertEquals(calls.sent[0].imageId, undefined);
    assertEquals(result.student, { result: "sent", mms: false });
  }
  const { deps, calls } = fakeDeps({ failUpload: true });
  await handleNotifyOuting({ date: TODAY, studentId: "st1", image: JPEG_BASE64 }, deps);
  assertEquals(calls.sent[0].imageId, undefined);
});

Deno.test("missing phone numbers and failed sends are recorded per target", async () => {
  const { deps } = fakeDeps({ student: { ...HONG, phone: null }, failKeys: ["parent"] });
  const result = (await handleNotifyOuting({ date: TODAY, studentId: "st1" }, deps)) as Record<string, unknown>;
  assertEquals(result.student, { result: "no-phone" });
  assertEquals(result.parent, { result: "failed", error: "수신 거부" });
});

Deno.test("only active staff may call, and only for today's outings", async () => {
  await assertHttpError(handleNotifyOuting({ date: TODAY, studentId: "st1" }, fakeDeps({ caller: profile({ kind: "student", role: "student" }) }).deps), 403);
  await assertHttpError(handleNotifyOuting({ date: TODAY, studentId: "st1" }, fakeDeps({ caller: profile({ role: null }) }).deps), 403);
  await assertHttpError(handleNotifyOuting({ date: "2026-10-07", studentId: "st1" }, fakeDeps().deps), 400);
  await assertHttpError(handleNotifyOuting({ date: TODAY }, fakeDeps().deps), 400);
});

Deno.test("message texts use the requested start time, or the check time in KST", () => {
  assertEquals(
    studentPassText(HONG, OUTING),
    "[기숙사 외출증]\n홍길동 (1학년 3반 5번)\n10월 8일 19:00 ~ 21:00\n사유: 병원\n확인 교사: 김담임",
  );
  assertEquals(
    parentNoticeText(HONG, { ...OUTING, start_time: null, expected_return: null, reason: null }),
    "[기숙사 외출 안내]\n홍길동 학생이 10월 8일 17:40에 외출합니다.\n복귀 예정: 미정\n사유: 사유 미기재\n확인 교사: 김담임",
  );
  assertEquals(kstTime("2026-10-08T15:05:00Z"), "00:05");
});
