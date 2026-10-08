import { test, expect } from "./fixtures.mjs";
import { STUDENT } from "../harness/seed.mjs";
import { collectAlerts, kstDatePlus, todayKst } from "./helpers.mjs";

// 기숙사부(dormStaff): 화면은 볼 수 있지만 바꿀 수 있는 건 명령퇴사 기간뿐(사용자 요청)
const studentCard = (page, name) => page.locator(".student-card", { hasText: name });

async function studentRow(env, id) {
  return (await env.sql("select * from public.students where id = $1", [id]))[0];
}

test.describe("기숙사부 — 보기 + 명령퇴사 기간만", () => {
  test("체크 화면: 외출 체크·복귀·승인 버튼 없이 외출증만 볼 수 있다", async ({ env, openAs, page }) => {
    await env.sql("insert into public.outings (date, student_id, status, reason) values ($1, $2, 'out', '학원')", [todayKst(), STUDENT.seoyeon]);
    await openAs("dorm01", "/check.html");
    await expect(studentCard(page, "이서연").locator(".status-badge")).toHaveText("외출중");
    await expect(page.getByRole("button", { name: "외출 체크" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "복귀 체크" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "재실로 되돌리기" })).toHaveCount(0);
    await expect(page.locator("#requestPanel")).toBeHidden();
    await studentCard(page, "이서연").getByRole("button", { name: "외출증 보기" }).click();
    await expect(page.locator("#passDialogTitle")).toHaveText("이서연 외출증");

    // 화면을 우회해도 서버가 외출 기록 쓰기를 막는다
    const error = await page.evaluate(async ({ date, id }) => {
      const { supabase } = await import("/js/supabase-client.js");
      const { error } = await supabase.from("outings").upsert({ date, student_id: id, status: "in" });
      return error && error.message;
    }, { date: todayKst(), id: STUDENT.seoyeon });
    expect(error).toContain("row-level security");
    expect((await env.sql("select status from public.outings where student_id = $1", [STUDENT.seoyeon]))[0].status).toBe("out");
  });

  test("좌석 배치판: 편집 모드 없음, 외출중 좌석은 외출증만", async ({ env, openAs, page }) => {
    await env.sql("insert into public.outings (date, student_id, status) values ($1, $2, 'out')", [todayKst(), STUDENT.seoyeon]);
    await openAs("dorm01", "/seat.html");
    await expect(page.locator("#editModeToggle")).toBeHidden();
    await page.click("#roomTabs >> text=2·3학년실");
    const seat = page.locator("#seatGrid > .seat-cell").first();
    await seat.click();
    await expect(seat.locator(".seat-cell__action-btn")).toHaveText(["외출증", "취소"]);

    // 재실 학생 좌석은 눌러도 아무것도 안 뜬다(자리 없음 표시 불가)
    await page.click("#roomTabs >> text=1학년실");
    const hongSeat = page.locator("#seatGrid > .seat-cell", { hasText: "홍길동" });
    await hongSeat.click();
    await expect(hongSeat.locator(".seat-cell__action-btn")).toHaveCount(0);
  });

  test("학생 명단: 추가·삭제·계정 버튼 없이 명령퇴사 기간만 저장", async ({ env, openAs, page }) => {
    const alerts = collectAlerts(page);
    await openAs("dorm01", "/students.html");
    await expect(page.locator("#addStudentBtn")).toBeHidden();
    await expect(page.locator("#bulkAddBtn")).toBeHidden();
    await expect(page.locator("#bulkIssueBtn")).toBeHidden();
    const hong = page.locator("#rosterList .student-card", { hasText: "홍길동" });
    await expect(hong.locator("button")).toHaveText(["명령퇴사 설정"]);

    await hong.getByRole("button", { name: "명령퇴사 설정" }).click();
    await expect(page.locator("#inputName")).toBeDisabled();
    await expect(page.locator("#inputPhone")).toBeDisabled();
    await expect(page.locator("#inputLoginId")).toBeDisabled();
    await expect(page.locator("#dayToggleRow button").first()).toBeDisabled();

    // 기간 검사는 그대로
    await page.fill("#inputLeaveFrom", kstDatePlus(1));
    await page.click("#submitFormBtn");
    await expect.poll(() => alerts.at(-1)).toBe("명령퇴사 기간은 시작일과 종료일을 모두 입력해 주세요.");

    const before = await studentRow(env, STUDENT.hong);
    await page.fill("#inputLeaveTo", kstDatePlus(3));
    await page.fill("#inputLeaveReason", "생활규정 위반");
    await page.click("#submitFormBtn");
    await expect(page.locator("#formWrap")).toBeHidden();
    const after = await studentRow(env, STUDENT.hong);
    expect(after).toMatchObject({ leave_reason: "생활규정 위반", name: before.name, phone: before.phone, login_id: before.login_id });
    expect(after.leave_from).not.toBeNull();
    await expect(hong).toContainText("명령퇴사 예정");

    // 화면을 우회해 다른 칸을 바꾸면 서버가 거부
    const error = await page.evaluate(async (id) => {
      const { supabase } = await import("/js/supabase-client.js");
      const { error } = await supabase.from("students").update({ name: "바꾼 이름" }).eq("id", id);
      return error && error.message;
    }, STUDENT.hong);
    expect(error).toBe("기숙사부는 명령퇴사 기간만 바꿀 수 있습니다.");

    // 기간을 비우고 저장하면 해제
    await hong.getByRole("button", { name: "명령퇴사 설정" }).click();
    await page.fill("#inputLeaveFrom", "");
    await page.fill("#inputLeaveTo", "");
    await page.click("#submitFormBtn");
    await expect(page.locator("#formWrap")).toBeHidden();
    expect(await studentRow(env, STUDENT.hong)).toMatchObject({ leave_from: null, leave_to: null, leave_reason: null });
  });

  test("학생 계정 함수도 기숙사부를 거부한다", async ({ openAs, page }) => {
    await openAs("dorm01", "/students.html");
    const result = await page.evaluate(async (id) => {
      const { callFunction } = await import("/js/supabase-client.js");
      try {
        return await callFunction("student-accounts", { action: "issue", studentIds: [id] });
      } catch (err) {
        return { error: err.message };
      }
    }, STUDENT.haneul);
    expect(JSON.stringify(result)).toContain("이 학생의 계정을 관리할 권한이 없습니다.");
    expect(JSON.stringify(result)).not.toContain("password");
  });
});
