import { test, expect } from "./fixtures.mjs";
import { STUDENT } from "../harness/seed.mjs";
import { answerDialogs, kstDatePlus, todayKst } from "./helpers.mjs";

// 외출 금지(사용자 요청): 학년부장·관리자가 기간·사유를 정하고, 금지 기간에는 학생 신청을 막고
// 외출 처리(외출 체크·신청 승인)는 학년부장·관리자만(확인 창) 한다.
const card = (page, name) => page.locator("#studentList .student-card", { hasText: name });
const rosterCard = (page, name) => page.locator("#rosterList .student-card", { hasText: name });
const untilText = () => {
  const to = kstDatePlus(3);
  return `외출 금지 ~${Number(to.slice(5, 7))}/${Number(to.slice(8, 10))}`;
};

async function banHong(env) {
  await env.sql("update public.students set ban_from = $2, ban_to = $3, ban_reason = '벌점 누적' where id = $1", [
    STUDENT.hong,
    todayKst(),
    kstDatePlus(3),
  ]);
}

test.describe("외출 금지", () => {
  test("학년부장이 학생 명단에서 기간·사유를 정하고, 담임 폼에는 그 칸이 없다", async ({ env, openAs, openOtherAs, page }) => {
    await openAs("gm01", "/students.html");
    await rosterCard(page, "홍길동").getByRole("button", { name: "수정" }).click();
    await expect(page.locator("#banFields")).toBeVisible();
    await page.fill("#inputBanFrom", todayKst());
    await page.fill("#inputBanTo", kstDatePlus(3));
    await page.fill("#inputBanReason", "벌점 누적");
    await page.click("#submitFormBtn");
    await expect(rosterCard(page, "홍길동").locator(".status-badge--ban")).toHaveText(untilText());
    const [row] = await env.sql("select ban_from::text, ban_to::text, ban_reason from public.students where id = $1", [STUDENT.hong]);
    expect(row).toEqual({ ban_from: todayKst(), ban_to: kstDatePlus(3), ban_reason: "벌점 누적" });

    const other = await openOtherAs("homeroom01", "/students.html");
    await rosterCard(other, "홍길동").getByRole("button", { name: "수정" }).click();
    await expect(other.locator("#banFields")).toBeHidden();
  });

  test("[외출 금지 해제] 버튼 하나로 해제되고, 담임에게는 버튼이 없다", async ({ env, openAs, openOtherAs, page }) => {
    await banHong(env);
    const other = await openOtherAs("homeroom01", "/students.html");
    await expect(rosterCard(other, "홍길동").locator(".status-badge--ban")).toHaveText(untilText());
    await expect(rosterCard(other, "홍길동").getByRole("button", { name: "외출 금지 해제" })).toHaveCount(0);

    await openAs("gm01", "/students.html");
    await rosterCard(page, "홍길동").getByRole("button", { name: "외출 금지 해제" }).click();
    await expect(rosterCard(page, "홍길동").locator(".status-badge--ban")).toHaveCount(0);
    await expect(rosterCard(page, "홍길동").getByRole("button", { name: "외출 금지 해제" })).toHaveCount(0);
    const [row] = await env.sql("select ban_from, ban_to, ban_reason from public.students where id = $1", [STUDENT.hong]);
    expect(row).toEqual({ ban_from: null, ban_to: null, ban_reason: null });
  });

  test("체크 화면: 담임은 외출 체크를 못 하고, 학년부장은 확인 창 뒤 외출 처리한다", async ({ env, openAs, openOtherAs, page }) => {
    await banHong(env);
    await openAs("homeroom01", "/check.html");
    await expect(card(page, "홍길동").locator(".ban-chip")).toHaveText(untilText());
    await expect(card(page, "홍길동").getByRole("button", { name: "외출 체크" })).toHaveCount(0);
    await expect(card(page, "홍길동")).toContainText("외출 금지 — 학년부장·관리자만 외출 처리");
    await expect(card(page, "최하늘").getByRole("button", { name: "외출 체크" })).toBeVisible(); // 다른 학생은 그대로

    const gm = await openOtherAs("gm01", "/check.html");
    const dialogs = answerDialogs(gm, [true, "병원", "23:59"]);
    await card(gm, "홍길동").getByRole("button", { name: "외출 체크" }).click();
    await expect(card(gm, "홍길동").locator(".status-badge")).toHaveText("외출중");
    expect(dialogs[0]).toMatchObject({ type: "confirm" });
    expect(dialogs[0].message).toContain("홍길동 학생은 외출 금지 기간입니다");
    expect(dialogs[0].message).toContain("벌점 누적");
  });

  test("학생 화면: 금지 기간에는 신청할 수 없다(서버도 거부)", async ({ env, openAs, page }) => {
    await env.createStudentAccount(STUDENT.hong, "hong123");
    await banHong(env);
    await openAs("hong123", "/student.html");
    await expect(page.locator("#statusBox .ban-chip")).toHaveText(untilText());
    await expect(page.locator("#requestBtn")).toBeDisabled();
    await expect(page.locator("#requestHint")).toContainText("외출 금지 기간입니다");
    const error = await page.evaluate(async () => {
      const { supabase } = await import("/js/supabase-client.js");
      const { error } = await supabase.rpc("create_outing_request", { p_reason: "병원", p_start_time: "23:58", p_expected_return: "23:59" });
      return error && error.message;
    });
    expect(error).toContain("외출 금지 기간입니다");
  });

  test("금지 전에 들어온 신청: 담임에게는 승인 버튼이 없고, 학년부장은 확인 창 뒤 승인한다", async ({ env, openAs, openOtherAs, page }) => {
    const user = await env.createStudentAccount(STUDENT.hong, "hong123");
    await env.sql(
      "insert into public.outing_requests (date, student_id, requested_by, reason, start_time, expected_return) values ($1, $2, $3, '병원', '23:58', '23:59')",
      [todayKst(), STUDENT.hong, user.id]
    );
    await banHong(env);
    await openAs("homeroom01", "/check.html");
    const row = page.locator("#requestList .request-row", { hasText: "홍길동" });
    await expect(row.locator(".ban-chip")).toHaveText(untilText());
    await expect(row.getByRole("button", { name: "승인" })).toHaveCount(0);
    await expect(row).toContainText("학년부장·관리자만 승인");

    const gm = await openOtherAs("gm01", "/check.html");
    answerDialogs(gm, [true]);
    await gm.locator("#requestList .request-row", { hasText: "홍길동" }).getByRole("button", { name: "승인" }).click();
    await expect(gm.locator("#requestList .request-row")).toHaveCount(0);
    const [outing] = await env.sql("select status from public.outings where student_id = $1 and date = $2", [STUDENT.hong, todayKst()]);
    expect(outing.status).toBe("out");
  });

  test("명령퇴사 중인 학생도 체크 화면·좌석 배치판에 외출 금지가 보인다", async ({ env, openAs, page }) => {
    await banHong(env);
    await env.sql("update public.students set leave_from = $2, leave_to = $3 where id = $1", [STUDENT.hong, todayKst(), kstDatePlus(5)]);
    await openAs("admin01", "/check.html");
    await expect(card(page, "홍길동").locator(".ban-chip")).toHaveText(untilText());
    await page.goto("/seat.html");
    await expect(page.locator("#seatGrid .seat-cell", { hasText: "홍길동" }).locator(".seat-cell__ban")).toHaveText(untilText());
  });

  test("좌석 배치판에는 표시되고, 현황판에는 보이지 않는다(학생도 보는 화면)", async ({ env, openAs, page }) => {
    await banHong(env);
    await env.sql("insert into public.outings (date, student_id, status) values ($1, $2, 'away')", [todayKst(), STUDENT.hong]);
    await openAs("admin01", "/display.html");
    await expect(page.locator("#awayPanelList")).toContainText("홍길동");
    await expect(page.locator(".ban-chip")).toHaveCount(0);
    await page.goto("/seat.html");
    await expect(page.locator("#seatGrid .seat-cell", { hasText: "홍길동" }).locator(".seat-cell__ban")).toHaveText(untilText());
  });
});
