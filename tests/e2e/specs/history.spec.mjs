import { test, expect } from "./fixtures.mjs";
import { STUDENT } from "../harness/seed.mjs";
import { answerDialogs, todayKst } from "./helpers.mjs";

// 외출 기록(history.html): 외출할 때마다 쌓이는 outing_log를 본다. 담임은 담당 반, 학년부장은 담당 학년, 관리자는 전체
const card = (page, name) => page.locator(".student-card", { hasText: name });
const historyRow = (page, name) => page.locator("#historyBody tr", { hasText: name });

test.describe("외출 기록", () => {
  test("담임: 담당 반 학생의 외출·복귀 시각을 본다(다른 반은 안 보임)", async ({ env, openAs, page }) => {
    answerDialogs(page, ["편의점", "20:00"]);
    await openAs("homeroom01", "/check.html");
    await card(page, "최하늘").getByRole("button", { name: "외출 체크" }).click();
    await expect(card(page, "최하늘").locator(".status-badge")).toHaveText("외출중");
    await card(page, "최하늘").getByRole("button", { name: "복귀 체크" }).click();
    await expect(card(page, "최하늘").locator(".status-badge")).toHaveText("재실");
    await env.sql("insert into public.outings (date, student_id, status, reason) values ($1, $2, 'out', '학원')", [todayKst(), STUDENT.seoyeon]);

    await page.goto("/history.html");
    await expect(page.locator("#historySummary")).toHaveText("2건");
    const haneul = historyRow(page, "최하늘");
    await expect(haneul).toContainText("편의점");
    await expect(haneul).toContainText("20:00"); // 복귀 예정
    await expect(haneul.locator("td").nth(3)).toHaveText(/^\d{2}:\d{2}$/); // 복귀 시각
    await expect(haneul.locator("td").nth(6)).toHaveText("김담임"); // 확인 교사
    await expect(haneul.locator("td").nth(7)).toHaveText("김담임"); // 복귀 처리
    // 어제 나가서 복귀 기록이 없는 외출(기본 데이터)
    await expect(historyRow(page, "홍길동").locator("td").nth(3)).toHaveText("복귀 기록 없음");
    await expect(historyRow(page, "이서연")).toHaveCount(0);
    await expect(page.locator("#gradeChips .filter-chip")).toHaveCount(0); // 담당 학년이 하나뿐
  });

  test("관리자: 전체를 보고 학년·이름·기간으로 거른다", async ({ env, openAs, page }) => {
    await env.sql("insert into public.outings (date, student_id, status, reason) values ($1, $2, 'out', '학원')", [todayKst(), STUDENT.seoyeon]);
    await openAs("admin01", "/history.html");
    await expect(page.locator("#historySummary")).toHaveText("2건");
    await expect(historyRow(page, "이서연").locator("td").nth(3)).toHaveText("외출 중");

    await page.click("#gradeChips >> text=2학년");
    await expect(page.locator("#historyBody tr .history-name")).toHaveText(["이서연"]);
    await page.click("#gradeChips >> text=전체");
    await page.fill("#search", "홍길");
    await expect(page.locator("#historyBody tr .history-name")).toHaveText(["홍길동"]);
    await page.fill("#search", "");
    await page.fill("#fromDate", todayKst());
    await page.locator("#fromDate").dispatchEvent("change");
    await expect(page.locator("#historyBody tr .history-name")).toHaveText(["이서연"]); // 어제 기록은 빠짐
  });

  test("학년부장: 담당 학년만", async ({ env, openAs, page }) => {
    await env.sql("insert into public.outings (date, student_id, status, reason) values ($1, $2, 'out', '학원')", [todayKst(), STUDENT.seoyeon]);
    await openAs("gm01", "/history.html");
    await expect(page.locator("#historyBody tr .history-name")).toHaveText(["홍길동"]);
  });
});
