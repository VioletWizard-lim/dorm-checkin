import { test, expect } from "./fixtures.mjs";
import { STUDENT } from "../harness/seed.mjs";
import { answerDialogs, todayKst, yesterdayKst } from "./helpers.mjs";

const card = (page, name) => page.locator(".student-card", { hasText: name });

async function outingRow(env, date, studentId) {
  const rows = await env.sql("select * from public.outings where date = $1 and student_id = $2", [date, studentId]);
  return rows[0] ?? null;
}

test.describe("외출 체크 화면", () => {
  test("학생 목록과 상태별 버튼", async ({ openAs, page }) => {
    await openAs("teacher01", "/check.html");
    const names = page.locator(".student-card .student-name");
    await expect(names).toHaveText(["김민준", "최하늘", "홍길동", "이서연", "박지훈"]); // 학번순
    await expect(page.locator("#outCountText")).toHaveText("외출중 0명");
    await expect(card(page, "홍길동").locator(".status-badge")).toHaveText("재실");
    await expect(card(page, "홍길동").getByRole("button", { name: "외출 체크" })).toBeVisible();
    await expect(card(page, "김민준").locator(".status-badge")).toHaveText("자리 없음");
    await expect(card(page, "김민준").getByRole("button", { name: "재실로 되돌리기" })).toBeVisible();
    await expect(card(page, "박지훈").locator(".status-badge")).toHaveText("명령퇴사");
    await expect(card(page, "박지훈")).toContainText("학생 명단 관리에서 설정");
    await expect(card(page, "박지훈").locator("button")).toHaveCount(0);
  });

  test("외출 체크 → 사유·복귀 시각 저장, 담당 교사 기록, 외출증 이메일 발송 → 복귀 체크", async ({ env, openAs, page }) => {
    answerDialogs(page, ["병원 진료", "18:00"]);
    await openAs("homeroom01", "/check.html");
    await card(page, "홍길동").getByRole("button", { name: "외출 체크" }).click();

    await expect(card(page, "홍길동").locator(".status-badge")).toHaveText("외출중");
    await expect(card(page, "홍길동")).toContainText("병원 진료 (~18:00)");
    await expect(page.locator("#outCountText")).toHaveText("외출중 1명");

    const row = await outingRow(env, todayKst(), STUDENT.hong);
    expect(row).toMatchObject({ status: "out", reason: "병원 진료", expected_return: "18:00", checked_by_name: "김담임" });

    const sends = await page.evaluate(() => window.__emailjsSends);
    expect(sends).toHaveLength(1);
    expect(sends[0].params).toMatchObject({
      to_email: "hong@example.com",
      student_name: "홍길동",
      sid: "10305",
      cls: "1학년 3반",
      seat_no: "5",
      reason: "병원 진료",
      return_time: "18:00",
      teacher_id: "김담임",
    });

    await card(page, "홍길동").getByRole("button", { name: "복귀 체크" }).click();
    await expect(card(page, "홍길동").locator(".status-badge")).toHaveText("재실");
    const back = await outingRow(env, todayKst(), STUDENT.hong);
    expect(back).toMatchObject({ status: "in", reason: null, expected_return: null });
    expect(await page.evaluate(() => window.__emailjsSends.length)).toBe(1);
  });

  test("사유 입력을 취소해도 외출 체크는 된다(이메일 없는 학생은 발송 안 함)", async ({ env, openAs, page }) => {
    answerDialogs(page, [null, null]);
    await openAs("teacher01", "/check.html");
    await card(page, "최하늘").getByRole("button", { name: "외출 체크" }).click();
    await expect(card(page, "최하늘").locator(".status-badge")).toHaveText("외출중");
    const row = await outingRow(env, todayKst(), STUDENT.haneul);
    expect(row).toMatchObject({ status: "out", reason: null, expected_return: null });
    expect(await page.evaluate(() => window.__emailjsSends.length)).toBe(0);
  });

  test("자리 없음 → 재실로 되돌리기", async ({ env, openAs, page }) => {
    await openAs("super01", "/check.html");
    await card(page, "김민준").getByRole("button", { name: "재실로 되돌리기" }).click();
    await expect(card(page, "김민준").locator(".status-badge")).toHaveText("재실");
    expect((await outingRow(env, todayKst(), STUDENT.minjun)).status).toBe("in");
  });

  test("실 필터와 이름 검색", async ({ openAs, page }) => {
    await openAs("teacher01", "/check.html");
    await expect(page.locator("#filterChips .filter-chip")).toHaveText(["전체", "1학년실", "2·3학년실"]);
    await page.click("#filterChips >> text=1학년실");
    await expect(page.locator(".student-card .student-name")).toHaveText(["김민준", "홍길동"]);
    await page.click("#filterChips >> text=2·3학년실");
    await expect(page.locator(".student-card .student-name")).toHaveText(["이서연", "박지훈"]);
    await page.click("#filterChips >> text=전체");
    await page.fill("#search", "하늘");
    await expect(page.locator(".student-card .student-name")).toHaveText(["최하늘"]);
  });

  test("지난 날짜 기록을 보고 고칠 수 있다(이메일은 보내지 않음)", async ({ env, openAs, page }) => {
    answerDialogs(page, ["외박", "21:00"]);
    await openAs("teacher01", "/check.html");
    await expect(page.locator("#dateSelect")).toHaveValue(todayKst());
    await expect(page.locator("#dateSelect")).toHaveAttribute("max", todayKst());

    await page.fill("#dateSelect", yesterdayKst());
    await expect(page.locator("#pastDateNotice")).toBeVisible();
    await expect(card(page, "홍길동").locator(".status-badge")).toHaveText("외출중");
    await expect(card(page, "홍길동")).toContainText("병원 (~17:00)");
    await expect(card(page, "김민준").locator(".status-badge")).toHaveText("재실");
    await expect(page.locator("#outCountText")).toHaveText("그 날 외출 기록 1명");

    await card(page, "홍길동").getByRole("button", { name: "복귀 체크" }).click();
    await expect(card(page, "홍길동").locator(".status-badge")).toHaveText("재실");
    expect((await outingRow(env, yesterdayKst(), STUDENT.hong)).status).toBe("in");

    await card(page, "최하늘").getByRole("button", { name: "외출 체크" }).click();
    await expect(card(page, "최하늘").locator(".status-badge")).toHaveText("외출중");
    expect(await outingRow(env, yesterdayKst(), STUDENT.haneul)).toMatchObject({ status: "out", reason: "외박" });
    expect(await outingRow(env, todayKst(), STUDENT.haneul)).toBeNull();
    expect(await page.evaluate(() => window.__emailjsSends.length)).toBe(0);

    await page.fill("#dateSelect", todayKst());
    await expect(page.locator("#pastDateNotice")).toBeHidden();
    await expect(card(page, "최하늘").locator(".status-badge")).toHaveText("재실");
    await expect(card(page, "김민준").locator(".status-badge")).toHaveText("자리 없음");
  });

  test("다른 교사가 바꾼 내용이 새로고침 없이 반영된다", async ({ env, openAs, openOtherAs, page }) => {
    await openAs("teacher01", "/check.html");
    await expect(card(page, "이서연").locator(".status-badge")).toHaveText("재실");

    const other = await openOtherAs("dorm01", "/check.html");
    answerDialogs(other, ["학원", ""]);
    await card(other, "이서연").getByRole("button", { name: "외출 체크" }).click();
    await expect(card(other, "이서연").locator(".status-badge")).toHaveText("외출중");

    await expect(card(page, "이서연").locator(".status-badge")).toHaveText("외출중");
    await expect(page.locator("#outCountText")).toHaveText("외출중 1명");

    // 학생 명단·실이 바뀌어도 반영
    await env.sql("update public.students set name = '이서윤' where id = $1", [STUDENT.seoyeon]);
    await expect(card(page, "이서윤")).toBeVisible();
    await env.sql("update public.rooms set name = '2·3학년 자습실' where name = '2·3학년실'");
    await expect(page.locator("#filterChips .filter-chip")).toHaveText(["전체", "1학년실", "2·3학년 자습실"]);
  });

  test("저장이 거부되면 알림을 띄우고 화면은 그대로 둔다", async ({ env, openAs, page }) => {
    const seen = answerDialogs(page, ["사유", "", true]);
    await openAs("teacher01", "/check.html");
    await expect(card(page, "홍길동").locator(".status-badge")).toHaveText("재실");
    // 화면을 연 뒤에 계정이 비활성화된 상황(서버 RLS가 쓰기를 거부)
    await env.sql("update public.profiles set disabled = true where login_id = 'teacher01'");
    await card(page, "홍길동").getByRole("button", { name: "외출 체크" }).click();
    await expect.poll(() => seen.filter((d) => d.type === "alert").map((d) => d.message)).toEqual([
      "저장하지 못했습니다: 권한이 없습니다.",
    ]);
    await expect(card(page, "홍길동").locator(".status-badge")).toHaveText("재실");
    expect(await outingRow(env, todayKst(), STUDENT.hong)).toBeNull();
  });
});
