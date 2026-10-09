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
    await openAs("admin01", "/seat.html");
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
  test("좌석을 끌어서 옮긴다: 빈자리면 이동, 학생 자리면 맞바꿈", async ({ env, openAs, page }) => {
    await openAs("gm01", "/seat.html"); // 학년부장(1학년실 담당)
    await page.click("#editModeToggle");
    await expect(cell(page, 0)).toContainText("홍길동");

    async function dragCell(fromIndex, toIndex) {
      const from = await cell(page, fromIndex).boundingBox();
      const to = await cell(page, toIndex).boundingBox();
      await page.mouse.move(from.x + 20, from.y + 20);
      await page.mouse.down();
      await page.mouse.move(from.x + 40, from.y + 40, { steps: 3 });
      await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 8 });
      await expect(cell(page, toIndex)).toHaveClass(/seat-cell--drop-target/);
      await page.mouse.up();
    }

    // 1학년실(2×2): r0c0 홍길동, r0c1 김민준 → 홍길동을 빈자리 r1c1로
    await dragCell(0, 3);
    await expect(cell(page, 3)).toContainText("홍길동");
    await expect(cell(page, 0)).not.toContainText("홍길동");
    expect((await room(env, ROOM.first)).seat_map).toEqual({ r0c1: STUDENT.minjun, r1c1: STUDENT.hong });
    // 끈 뒤에 빈자리 입력칸이 열리지 않는다
    await expect(page.locator("[data-assign-sid]")).toHaveCount(0);

    // 김민준을 홍길동 자리로 → 맞바꿈
    await dragCell(1, 3);
    await expect(cell(page, 3)).toContainText("김민준");
    await expect(cell(page, 1)).toContainText("홍길동");
    expect((await room(env, ROOM.first)).seat_map).toEqual({ r0c1: STUDENT.hong, r1c1: STUDENT.minjun });

    // 조금만 움직이면 끌기가 아니라 보통 클릭(× 해제는 그대로 동작)
    await cell(page, 1).locator("[data-unassign-cell]").click();
    await expect(cell(page, 1)).not.toContainText("홍길동");
  });

  test("좌석 일괄 등록: 엑셀 좌석표 모양 그대로, 오류가 있으면 저장 안 됨", async ({ env, openAs, page }) => {
    answerDialogs(page, [true]);
    await openAs("gm01", "/seat.html"); // 학년부장(1학년실 담당)
    await expect(page.locator("#seatBulkBtn")).toBeHidden(); // 보기 모드에서는 없음
    await page.click("#editModeToggle");
    await page.click("#seatBulkBtn");
    await expect(page.locator("#seatBulkRoomName")).toHaveText("1학년실 (2행×2열)");
    const cellsText = () => page.locator("#seatBulkPreview .seat-bulk-grid__cell");
    const errors = page.locator("#seatBulkPreview .bulk-preview__errors");

    // 다른 학년·중복·없는 학번·실보다 큰 표는 오류로 보여 주고 저장 버튼이 꺼진다
    await page.fill("#seatBulkInput", "20101\t10305\n10305\t99999\t10101");
    await expect(errors).toContainText("2학년이라 이 실");
    await expect(errors).toContainText("위에 이미 있습니다");
    await expect(errors).toContainText("99999 학생이 명단에 없습니다");
    await expect(errors).toContainText("이 실(2행×2열)보다 큽니다");
    await expect(page.locator("#seatBulkSaveBtn")).toBeDisabled();

    // 좌석 모양 그대로(빈 칸 = 빈자리, 칸에 이름이 같이 있어도 됨)
    await page.fill("#seatBulkInput", "10302\t\n10305 홍길동\t10101\n");
    await expect(errors).toHaveCount(0);
    await expect(cellsText()).toHaveText(["최하늘", "빈자리", "홍길동", "김민준"]);
    await expect(page.locator("#seatBulkSaveBtn")).toHaveText("좌석표 저장 (3명)");
    await page.click("#seatBulkSaveBtn");
    await expect(page.locator("#seatBulkWrap")).toBeHidden();
    await expect(cell(page, 0)).toContainText("최하늘");
    await expect(cell(page, 2)).toContainText("홍길동");
    expect((await room(env, ROOM.first)).seat_map).toEqual({ r0c0: STUDENT.haneul, r1c0: STUDENT.hong, r1c1: STUDENT.minjun });
  });

  test("좌석 일괄 등록: 학번 목록만 붙여넣으면 앞자리부터 차례로", async ({ env, openAs, page }) => {
    answerDialogs(page, [true]);
    await openAs("admin01", "/seat.html");
    await page.click("#editModeToggle");
    await page.click("#seatBulkBtn");
    await page.fill("#seatBulkInput", "10101\n10302\n10305");
    await expect(page.locator("#seatBulkPreview .seat-bulk-grid__cell")).toHaveText(["김민준", "최하늘", "홍길동", "빈자리"]);
    await page.click("#seatBulkSaveBtn");
    await expect(page.locator("#seatBulkWrap")).toBeHidden();
    expect((await room(env, ROOM.first)).seat_map).toEqual({ r0c0: STUDENT.minjun, r0c1: STUDENT.haneul, r1c0: STUDENT.hong });
  });

  test("학번을 입력하고 Enter로 배정하면 다음 빈자리로 넘어간다", async ({ env, openAs, page }) => {
    const dialogs = answerDialogs(page, [true, true, true]);
    await openAs("admin01", "/seat.html");
    await page.click("#editModeToggle");
    await expect(cell(page, 0)).toContainText("홍길동");

    // 1학년실(2×2): r0c0 홍길동, r0c1 김민준, r1c0·r1c1 빈자리
    await cell(page, 2).click();
    const sid = page.locator("[data-assign-sid]");
    await expect(sid).toBeFocused();
    await sid.fill("10302");
    await sid.press("Enter");
    await expect(cell(page, 2)).toContainText("최하늘");
    // 다음 빈자리(r1c1)가 열리고 바로 입력할 수 있다
    await expect(page.locator("[data-assign-sid='r1c1']")).toBeFocused();

    // 다른 학년·없는 학번은 알림만
    await sid.fill("20101");
    await sid.press("Enter");
    await expect.poll(() => dialogs.length).toBe(1);
    expect(dialogs[0].message).toContain("2학년이라 이 실");
    await sid.fill("99999");
    await sid.press("Enter");
    await expect.poll(() => dialogs.length).toBe(2);
    expect(dialogs[1].message).toContain("명단에 없습니다");

    // 이미 앉아 있는 학생은 확인 후 옮긴다. 빈자리가 더 없으면 입력칸이 닫힘
    await sid.fill("10305");
    await sid.press("Enter");
    await expect(cell(page, 3)).toContainText("홍길동");
    expect(dialogs[2].message).toContain("1학년실에 앉아 있습니다");
    await expect(cell(page, 0)).not.toContainText("홍길동");
    expect((await room(env, ROOM.first)).seat_map).toEqual({ r0c1: STUDENT.minjun, r1c0: STUDENT.haneul, r1c1: STUDENT.hong });
    // 홍길동이 빠진 r0c0은 맨 앞이라 "다음 빈자리"가 아님 → 닫힘
    await expect(page.locator("[data-assign-sid]")).toHaveCount(0);
  });

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
    await openAs("admin01", "/seat.html");
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

// 전자칠판(터치)에서도 끌어서 옮길 수 있어야 한다 — 실제 터치 입력(CDP)으로 확인
test.describe("좌석 배치판 — 터치", () => {
  test.use({ hasTouch: true });

  test("터치로 끌어서 빈자리로 옮긴다", async ({ env, openAs, page }) => {
    await openAs("admin01", "/seat.html");
    await page.click("#editModeToggle");
    await expect(cell(page, 0)).toContainText("홍길동");
    const from = await cell(page, 0).boundingBox();
    const to = await cell(page, 3).boundingBox();
    const cdp = await page.context().newCDPSession(page);
    const touch = (type, x, y) =>
      cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x, y, id: 1 }] });
    await touch("touchStart", from.x + 20, from.y + 20);
    for (let i = 1; i <= 10; i++) {
      await touch("touchMove", from.x + 20 + (to.x + to.width / 2 - from.x - 20) * (i / 10), from.y + 20 + (to.y + to.height / 2 - from.y - 20) * (i / 10));
    }
    await touch("touchEnd");
    await expect(cell(page, 3)).toContainText("홍길동");
    expect((await room(env, ROOM.first)).seat_map).toEqual({ r0c1: STUDENT.minjun, r1c1: STUDENT.hong });
  });
});
