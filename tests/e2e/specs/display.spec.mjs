import { test, expect } from "./fixtures.mjs";
import { STUDENT } from "../harness/seed.mjs";
import { kstDatePlus, kstWeekdayIndex, todayKst } from "./helpers.mjs";

const panel = (page, id) => page.locator(`#${id}`);

test.describe("기숙사 현황판", () => {
  test("자리 없음·외출중·방과후 패널(명령퇴사·외출 금지는 보이지 않음)", async ({ env, openAs, page }) => {
    await env.sql("update public.students set ban_from = public.today_kst(), ban_to = public.today_kst() + 3 where id = $1", [STUDENT.minjun]);
    await openAs("teacher01", "/display.html");
    await expect(panel(page, "awayPanelList").locator(".display-card__name")).toHaveText(["김민준"]);
    await expect(panel(page, "awayPanelCount")).toHaveText("1명");
    await expect(panel(page, "outPanelCount")).toHaveText("0명");
    await expect(panel(page, "outPanelList")).toContainText("외출중인 학생이 없습니다.");
    await expect(page.locator("#leavePanelList")).toHaveCount(0);
    await expect(page.locator("body")).not.toContainText("박지훈"); // 명령퇴사 중
    await expect(page.locator(".ban-chip")).toHaveCount(0);
    if (kstWeekdayIndex() === null) {
      await expect(panel(page, "afterschoolPanelList")).toContainText("오늘은 방과후가 없는 날입니다.");
    } else {
      await expect(panel(page, "afterschoolPanelList").locator(".display-card__name")).toHaveText(["홍길동"]);
    }
  });

  test("방과후 없는 날로 바꾸면 방과후 요일인 학생도 오늘 방과후에 안 나온다(좌석 색도)", async ({ env, openAs, page }) => {
    test.skip(kstWeekdayIndex() === null, "주말에는 원래 방과후가 없다");
    await openAs("teacher01", "/display.html");
    await expect(panel(page, "afterschoolPanelList").locator(".display-card__name")).toHaveText(["홍길동"]);
    await env.sql("delete from public.afterschool_dates where date = public.today_kst()");
    await expect(panel(page, "afterschoolPanelList")).toContainText("오늘은 방과후가 없는 날입니다."); // 실시간으로
    await expect(panel(page, "afterschoolPanelCount")).toHaveText("0명");
    await page.goto("/seat.html");
    await expect(page.locator("#seatGrid > .seat-cell").first()).toContainText("홍길동");
    await expect(page.locator("#seatGrid > .seat-cell").first()).not.toHaveClass(/seat-cell--afterschool/);
  });

  test("학년·실 필터를 함께 적용한다", async ({ openAs, page }) => {
    await openAs("dorm01", "/display.html");
    await page.click("#gradeChips >> text=3학년");
    await expect(panel(page, "awayPanelCount")).toHaveText("0명");
    await page.click("#filterChips >> text=1학년실");
    await page.click("#gradeChips >> text=전체");
    await expect(panel(page, "awayPanelCount")).toHaveText("1명");
  });

  test("다른 화면에서 바꾼 외출이 실시간으로 반영된다", async ({ env, openAs, page }) => {
    await openAs("teacher01", "/display.html");
    await expect(panel(page, "outPanelCount")).toHaveText("0명");
    await env.sql(
      "insert into public.outings (date, student_id, status, reason) values ($1, $2, 'out', '학원')",
      [todayKst(), STUDENT.seoyeon]
    );
    await expect(panel(page, "outPanelList").locator(".display-card__name")).toHaveText(["이서연"]);
    await env.sql("update public.outings set status = 'in' where date = $1 and student_id = $2", [todayKst(), STUDENT.minjun]);
    await expect(panel(page, "awayPanelCount")).toHaveText("0명");
  });
});
