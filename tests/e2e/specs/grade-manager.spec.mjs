import { test, expect } from "./fixtures.mjs";
import { ROOM, STUDENT } from "../harness/seed.mjs";
import { answerDialogs } from "./helpers.mjs";

// 학년부장(gm01: 1학년, 1학년실 담당)은 담당 학년 학생·담당 실만 보고, 좌석도 담당 학년 학생만 바꾼다(사용자 요청)
const cells = (page) => page.locator("#seatGrid > .seat-cell");
const cell = (page, index) => cells(page).nth(index);

test.describe("학년부장 범위", () => {
  test("체크 화면·현황판에는 담당 학년 학생과 담당 실만 보인다", async ({ openAs, page }) => {
    await openAs("gm01", "/check.html");
    await expect(page.locator(".student-card .student-name")).toHaveText(["김민준", "최하늘", "홍길동"]);
    await expect(page.locator("#filterChips .filter-chip")).toHaveText(["전체", "1학년실"]);

    await page.goto("/display.html");
    await expect(page.locator("#gradeChips .filter-chip")).toHaveText(["전체", "1학년"]);
    await expect(page.locator("#filterChips .filter-chip")).toHaveText(["전체", "1학년실"]);
    await expect(page.locator("#awayPanelList")).toContainText("김민준");
    await expect(page.locator("body")).not.toContainText("박지훈"); // 3학년 학생
  });

  test("관리자는 그대로 전체가 보인다", async ({ openAs, page }) => {
    await openAs("admin01", "/check.html");
    await expect(page.locator(".student-card .student-name")).toHaveCount(5);
    await expect(page.locator("#filterChips .filter-chip")).toHaveText(["전체", "1학년실", "2·3학년실"]);
  });

  test("좌석 배치판: 담당 실만 보이고, 함께 쓰는 실에서도 다른 학년 학생 자리는 못 바꾼다", async ({ env, openAs, page }) => {
    // 1학년실을 1·2학년이 함께 쓰고, 2학년 이서연이 r1c0에 앉아 있다
    await env.sql(
      `update public.rooms set grades = '{1,2}', seat_map = jsonb_build_object('r0c0', $2::text, 'r0c1', $3::text, 'r1c0', $4::text) where id = $1`,
      [ROOM.first, STUDENT.hong, STUDENT.minjun, STUDENT.seoyeon]
    );
    await env.sql(`update public.rooms set seat_map = '{}' where id = $1`, [ROOM.second]);
    const dialogs = answerDialogs(page, [null, true]); // 학번 배정 거부 안내(alert), 좌석표 저장 확인
    await openAs("gm01", "/seat.html");
    await expect(page.locator("#roomTabs .filter-chip")).toHaveText(["1학년실"]); // 2·3학년실은 안 보임
    await page.click("#editModeToggle");
    await expect(cell(page, 2)).toContainText("이서연");
    await expect(cell(page, 2)).toHaveClass(/seat-cell--locked/);
    await expect(cell(page, 2).locator("[data-unassign-cell]")).toHaveCount(0);
    await expect(cell(page, 0).locator("[data-unassign-cell]")).toHaveCount(1);

    // 빈자리 학번 입력: 2학년 학생은 배정할 수 없다
    await cell(page, 3).click();
    await page.fill("[data-assign-sid]", "20101");
    await page.press("[data-assign-sid]", "Enter");
    await expect.poll(() => dialogs.map((d) => d.message).join("\n")).toContain("담당 학년 학생만 배정할 수 있습니다");
    await page.keyboard.press("Escape");

    // 좌석 일괄 등록: 다른 학년 학생 자리는 그대로 남고, 그 자리에 넣으면 오류
    await page.click("#seatBulkBtn");
    await page.fill("#seatBulkInput", "10302\t10101\n10305");
    await expect(page.locator("#seatBulkPreview .bulk-preview__errors")).toContainText("2학년 이서연 학생 자리입니다");
    await expect(page.locator("#seatBulkSaveBtn")).toBeDisabled();
    await page.fill("#seatBulkInput", "10302\n10101");
    await expect(page.locator("#seatBulkPreview .seat-bulk-grid__cell--kept")).toHaveText("이서연");
    await expect(page.locator("#seatBulkSaveBtn")).toHaveText("좌석표 저장 (2명)");
    await page.click("#seatBulkSaveBtn");
    await expect(page.locator("#seatBulkWrap")).toBeHidden();
    const [room] = await env.sql("select seat_map from public.rooms where id = $1", [ROOM.first]);
    expect(room.seat_map).toEqual({ r0c0: STUDENT.haneul, r0c1: STUDENT.minjun, r1c0: STUDENT.seoyeon });
  });
});
