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
    await expect(page.getByRole("button", { name: "외출증 보기" })).toHaveCount(0); // 외출중·외출 예정에만
    await expect(card(page, "김민준").locator(".status-badge")).toHaveText("자리 없음");
    await expect(card(page, "김민준").getByRole("button", { name: "재실로 되돌리기" })).toBeVisible();
    await expect(card(page, "박지훈").locator(".status-badge")).toHaveText("명령퇴사");
    await expect(card(page, "박지훈")).toContainText("학생 명단 관리에서 설정");
    await expect(card(page, "박지훈").locator("button")).toHaveCount(0);
  });

  test("외출 체크 → 사유·복귀 시각 저장, 담당 교사 기록, 학부모 문자 → 복귀 체크", async ({ env, openAs, page }) => {
    answerDialogs(page, ["병원 진료", "23:59"]);
    await openAs("homeroom01", "/check.html");
    await card(page, "홍길동").getByRole("button", { name: "외출 체크" }).click();

    await expect(card(page, "홍길동").locator(".status-badge")).toHaveText("외출중");
    await expect(card(page, "홍길동")).toContainText("병원 진료 (~23:59)");
    await expect(page.locator("#outCountText")).toHaveText("외출중 1명");

    const row = await outingRow(env, todayKst(), STUDENT.hong);
    expect(row).toMatchObject({ status: "out", reason: "병원 진료", expected_return: "23:59", checked_by_name: "김담임" });

    // 학부모에게만 안내 문자(학생 외출증은 학생 화면에 뜸 — 문자 비용 절약)
    await expect(card(page, "홍길동").locator(".notice-text")).toHaveText("문자 학부모 ✓");
    expect(env.sms.messages).toHaveLength(1);
    const [toParent] = env.sms.messages;
    expect(toParent).toMatchObject({ to: "01033334444", from: "0212345678", subject: "외출 안내" });
    expect(toParent.text).toContain("홍길동 학생이");
    expect(toParent.text).toContain("복귀 예정: 23:59");
    expect(toParent.text).toContain("사유: 병원 진료");
    expect(toParent.text).toContain("확인 교사: 김담임");
    expect((await outingRow(env, todayKst(), STUDENT.hong)).notice).toMatchObject({ status: "done", parent: { result: "sent" } });

    // 학생 화면과 같은 외출증을 교사 화면에서도 팝업으로 본다
    await card(page, "홍길동").getByRole("button", { name: "외출증 보기" }).click();
    const passDialog = page.locator("#passDialog");
    await expect(passDialog).toBeVisible();
    await expect(page.locator("#passDialogTitle")).toHaveText("홍길동 외출증");
    await expect.poll(() => page.locator("#passDialogCanvas").evaluate((c) => [c.width, c.height])).toEqual([640, 860]);
    await passDialog.getByRole("button", { name: "닫기" }).click();
    await expect(passDialog).toBeHidden();

    await card(page, "홍길동").getByRole("button", { name: "복귀 체크" }).click();
    await expect(card(page, "홍길동").locator(".status-badge")).toHaveText("재실");
    await expect(card(page, "홍길동").getByRole("button", { name: "외출증 보기" })).toHaveCount(0);
    const back = await outingRow(env, todayKst(), STUDENT.hong);
    expect(back).toMatchObject({ status: "in", reason: null, expected_return: null, notice: null });
    expect(env.sms.messages).toHaveLength(1); // 복귀할 때는 보내지 않음
  });

  test("문자 실패는 카드에 빨갛게 보인다", async ({ env, openAs, page }) => {
    env.sms.failTo.add("01033334444");
    answerDialogs(page, ["병원", "23:59"]);
    await openAs("homeroom01", "/check.html");
    await card(page, "홍길동").getByRole("button", { name: "외출 체크" }).click();
    const notice = card(page, "홍길동").locator(".notice-text");
    await expect(notice).toHaveText("문자 학부모 실패");
    await expect(notice).toHaveClass(/notice-text--failed/);
    await expect(notice).toHaveAttribute("title", "학부모: 수신번호 오류");
  });

  test("사유 입력을 취소해도 외출 체크는 된다(학부모 연락처가 없으면 문자 없음)", async ({ env, openAs, page }) => {
    answerDialogs(page, [null, "9:30 "]);
    await page.clock.install({ time: new Date(`${todayKst()}T08:00:00+09:00`) });
    await openAs("teacher01", "/check.html");
    await card(page, "최하늘").getByRole("button", { name: "외출 체크" }).click();
    await expect(card(page, "최하늘").locator(".status-badge")).toHaveText("외출중");
    const row = await outingRow(env, todayKst(), STUDENT.haneul);
    expect(row).toMatchObject({ status: "out", reason: null, expected_return: "09:30" }); // "9:30" → "09:30"
    await expect(card(page, "최하늘").locator(".notice-text")).toHaveText("학부모 번호 없음");
    expect(env.sms.messages).toHaveLength(0);
  });

  test("예상 복귀 시각은 꼭 넣어야 한다(취소·잘못된 값·지난 시각이면 외출 체크 안 함)", async ({ env, openAs, page }) => {
    const seen = answerDialogs(page, ["병원", null, "병원", "모름", null, "병원", "00:00", null]);
    await openAs("teacher01", "/check.html");
    const btn = card(page, "최하늘").getByRole("button", { name: "외출 체크" });
    await btn.click(); // 예상 복귀 입력을 취소
    await btn.click(); // 시각이 아닌 값
    await expect.poll(() => seen.filter((d) => d.type === "alert").length).toBe(1);
    await btn.click(); // 이미 지난 시각
    await expect.poll(() => seen.filter((d) => d.type === "alert").length).toBe(2);
    expect(seen.filter((d) => d.type === "alert").map((d) => d.message)).toEqual([
      "예상 복귀 시각을 17:00처럼 입력해 주세요. 외출 체크는 하지 않았습니다.",
      "예상 복귀 시각은 지금보다 늦어야 합니다(지난 시각이면 바로 자동 복귀됩니다). 외출 체크는 하지 않았습니다.",
    ]);
    await expect(card(page, "최하늘").locator(".status-badge")).toHaveText("재실");
    expect(await outingRow(env, todayKst(), STUDENT.haneul)).toBeNull();
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

  test("지난 날짜 기록은 보기만 할 수 있다(서버도 막음)", async ({ env, openAs, page }) => {
    await openAs("teacher01", "/check.html");
    await expect(page.locator("#dateSelect")).toHaveValue(todayKst());
    await expect(page.locator("#dateSelect")).toHaveAttribute("max", todayKst());

    await page.fill("#dateSelect", yesterdayKst());
    await expect(page.locator("#pastDateNotice")).toBeVisible();
    await expect(card(page, "홍길동").locator(".status-badge")).toHaveText("외출중");
    await expect(card(page, "홍길동")).toContainText("병원 (~17:00)");
    await expect(card(page, "김민준").locator(".status-badge")).toHaveText("재실");
    await expect(page.locator("#outCountText")).toHaveText("그 날 외출 기록 1명");

    await expect(page.locator("#pastDateNotice")).toContainText("보기만 할 수 있습니다");
    // 외출 체크·복귀 체크 버튼이 없고, 외출증은 볼 수 있다
    await expect(page.getByRole("button", { name: "외출 체크" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "복귀 체크" })).toHaveCount(0);
    await expect(card(page, "홍길동").locator("button")).toHaveText(["외출증 보기"]);

    // 화면을 우회해도 서버가 지난 날짜 쓰기를 막는다
    const error = await page.evaluate(async ({ date, id }) => {
      const { supabase } = await import("/js/supabase-client.js");
      const { error } = await supabase.from("outings").upsert({ date, student_id: id, status: "in" });
      return error && error.message;
    }, { date: yesterdayKst(), id: STUDENT.hong });
    expect(error).toContain("row-level security");
    expect((await outingRow(env, yesterdayKst(), STUDENT.hong)).status).toBe("out");

    await page.fill("#dateSelect", todayKst());
    await expect(page.locator("#pastDateNotice")).toBeHidden();
    await expect(card(page, "최하늘").locator(".status-badge")).toHaveText("재실");
    await expect(card(page, "김민준").locator(".status-badge")).toHaveText("자리 없음");
  });

  test("다른 교사가 바꾼 내용이 새로고침 없이 반영된다", async ({ env, openAs, openOtherAs, page }) => {
    await openAs("teacher01", "/check.html");
    await expect(card(page, "이서연").locator(".status-badge")).toHaveText("재실");

    const other = await openOtherAs("admin01", "/check.html");
    answerDialogs(other, ["학원", "23:59"]);
    await card(other, "이서연").getByRole("button", { name: "외출 체크" }).click();
    await expect(card(other, "이서연").locator(".status-badge")).toHaveText("외출중");

    await expect(card(page, "이서연").locator(".status-badge")).toHaveText("외출중");
    await expect(page.locator("#outCountText")).toHaveText("외출중 1명");

    // 학생 명단·실이 바뀌어도 반영
    await env.sql("update public.students set name = '이서윤' where id = $1", [STUDENT.seoyeon]);
    await expect(card(page, "이서윤")).toBeVisible();
    await env.sql("update public.rooms set name = '2·3학년 자습실' where name = '2·3학년실'");
    await expect(page.locator("#filterChips .filter-chip")).toHaveText(["전체", "1학년실", "2·3학년 자습실"]);

    // 외출증을 보고 있는 동안 다른 교사가 복귀 체크하면 팝업이 닫힌다
    await card(page, "이서윤").getByRole("button", { name: "외출증 보기" }).click();
    await expect(page.locator("#passDialogTitle")).toHaveText("이서윤 외출증");
    await card(other, "이서윤").getByRole("button", { name: "복귀 체크" }).click();
    await expect(page.locator("#passDialog")).toBeHidden();
    await expect(card(page, "이서윤").locator(".status-badge")).toHaveText("재실");
  });

  test("저장이 거부되면 알림을 띄우고 화면은 그대로 둔다", async ({ env, openAs, page }) => {
    const seen = answerDialogs(page, ["사유", "23:59", true]);
    await openAs("teacher01", "/check.html");
    await expect(card(page, "홍길동").locator(".status-badge")).toHaveText("재실");
    // 실시간 연결 직후의 다시 읽기까지 끝난 뒤에 비활성화한다(그 전에 바꾸면 목록이 빈 채로 다시 그려짐)
    await page.waitForLoadState("networkidle");
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
