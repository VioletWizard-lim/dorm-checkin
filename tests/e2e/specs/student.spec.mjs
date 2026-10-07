import { test, expect } from "./fixtures.mjs";
import { STUDENT } from "../harness/seed.mjs";
import { answerDialogs, todayKst } from "./helpers.mjs";

async function requestsOf(env, studentId) {
  return env.sql(
    "select *, date::text as date from public.outing_requests where student_id = $1 order by created_at",
    [studentId]
  );
}

async function outingOf(env, studentId) {
  return (await env.sql("select * from public.outings where date = $1 and student_id = $2", [todayKst(), studentId]))[0] ?? null;
}

const requestRow = (page, name) => page.locator("#requestPanel .request-row", { hasText: name });

test.describe("학생 화면", () => {
  test("내 정보·오늘 상태를 보고, 신청 → 대기 중에는 다시 신청 불가 → 취소하면 다시 신청 가능", async ({ env, openAs, page }) => {
    await env.createStudentAccount(STUDENT.hong, "hong123");
    answerDialogs(page, [true]);
    await openAs("hong123", "/student.html");
    await expect(page.locator("#studentName")).toHaveText("홍길동");
    await expect(page.locator("#studentMeta")).toHaveText("학번 10305 · 1학년 3반");
    await expect(page.locator("#statusBox .status-badge")).toHaveText("재실");
    await expect(page.locator("#requestList")).toContainText("오늘 신청한 외출이 없습니다.");

    // 시·분은 끝에서 멈추는 목록(0~23시, 00~59분). 외출 시각 기본값은 지금, 복귀는 비어 있음
    await expect(page.locator("#startHour option")).toHaveCount(24);
    await expect(page.locator("#startMinute option")).toHaveCount(60);
    await expect(page.locator("#startMinute option").first()).toHaveText("00분");
    await expect(page.locator("#startMinute option").last()).toHaveText("59분");
    await expect(page.locator("#startHour")).toHaveValue(/^([01]\d|2[0-3])$/);
    await expect(page.locator("#returnHour")).toHaveValue("");

    await page.fill("#reasonInput", "병원 진료");
    await page.selectOption("#startHour", "15");
    await page.selectOption("#startMinute", "05");
    await page.selectOption("#returnHour", "17");
    await expect(page.locator("#returnMinute")).toHaveValue("00"); // 시만 고르면 분은 00
    await page.selectOption("#returnMinute", "30");
    await page.click("#requestBtn");
    await expect(page.locator("#requestList .request-chip")).toHaveText(["승인 대기"]);
    await expect(page.locator("#requestList")).toContainText("병원 진료");
    await expect(page.locator("#requestList")).toContainText("외출 15:05 · 예상 복귀 17:30");
    await expect(page.locator("#requestBtn")).toBeDisabled();
    await expect(page.locator("#requestHint")).toContainText("승인을 기다리는 신청이 있습니다");
    expect(await requestsOf(env, STUDENT.hong)).toMatchObject([
      { status: "pending", reason: "병원 진료", start_time: "15:05", expected_return: "17:30", date: todayKst() },
    ]);

    await page.getByRole("button", { name: "신청 취소" }).click();
    await expect(page.locator("#requestList .request-chip")).toHaveText(["취소함"]);
    await expect(page.locator("#requestBtn")).toBeEnabled();
    expect((await requestsOf(env, STUDENT.hong))[0].status).toBe("cancelled");
  });

  test("사유 없이는 신청할 수 없고, 명령퇴사 중이면 신청 칸이 잠긴다", async ({ env, openAs, page, openOtherAs }) => {
    await env.createStudentAccount(STUDENT.hong, "hong123");
    const alerts = [];
    page.on("dialog", (d) => {
      alerts.push(d.message());
      d.accept();
    });
    await openAs("hong123", "/student.html");
    await expect(page.locator("#requestBtn")).toBeEnabled();
    await page.click("#requestBtn");
    await expect.poll(() => alerts).toEqual(["외출 사유를 입력해 주세요."]);

    await page.fill("#reasonInput", "편의점");
    await page.selectOption("#startHour", "18");
    await page.selectOption("#startMinute", "00");
    await page.selectOption("#returnHour", "17");
    await page.click("#requestBtn");
    await expect.poll(() => alerts.at(-1)).toBe("예상 복귀 시각은 외출 시각보다 늦어야 합니다.");
    expect(await requestsOf(env, STUDENT.hong)).toEqual([]);

    await env.createStudentAccount(STUDENT.jihun, "jihun_p");
    const leavePage = await openOtherAs("jihun_p", "/student.html");
    await expect(leavePage.locator("#statusBox .status-badge")).toHaveText("명령퇴사");
    await expect(leavePage.locator("#requestBtn")).toBeDisabled();
    await expect(leavePage.locator("#requestHint")).toHaveText("명령퇴사 기간에는 외출을 신청할 수 없습니다.");
  });

  test("학생은 다른 학생 정보를 읽을 수 없고, 교사 화면에 들어가면 학생 화면으로 돌아온다", async ({ env, openAs, page }) => {
    await env.createStudentAccount(STUDENT.hong, "hong123");
    await openAs("hong123", "/check.html");
    await expect(page).toHaveURL(/student\.html$/);
    await expect(page.locator("#studentName")).toHaveText("홍길동");
    const visible = await page.evaluate(async () => {
      const { supabase } = await import("/js/supabase-client.js");
      const students = await supabase.from("students").select("name");
      const outings = await supabase.from("outings").select("student_id");
      const rooms = await supabase.from("rooms").select("id");
      const profiles = await supabase.from("profiles").select("login_id");
      return {
        students: students.data.map((s) => s.name),
        outingOwners: [...new Set(outings.data.map((o) => o.student_id))],
        rooms: rooms.data.length,
        profiles: profiles.data.map((p) => p.login_id),
      };
    });
    // 자기 행만 보인다(외출 기록은 시드의 어제 기록 1건이 본인 것)
    expect(visible).toEqual({ students: ["홍길동"], outingOwners: [STUDENT.hong], rooms: 0, profiles: ["hong123"] });
  });

  test("교직원이 학생 화면을 열면 체크 화면으로 간다", async ({ openAs, page }) => {
    await openAs("teacher01", "/student.html");
    await expect(page).toHaveURL(/check\.html$/);
  });
});

test.describe("외출 신청 승인", () => {
  test("담임이 승인하면 바로 외출중이 되고 학생 화면에 실시간으로 보인다(외출증 이메일 발송)", async ({ env, openAs, openOtherAs, page }) => {
    await env.createStudentAccount(STUDENT.hong, "hong123");
    const studentPage = await openOtherAs("hong123", "/student.html");
    await studentPage.fill("#reasonInput", "치과");
    await studentPage.selectOption("#startHour", "19");
    await studentPage.selectOption("#startMinute", "00");
    await studentPage.selectOption("#returnHour", "21");
    await studentPage.click("#requestBtn");
    await expect(studentPage.locator("#requestList .request-chip")).toHaveText(["승인 대기"]);

    await openAs("homeroom01", "/check.html");
    await expect(page.locator("#requestPanel")).toBeVisible();
    await expect(page.locator("#requestCount")).toHaveText("1건");
    await expect(requestRow(page, "홍길동")).toContainText("치과 (19:00~21:00)");
    await expect(page.locator(".student-card", { hasText: "홍길동" }).locator(".pending-chip")).toHaveText("외출 신청 대기");

    await requestRow(page, "홍길동").getByRole("button", { name: "승인" }).click();
    await expect(page.locator("#requestPanel")).toBeHidden();
    await expect(page.locator(".student-card", { hasText: "홍길동" }).locator(".status-badge")).toHaveText("외출중");
    await expect(page.locator(".student-card", { hasText: "홍길동" })).toContainText("19:00 외출중 · 치과 (~21:00)");

    const [request] = await requestsOf(env, STUDENT.hong);
    expect(request).toMatchObject({ status: "approved", decided_by_name: "김담임" });
    expect(await outingOf(env, STUDENT.hong)).toMatchObject({
      status: "out",
      reason: "치과",
      start_time: "19:00",
      expected_return: "21:00",
      request_id: request.id,
      checked_by_name: "김담임",
    });
    const sends = await page.evaluate(() => window.__emailjsSends);
    expect(sends.map((s) => s.params)).toMatchObject([{ student_name: "홍길동", reason: "치과", out_time: "19:00", return_time: "21:00", teacher_id: "김담임" }]);

    await expect(studentPage.locator("#requestList .request-chip")).toHaveText(["승인됨"]);
    await expect(studentPage.locator("#requestList")).toContainText("김담임 선생님 승인");
    await expect(studentPage.locator("#statusBox .status-badge")).toHaveText("외출중");
    await expect(studentPage.locator("#statusBox")).toContainText("19:00부터 외출 중");
    await expect(studentPage.locator("#requestHint")).toContainText("이미 외출 중입니다");
  });

  test("반려하면 사유가 학생에게 보이고 다시 신청할 수 있다", async ({ env, openAs, openOtherAs, page }) => {
    await env.createStudentAccount(STUDENT.hong, "hong123");
    const studentPage = await openOtherAs("hong123", "/student.html");
    await studentPage.fill("#reasonInput", "편의점");
    await studentPage.click("#requestBtn");
    await expect(studentPage.locator("#requestList .request-chip")).toHaveText(["승인 대기"]);

    answerDialogs(page, ["자습 시간입니다"]);
    await openAs("gm01", "/check.html");
    await requestRow(page, "홍길동").getByRole("button", { name: "반려" }).click();
    await expect(page.locator("#requestPanel")).toBeHidden();
    expect((await requestsOf(env, STUDENT.hong))[0]).toMatchObject({ status: "rejected", reject_reason: "자습 시간입니다" });
    expect(await outingOf(env, STUDENT.hong)).toBeNull();

    await expect(studentPage.locator("#requestList .request-chip")).toHaveText(["반려됨"]);
    await expect(studentPage.locator("#requestList")).toContainText("사유: 자습 시간입니다");
    await expect(studentPage.locator("#requestBtn")).toBeEnabled();
  });

  test("승인 범위 밖의 교사에게는 신청이 보이지 않고, 서버도 승인을 거부한다", async ({ env, openAs, openOtherAs, page }) => {
    await env.createStudentAccount(STUDENT.seoyeon, "seoyeon.lee");
    const studentPage = await openOtherAs("seoyeon.lee", "/student.html");
    await studentPage.fill("#reasonInput", "학원");
    await studentPage.click("#requestBtn");
    await expect(studentPage.locator("#requestList .request-chip")).toHaveText(["승인 대기"]);
    const [request] = await requestsOf(env, STUDENT.seoyeon);

    // 1학년 3반 담임: 2학년 학생의 신청은 안 보임, 직접 승인 시도도 거부
    await openAs("homeroom01", "/check.html");
    await expect(page.locator(".student-card", { hasText: "이서연" }).locator(".pending-chip")).toBeVisible();
    await expect(page.locator("#requestPanel")).toBeHidden();
    const error = await page.evaluate(async (id) => {
      const { supabase } = await import("/js/supabase-client.js");
      const { error } = await supabase.rpc("approve_outing_request", { p_request_id: id });
      return error && error.message;
    }, request.id);
    expect(error).toBe("이 학생의 신청을 처리할 권한이 없습니다.");

    // 자습 감독도 안 보임, 기숙사부는 보임
    const supervisor = await openOtherAs("super01", "/check.html");
    await expect(supervisor.locator(".student-card").first()).toBeVisible();
    await expect(supervisor.locator("#requestPanel")).toBeHidden();
    const dorm = await openOtherAs("dorm01", "/check.html");
    await expect(requestRow(dorm, "이서연")).toContainText("학원");
  });
});
