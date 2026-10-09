import { test, expect } from "./fixtures.mjs";
import { STUDENT } from "../harness/seed.mjs";
import { answerDialogs, todayKst } from "./helpers.mjs";

async function afterschoolDates(env) {
  return (await env.sql("select to_char(date, 'YYYY-MM-DD') as d from public.afterschool_dates order by date")).map((r) => r.d);
}

async function days(env, id) {
  return (await env.sql("select afterschool_days from public.students where id = $1", [id]))[0].afterschool_days;
}

test.describe("방과후 일정(관리자)", () => {
  test("달력에서 날짜를 눌러 방과후 있는 날을 선택·해제한다", async ({ env, openAs, page }) => {
    await openAs("admin01", "/afterschool.html");
    const todayBtn = page.locator(`#calendar [data-date="${todayKst()}"]`);
    await expect(todayBtn).toHaveClass(/is-on/); // 기본 데이터: 오늘은 방과후 있는 날
    await expect(page.locator("#monthCount")).toHaveText("이 달 방과후 1일");

    await todayBtn.click();
    await expect(todayBtn).not.toHaveClass(/is-on/);
    expect(await afterschoolDates(env)).toEqual([]);

    await todayBtn.click();
    await expect(todayBtn).toHaveClass(/is-on/);
    expect(await afterschoolDates(env)).toEqual([todayKst()]);
  });

  test("기간·요일로 한 번에 선택하고 해제한다", async ({ env, openAs, page }) => {
    answerDialogs(page, [true]);
    await openAs("admin01", "/afterschool.html");
    await page.fill("#rangeFrom", "2027-03-01");
    await page.fill("#rangeTo", "2027-03-31");
    await page.click("#rangeDays >> text=화"); // 월·수·금만
    await page.click("#rangeDays >> text=목");
    await page.click("#rangeSetBtn");
    const expected = [];
    for (let d = 1; d <= 31; d++) {
      const date = new Date(Date.UTC(2027, 2, d));
      if ([1, 3, 5].includes(date.getUTCDay())) expected.push(`2027-03-${String(d).padStart(2, "0")}`);
    }
    await expect.poll(async () => (await afterschoolDates(env)).filter((d) => d.startsWith("2027-03"))).toEqual(expected);

    // 그 달로 가 보면 달력에도 표시된다
    for (let i = 0; i < 24 && !(await page.locator("#monthTitle").textContent()).includes("2027년 3월"); i++) {
      await page.click("#nextMonthBtn");
    }
    await expect(page.locator("#monthCount")).toHaveText(`이 달 방과후 ${expected.length}일`);
    await expect(page.locator('#calendar [data-date="2027-03-03"]')).toHaveClass(/is-on/);
    await expect(page.locator('#calendar [data-date="2027-03-02"]')).not.toHaveClass(/is-on/);

    // 해제(확인 창 한 번)
    await page.click("#rangeClearBtn");
    await expect.poll(async () => (await afterschoolDates(env)).filter((d) => d.startsWith("2027-03"))).toEqual([]);
  });

  test("요일을 고르고 학번을 붙여넣으면 그 학생들의 그 요일이 켜진다", async ({ env, openAs, page }) => {
    const dialogs = answerDialogs(page, [true, true, true]);
    await openAs("admin01", "/afterschool.html");
    await page.click("#weekdayDays >> text=화");
    await page.click("#weekdayDays >> text=목");
    await page.fill("#weekdayInput", "10101 김민준\n10302\n10305\n99999");
    const preview = page.locator("#weekdayPreview");
    await expect(preview.locator(".bulk-preview__summary")).toHaveText("켜기 2명 · 이미 켜짐 1명");
    await expect(preview).toContainText("김민준 · 10101 · 1학년 1반 — 없음 → 화·목");
    await expect(preview).toContainText("홍길동 · 10305 · 1학년 3반 — 월·화·수·목·금 (그대로)");
    await expect(preview.locator(".bulk-preview__errors")).toContainText("학번 99999 학생이 명단에 없습니다");
    await expect(page.locator("#weekdaySaveBtn")).toHaveText("저장 (2명)");
    await page.click("#weekdaySaveBtn");
    await expect(page.locator("#weekdayInput")).toHaveValue("");
    expect(await days(env, STUDENT.minjun)).toEqual([false, true, false, true, false]);
    expect(await days(env, STUDENT.haneul)).toEqual([false, true, false, true, false]);
    expect(await days(env, STUDENT.hong)).toEqual([true, true, true, true, true]);

    // 화요일 명단을 김민준 한 명으로 통째로 바꾸면 다른 학생의 화요일은 꺼진다(확인 창 한 번)
    await page.click("#weekdayDays >> text=목"); // 화만
    await page.fill("#weekdayInput", "10101");
    await page.check("#weekdayReplace");
    await expect(preview.locator(".bulk-preview__summary")).toHaveText("켜기 0명 · 이미 켜짐 1명 · 끄기 2명");
    await expect(preview).toContainText("최하늘 · 10302 · 1학년 3반 — 화·목 → 목");
    await page.click("#weekdaySaveBtn");
    await expect(page.locator("#weekdayInput")).toHaveValue("");
    expect(dialogs.some((d) => d.type === "confirm" && d.message.includes("목록에 없는 2명은 화요일 방과후가 꺼집니다"))).toBe(true);
    expect(await days(env, STUDENT.minjun)).toEqual([false, true, false, true, false]);
    expect(await days(env, STUDENT.haneul)).toEqual([false, false, false, true, false]);
    expect(await days(env, STUDENT.hong)).toEqual([true, false, true, true, true]);
  });

  test("학생별 방과후 요일을 붙여넣어 한 번에 저장한다", async ({ env, openAs, page }) => {
    await openAs("admin01", "/afterschool.html");
    await page.fill(
      "#daysInput",
      ["10305\t없음", "김민준\t10101\t월수금", "20101\tO\tX\tO\tX\tO", "10302 화 목", "99999\t월", "30202\t토"].join("\n")
    );
    const rows = page.locator("#daysPreview .bulk-preview__row");
    await expect(rows).toHaveCount(4);
    await expect(rows.nth(0)).toContainText("홍길동 · 10305");
    await expect(rows.nth(0)).toContainText("월·화·수·목·금 → 없음");
    await expect(rows.nth(1)).toContainText("없음 → 월·수·금");
    await expect(page.locator("#daysPreview .bulk-preview__errors")).toContainText("99999 학생이 명단에 없습니다");
    await expect(page.locator("#daysPreview .bulk-preview__errors")).toContainText("월~금만");
    await expect(page.locator("#daysSaveBtn")).toHaveText("일괄 저장 (4명)");
    page.once("dialog", (d) => d.accept());
    await page.click("#daysSaveBtn");
    await expect(page.locator("#daysInput")).toHaveValue("");
    expect(await days(env, STUDENT.hong)).toEqual([false, false, false, false, false]);
    expect(await days(env, STUDENT.minjun)).toEqual([true, false, true, false, true]);
    expect(await days(env, STUDENT.seoyeon)).toEqual([true, false, true, false, true]);
    expect(await days(env, STUDENT.haneul)).toEqual([false, true, false, true, false]);
  });

  test("관리자가 아니면 들어올 수 없고 서버도 방과후 날짜를 못 바꾼다", async ({ env, openAs, page }) => {
    await openAs("gm01", "/afterschool.html");
    await expect(page).toHaveURL(/check\.html$/);
    const error = await page.evaluate(async () => {
      const { supabase } = await import("/js/supabase-client.js");
      const { error } = await supabase.from("afterschool_dates").insert({ date: "2027-01-04" });
      return error && error.message;
    });
    expect(error).toContain("row-level security");
    expect(await afterschoolDates(env)).toEqual([todayKst()]);
  });

  test("방과후 선생님은 방과후 일정 화면만 쓰고, 방과후 날짜·요일만 바꿀 수 있다", async ({ env, openAs, page }) => {
    await env.createStaffAccount("after01", "afterschoolTeacher", "방과후담당");
    await openAs("after01", "/check.html");
    await expect(page).toHaveURL(/afterschool\.html$/); // 다른 화면은 방과후 일정으로
    await expect(page.locator("#currentUserRoleBadge")).toHaveText("afterschoolTeacher");
    await expect(page.locator("[data-admin-link]:visible")).toHaveCount(0);
    await expect(page.locator("#logoutBtn")).toBeVisible();
    for (const target of ["display.html", "seat.html", "students.html", "history.html", "accounts.html"]) {
      await page.goto(`/${target}`);
      await expect(page).toHaveURL(/afterschool\.html$/);
    }

    // 방과후 있는 날 해제
    const todayBtn = page.locator(`#calendar [data-date="${todayKst()}"]`);
    await todayBtn.click();
    await expect(todayBtn).not.toHaveClass(/is-on/);
    expect(await afterschoolDates(env)).toEqual([]);

    // 요일별 등록
    await page.click("#weekdayDays >> text=월");
    await page.fill("#weekdayInput", "20101");
    page.once("dialog", (d) => d.accept());
    await page.click("#weekdaySaveBtn");
    await expect(page.locator("#weekdayInput")).toHaveValue("");
    expect(await days(env, STUDENT.seoyeon)).toEqual([true, false, false, false, false]);

    // 서버: 방과후 요일 말고 다른 칸·외출 기록은 못 바꾼다
    const errors = await page.evaluate(async (id) => {
      const { supabase } = await import("/js/supabase-client.js");
      const a = await supabase.from("students").update({ name: "바꿈" }).eq("id", id).select("id");
      const b = await supabase.from("outings").insert({ date: new Date().toISOString().slice(0, 10), student_id: id, status: "away" });
      return [a.error && a.error.message, b.error && b.error.message];
    }, STUDENT.seoyeon);
    expect(errors[0]).toContain("방과후 요일만");
    expect(errors[1]).toContain("row-level security");
  });
});
