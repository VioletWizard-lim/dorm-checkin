import { readFileSync } from "node:fs";
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
    await expect(preview.locator(".bulk-preview__summary")).toHaveText("추가 2명 · 이미 등록 1명");
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
    await expect(preview.locator(".bulk-preview__summary")).toHaveText("추가 0명 · 이미 등록 1명 · 이 요일에서 빼기 2명");
    await expect(preview).toContainText("최하늘 · 10302 · 1학년 3반 — 화·목 → 목");
    await page.click("#weekdaySaveBtn");
    await expect(page.locator("#weekdayInput")).toHaveValue("");
    expect(dialogs.some((d) => d.type === "confirm" && d.message.includes("불러온 목록에 없는 2명은 화요일 방과후에서 빠집니다"))).toBe(true);
    expect(await days(env, STUDENT.minjun)).toEqual([false, true, false, true, false]);
    expect(await days(env, STUDENT.haneul)).toEqual([false, false, false, true, false]);
    expect(await days(env, STUDENT.hong)).toEqual([true, false, true, true, true]);
  });

  test("빼기: 잘못 넣은 출석부를 다시 불러와 그 요일에서 뺀다(다른 요일은 그대로)", async ({ env, openAs, page }) => {
    const dialogs = answerDialogs(page, [true, true]);
    await openAs("admin01", "/afterschool.html");
    await page.click("#weekdayDays >> text=수");
    await page.fill("#weekdayInput", "10305\n10101");
    await page.check("#weekdayRemove");
    const preview = page.locator("#weekdayPreview");
    await expect(preview.locator(".bulk-preview__summary")).toHaveText("이 요일에서 빼기 1명 · 원래 없음 1명");
    await expect(preview).toContainText("홍길동 · 10305 · 1학년 3반 — 월·화·수·목·금 → 월·화·목·금");
    await expect(page.locator("#weekdaySaveBtn")).toHaveText("저장 (1명)");
    await page.click("#weekdaySaveBtn");
    await expect(page.locator("#weekdayInput")).toHaveValue("");
    expect(dialogs.some((d) => d.type === "confirm" && d.message.includes("불러온 학생 1명을 수요일 방과후에서 뺍니다"))).toBe(true);
    expect(await days(env, STUDENT.hong)).toEqual([true, true, false, true, true]);
    expect(await days(env, STUDENT.minjun)).toEqual([false, false, false, false, false]);
  });

  test("방과후 출석부 파일(xlsx)을 불러오면 명단을 찾아 그 요일을 켜고, 현재 명단을 CSV로 받는다", async ({ env, openAs, page }) => {
    answerDialogs(page, [true]);
    await openAs("admin01", "/afterschool.html");
    await page.click("#weekdayDays >> text=수");
    // 시트 1: 제목 줄 + "번호(연번)·학년·반·번호·이름" 머리글, 시트 2: "학번·이름" 머리글
    await page.setInputFiles("#weekdayFile", new URL("../fixtures/afterschool-attendance.xlsx", import.meta.url).pathname);
    await expect(page.locator("#weekdayFileNote")).toHaveText("afterschool-attendance.xlsx에서 8줄을 읽었습니다.");
    const preview = page.locator("#weekdayPreview");
    await expect(preview.locator(".bulk-preview__summary")).toHaveText("추가 3명 · 이미 등록 1명");
    await expect(preview).toContainText("이서연 · 20101 · 2학년 1반 — 없음 → 수");
    await expect(preview).toContainText("최하늘 · 10302");
    await expect(preview.locator(".bulk-preview__errors")).toContainText("학번 30909(없는학생) 학생이 명단에 없습니다");
    await page.click("#weekdaySaveBtn");
    await expect(page.locator("#weekdayInput")).toHaveValue("");
    expect(await days(env, STUDENT.minjun)).toEqual([false, false, true, false, false]);
    expect(await days(env, STUDENT.seoyeon)).toEqual([false, false, true, false, false]);
    expect(await days(env, STUDENT.haneul)).toEqual([false, false, true, false, false]);

    await expect(page.locator("#weekdayRosterBtn")).toHaveText("수요일 현재 명단 받기 (CSV, 4명)");
    const [download] = await Promise.all([page.waitForEvent("download"), page.click("#weekdayRosterBtn")]);
    const csv = readFileSync(await download.path(), "utf8").replace(/^\uFEFF/, "").split("\r\n");
    expect(csv[0]).toBe("학번,이름,반,월,화,수,목,금");
    expect(csv.slice(1)).toEqual([
      "10101,김민준,1학년 1반,,,O,,",
      "10302,최하늘,1학년 3반,,,O,,",
      "10305,홍길동,1학년 3반,O,O,O,O,O",
      "20101,이서연,2학년 1반,,,O,,",
    ]);
  });

  test("PDF 출석부(엑셀·한글에서 PDF로 저장한 것)도 글자 위치로 표를 맞춰 명단을 찾는다", async ({ env, openAs, page }) => {
    await openAs("admin01", "/afterschool.html");
    await page.click("#weekdayDays >> text=목");
    // 제목 줄 + "번호(연번)·학년·반·번호·성명·비고·날짜" 머리글, 비고·날짜 칸이 비어 있는 줄도 있음
    await page.setInputFiles("#weekdayFile", new URL("../fixtures/afterschool-attendance.pdf", import.meta.url).pathname);
    await expect(page.locator("#weekdayFileNote")).toHaveText(/^afterschool-attendance\.pdf에서 \d+줄을 읽었습니다\.$/);
    const preview = page.locator("#weekdayPreview");
    await expect(preview.locator(".bulk-preview__summary")).toHaveText("추가 3명 · 이미 등록 1명");
    await expect(preview).toContainText("김민준 · 10101 · 1학년 1반 — 없음 → 목");
    await expect(preview).toContainText("이서연 · 20101");
    await expect(preview).toContainText("최하늘 · 10302");
    await expect(preview.locator(".bulk-preview__errors")).toHaveText("7번째 줄: 학번 30909(없는학생) 학생이 명단에 없습니다.");
    await page.click("#weekdaySaveBtn");
    await expect(page.locator("#weekdayInput")).toHaveValue("");
    expect(await days(env, STUDENT.minjun)).toEqual([false, false, false, true, false]);
  });

  test("양식이 달라도 자동으로: 칸 이름 비슷한 말, 1-3-5·1학년 3반 5번 모양, 머리글 없는 이름", async ({ openAs, page }) => {
    await openAs("admin01", "/afterschool.html");
    await page.click("#weekdayDays >> text=화");
    const preview = page.locator("#weekdayPreview");
    // 머리글: "학년반번호" 한 칸, "성 명(한글)" — 띄어쓰기·괄호 무시
    await page.fill("#weekdayInput", ["연번\t학년반번호\t성 명(한글)", "1\t1-3-5\t홍길동", "2\t1학년 1반 1번\t김민준", "3\t2.01.01\t이서연", "4\t1302\t최하늘"].join("\n"));
    await expect(preview.locator(".bulk-preview__summary")).toHaveText("추가 3명 · 이미 등록 1명");
    await expect(preview).toContainText("최하늘 · 10302"); // 학년반번호 칸의 네 자리(1302)
    await expect(page.locator("#columnMapStatus")).toHaveText("지금: 자동으로 찾는 중");
    // 머리글 없이 이름만(띄어쓴 이름도) + "1학년 3반 2번" 모양
    await page.fill("#weekdayInput", "김 민준\n이서연 (2학년)\n1학년 3반 2번 최하늘");
    await expect(preview.locator(".bulk-preview__summary")).toHaveText("추가 2명");
    await expect(preview).toContainText("김민준 · 10101");
    await expect(preview).toContainText("최하늘 · 10302");
  });

  test("요일 자동: 요일을 안 골랐으면 출석부의 요일 글자·날짜로 고르고, 이미 골랐으면 안내와 바꾸기 버튼만", async ({ openAs, page }) => {
    await openAs("admin01", "/afterschool.html");
    const active = page.locator("#weekdayDays .day-toggle.is-active");
    const note = page.locator("#weekdayDetectNote");
    // 제목 "(코딩반 · 월)" → 월
    await page.setInputFiles("#weekdayFile", new URL("../fixtures/afterschool-attendance.xlsx", import.meta.url).pathname);
    await expect(active).toHaveText(["월"]);
    await expect(note).toHaveText("출석부 글자에서 요일을 찾아 월을(를) 골랐습니다. 맞는지 확인하세요.");
    await expect(page.locator("#weekdayPreview .bulk-preview__summary")).toHaveText("추가 3명 · 이미 등록 1명");

    // 날짜 칸만 있으면 날짜의 요일로(2026-10-06·13은 화요일) — 요일을 비운 뒤 새 표
    await page.click("#weekdayDays >> text=월");
    await page.fill("#weekdayInput", "번호\t이름\t2026-10-06\t2026-10-13\n1\t홍길동\tO\tO");
    await expect(active).toHaveText(["화"]);
    await expect(note).toContainText("출석 날짜에서 요일을 찾아 화을(를) 골랐습니다");

    // 이미 다른 요일(수)을 골라 둔 상태면 바꾸지 않고 안내 → [월요일로 바꾸기]
    await page.click("#weekdayDays >> text=화");
    await page.click("#weekdayDays >> text=수");
    await page.fill("#weekdayInput", "방과후 코딩반 출석부 (월)\n학번\t이름\n10101\t김민준");
    await expect(active).toHaveText(["수"]);
    await expect(note).toContainText("출석부에는 월요일로 보입니다(지금 고른 요일: 수)");
    await note.getByRole("button", { name: "월요일로 바꾸기" }).click();
    await expect(active).toHaveText(["월"]);
    await expect(page.locator("#weekdayPreview")).toContainText("김민준 · 10101 · 1학년 1반 — 없음 → 월");
  });

  test("칸 직접 고르기: 자동으로 못 찾으면 펼쳐지고, 고른 칸으로 찾으며, 같은 양식은 기억한다", async ({ env, openAs, page }) => {
    answerDialogs(page, [true]);
    await openAs("admin01", "/afterschool.html");
    await page.click("#weekdayDays >> text=금");
    const table = "가\t1\t3\t5\n나\t1\t1\t1";
    await page.fill("#weekdayInput", table);
    const preview = page.locator("#weekdayPreview");
    await expect(preview.locator(".bulk-preview__errors")).toContainText("칸 직접 고르기");
    await expect(page.locator("#columnMapWrap")).toHaveAttribute("open", "");
    const selects = page.locator("#columnMapTable [data-col-role]");
    await expect(selects).toHaveCount(4);
    await selects.nth(1).selectOption("grade");
    await selects.nth(2).selectOption("cls");
    await selects.nth(3).selectOption("num");
    await expect(page.locator("#columnMapStatus")).toHaveText("지금: 고른 칸으로 찾는 중");
    await expect(preview.locator(".bulk-preview__summary")).toHaveText("추가 1명 · 이미 등록 1명");
    await page.click("#weekdaySaveBtn");
    await expect(page.locator("#weekdayInput")).toHaveValue("");
    expect(await days(env, STUDENT.minjun)).toEqual([false, false, false, false, true]);

    // 같은 양식을 다시 넣으면 고른 칸을 기억해서 쓴다 → 자동으로 되돌리기
    await page.fill("#weekdayInput", table);
    await expect(page.locator("#columnMapStatus")).toHaveText("지금: 지난번에 이 양식에서 고른 칸으로 찾는 중");
    await expect(preview.locator(".bulk-preview__summary")).toHaveText("추가 0명 · 이미 등록 2명");
    await page.click("#columnMapResetBtn");
    await expect(page.locator("#columnMapStatus")).toHaveText("지금: 자동으로 찾는 중");
    await expect(preview.locator(".bulk-preview__summary")).toHaveCount(0);
  });

  test("이름만 있는 출석부(CSV)도 이름으로 찾는다", async ({ openAs, page }) => {
    await openAs("admin01", "/afterschool.html");
    await page.click("#weekdayDays >> text=금");
    await page.setInputFiles("#weekdayFile", { name: "roster.csv", mimeType: "text/csv", buffer: Buffer.from("성명,비고\n최하늘,\n김민준,\n홍길순,") });
    const preview = page.locator("#weekdayPreview");
    await expect(preview.locator(".bulk-preview__summary")).toHaveText("추가 2명");
    await expect(preview.locator(".bulk-preview__errors")).toContainText("홍길순 학생이 명단에 없습니다");
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
