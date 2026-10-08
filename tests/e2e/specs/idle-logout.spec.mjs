import { test, expect } from "./fixtures.mjs";
import { STUDENT } from "../harness/seed.mjs";

// 교직원 화면: 2시간 동안 조작이 없으면 자동 로그아웃(현황판 포함, 학생 화면은 제외)
const IDLE_NOTICE = "2시간 동안 사용하지 않아 자동으로 로그아웃되었습니다. 다시 로그인해 주세요.";

test.describe("자동 로그아웃(2시간 동안 조작 없음)", () => {
  test("교사 화면은 2시간 동안 아무것도 안 하면 로그인 화면으로", async ({ context, openAs, page }) => {
    await context.clock.install();
    await openAs("teacher01", "/check.html");
    await expect(page.locator(".student-card").first()).toBeVisible();

    await page.clock.fastForward("01:59:00");
    await expect(page).toHaveURL(/check\.html/);
    await page.clock.fastForward("01:30");
    await expect(page).toHaveURL(/login\.html\?idle=1/);
    await expect(page.locator("#noticeBox")).toHaveText(IDLE_NOTICE);
    // 이 기기의 로그인도 끝남(다시 들어가면 로그인 화면)
    await page.goto("/check.html");
    await expect(page).toHaveURL(/login\.html/);
  });

  test("중간에 조작하면 다시 2시간을 센다", async ({ context, openAs, page }) => {
    await context.clock.install();
    await openAs("teacher01", "/display.html");
    await expect(page.locator("#outPanelCount")).toBeVisible();

    await page.clock.fastForward("01:30:00");
    await page.mouse.move(200, 200);
    await page.mouse.move(300, 300);
    await page.clock.fastForward("01:30:00"); // 마지막 조작 후 1시간 30분
    await expect(page).toHaveURL(/display\.html/);

    await page.clock.fastForward("00:31:00"); // 마지막 조작 후 2시간 넘음
    await expect(page).toHaveURL(/login\.html\?idle=1/);
  });

  test("창을 닫았다가 2시간 뒤에 다시 열어도 로그아웃", async ({ openAs, page }) => {
    await openAs("teacher01", "/seat.html");
    await expect(page.locator("#roomTabs .filter-chip").first()).toBeVisible();
    await page.evaluate(() => localStorage.setItem("dormcheckin.lastActivityAt", String(Date.now() - 3 * 60 * 60 * 1000)));
    await page.goto("/seat.html");
    await expect(page).toHaveURL(/login\.html\?idle=1/);
  });

  test("다시 로그인하면 예전 기록 때문에 바로 로그아웃되지 않는다", async ({ page }) => {
    await page.goto("/login.html");
    await page.evaluate(() => localStorage.setItem("dormcheckin.lastActivityAt", String(Date.now() - 3 * 60 * 60 * 1000)));
    await page.fill("#userId", "teacher01");
    await page.fill("#password", "pass1234");
    await page.click("button[type=submit]");
    await expect(page).toHaveURL(/check\.html/);
    await expect(page.locator(".student-card").first()).toBeVisible();
  });

  test("학생 화면은 2시간이 지나도 로그인 유지", async ({ env, context, openOtherAs }) => {
    void context; // 테스트 시작 때 데이터를 되돌리는 fixture
    await env.createStudentAccount(STUDENT.hong, "hong123");
    const studentPage = await openOtherAs("hong123", "/student.html");
    await studentPage.clock.install();
    await studentPage.reload();
    await expect(studentPage.locator("#statusBox")).toBeVisible();
    await studentPage.clock.fastForward("03:00:00");
    await expect(studentPage).toHaveURL(/student\.html/);
  });
});
