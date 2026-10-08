import { test, expect } from "./fixtures.mjs";
import { ROOM, STUDENT } from "../harness/seed.mjs";
import { answerDialogs, collectAlerts, todayKst } from "./helpers.mjs";

const cells = (page) => page.locator("#seatGrid > .seat-cell");
const cell = (page, index) => cells(page).nth(index);

async function room(env, id) {
  return (await env.sql("select * from public.rooms where id = $1", [id]))[0] ?? null;
}

async function outingStatus(env, studentId) {
  const rows = await env.sql("select status from public.outings where date = $1 and student_id = $2", [todayKst(), studentId]);
  return rows[0]?.status ?? null;
}

test.describe("좌석 배치판 — 보기 모드", () => {
  test("좌석을 눌러 자리없음 표시 → 재실로", async ({ env, openAs, page }) => {
    answerDialogs(page, [true]);
    await openAs("teacher01", "/seat.html");
    await expect(page.locator("#editModeToggle")).toBeHidden();
    await expect(page.locator("#roomTabs .filter-chip")).toHaveText(["1학년실", "2·3학년실"]);
    await expect(cells(page)).toHaveCount(4);
    await expect(cell(page, 0)).toContainText("홍길동");
    await expect(cell(page, 1)).toHaveClass(/seat-cell--away/);

    await cell(page, 0).click();
    await cell(page, 0).getByRole("button", { name: "자리없음" }).click();
    await expect(cell(page, 0)).toHaveClass(/seat-cell--away/);
    expect(await outingStatus(env, STUDENT.hong)).toBe("away");

    await cell(page, 0).click();
    await cell(page, 0).getByRole("button", { name: "재실로" }).click();
    await expect(cell(page, 0)).not.toHaveClass(/seat-cell--away/);
    expect(await outingStatus(env, STUDENT.hong)).toBe("in");
  });

  test("외출 중 학생 복귀, 명령퇴사 좌석은 조작 불가", async ({ env, openAs, page }) => {
    await env.sql("insert into public.outings (date, student_id, status) values ($1, $2, 'out')", [todayKst(), STUDENT.seoyeon]);
    await openAs("teacher01", "/seat.html");
    await page.click("#roomTabs >> text=2·3학년실");
    await expect(cell(page, 0)).toHaveClass(/seat-cell--out/);
    await cell(page, 0).click();
    await expect(cell(page, 0).locator(".seat-cell__action-btn")).toHaveText(["외출증", "복귀", "취소"]);
    // [외출증] → 학생 화면과 같은 외출증 팝업(닫으면 좌석은 그대로)
    await cell(page, 0).getByRole("button", { name: "외출증" }).click();
    await expect(page.locator("#passDialogTitle")).toHaveText("이서연 외출증");
    await expect.poll(() => page.locator("#passDialogCanvas").evaluate((c) => [c.width, c.height])).toEqual([640, 860]);
    await page.locator("#passDialog").getByRole("button", { name: "닫기" }).click();
    await expect(page.locator("#passDialog")).toBeHidden();
    await expect(cell(page, 0)).toHaveClass(/seat-cell--out/);

    await cell(page, 0).click();
    await cell(page, 0).getByRole("button", { name: "복귀" }).click();
    await expect(cell(page, 0)).not.toHaveClass(/seat-cell--out/);
    expect(await outingStatus(env, STUDENT.seoyeon)).toBe("in");

    const leaveSeat = cell(page, 5);
    await expect(leaveSeat).toHaveClass(/seat-cell--leave/);
    await leaveSeat.click();
    await expect(leaveSeat.locator(".seat-cell__action-btn")).toHaveCount(0);
  });
});

test.describe("좌석 배치판 — 편집 모드", () => {
  test("관리자: 실 추가·이름·대상 학년·크기·배정·이동·해제·삭제", async ({ env, openAs, page }) => {
    answerDialogs(page, [true]);
    await openAs("admin01", "/seat.html");
    await page.click("#editModeToggle");
    await expect(page.locator("#addRoomBtn")).toBeVisible();
    await expect(page.locator("#roomSettingsPanel")).toBeVisible();

    // 실 추가 → 새 실이 선택됨
    await page.click("#addRoomBtn");
    await expect(page.locator("#roomTabs .filter-chip.is-active")).toHaveText("새 실");
    const created = await env.sql("select * from public.rooms where name = '새 실'");
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ rows: 3, cols: 4, grades: [], seat_map: {} });
    const newRoomId = created[0].id;

    // 이름 변경
    await page.fill("#roomNameInput", "3학년 독서실");
    await page.locator("#roomNameInput").press("Enter");
    await page.locator("#roomNameInput").blur();
    await expect(page.locator("#roomTabs .filter-chip.is-active")).toHaveText("3학년 독서실");

    // 대상 학년 1학년 지정 → 빈 좌석에 최하늘 배정
    await page.click("#roomGradeToggleRow >> text=1학년");
    await expect(page.locator("#roomGradeToggleRow .is-active")).toHaveText(["1학년"]);
    expect((await room(env, newRoomId)).grades).toEqual([1]);

    await cell(page, 0).click();
    await page.selectOption("[data-assign-select='r0c0']", STUDENT.haneul);
    await expect(cell(page, 0)).toContainText("최하늘");
    expect((await room(env, newRoomId)).seat_map).toEqual({ r0c0: STUDENT.haneul });

    // 다른 실에 앉아 있던 홍길동을 이 실 r2c3으로 옮기면 원래 자리는 비워진다
    await cell(page, 11).click();
    await page.selectOption("[data-assign-select='r2c3']", STUDENT.hong);
    await expect(cell(page, 11)).toContainText("홍길동");
    expect((await room(env, newRoomId)).seat_map).toEqual({ r0c0: STUDENT.haneul, r2c3: STUDENT.hong });
    expect((await room(env, ROOM.first)).seat_map).toEqual({ r0c1: STUDENT.minjun });

    // 행·열 줄이기 → 범위 밖 좌석(r2c3) 배정은 지워진다
    await page.click("#rowsMinusBtn");
    await expect(page.locator("#rowsValue")).toHaveText("2");
    await page.click("#colsMinusBtn");
    await expect(page.locator("#colsValue")).toHaveText("3");
    await expect(cells(page)).toHaveCount(6);
    expect(await room(env, newRoomId)).toMatchObject({ rows: 2, cols: 3, seat_map: { r0c0: STUDENT.haneul } });
    await page.click("#rowsPlusBtn");
    await expect(page.locator("#rowsValue")).toHaveText("3");

    // 배정 해제
    await cell(page, 0).locator(".seat-cell__unassign").click();
    await expect(cell(page, 0)).toHaveClass(/seat-cell--empty/);
    expect((await room(env, newRoomId)).seat_map).toEqual({});

    // 실 삭제
    await page.click("#deleteRoomBtn");
    await expect(page.locator("#roomTabs .filter-chip")).toHaveText(["1학년실", "2·3학년실"]);
    expect(await room(env, newRoomId)).toBeNull();
  });

  test("대상 학년이 없는 실의 빈 좌석을 누르면 안내한다", async ({ openAs, page }) => {
    const alerts = collectAlerts(page);
    await openAs("dorm01", "/seat.html");
    await page.click("#editModeToggle");
    await page.click("#addRoomBtn");
    await expect(page.locator("#roomTabs .filter-chip.is-active")).toHaveText("새 실");
    await cell(page, 0).click();
    await expect.poll(() => alerts.length).toBe(1);
    expect(alerts[0]).toContain("대상 학년");
  });

  test("학년부장: 담당 실만 좌석 배정 가능, 실 설정은 못 함", async ({ env, openAs, page }) => {
    await openAs("gm01", "/seat.html");
    await page.click("#editModeToggle");
    await expect(page.locator("#addRoomBtn")).toBeHidden();
    await expect(page.locator("#roomSettingsPanel")).toBeHidden();

    // 담당 실(1학년실): 빈 좌석에 배정 가능
    await expect(cell(page, 2)).toHaveClass(/seat-cell--clickable/);
    await cell(page, 2).click();
    await page.selectOption("[data-assign-select='r1c0']", STUDENT.haneul);
    await expect(cell(page, 2)).toContainText("최하늘");
    expect((await room(env, ROOM.first)).seat_map.r1c0).toBe(STUDENT.haneul);

    // 담당 아닌 실: 편집 불가
    await page.click("#roomTabs >> text=2·3학년실");
    await expect(page.locator("#seatGrid .seat-cell--clickable")).toHaveCount(0);
    await expect(page.locator("#seatGrid .seat-cell__unassign")).toHaveCount(0);
  });

  test("서버도 담당 밖 실의 좌석 배정을 거부한다", async ({ env, openAs, page }) => {
    await openAs("gm01", "/seat.html");
    await expect(page.locator("#currentUserName")).toHaveText("1학년부장");
    const result = await page.evaluate(async ([roomId, studentId]) => {
      const { supabase } = await import("/js/supabase-client.js");
      const { error } = await supabase.rpc("assign_seat", { p_room_id: roomId, p_cell_key: "r0c1", p_student_id: studentId });
      return error && error.message;
    }, [ROOM.second, STUDENT.seoyeon]);
    expect(result).toBe("이 실의 좌석을 편집할 권한이 없습니다.");
    expect((await room(env, ROOM.second)).seat_map).toEqual({ r0c0: STUDENT.seoyeon, r1c2: STUDENT.jihun });
  });
});
