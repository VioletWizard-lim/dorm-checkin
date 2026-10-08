import { test, expect } from "./fixtures.mjs";
import { ROOM, STUDENT } from "../harness/seed.mjs";
import { answerDialogs, collectAlerts, kstDatePlus } from "./helpers.mjs";

const rosterNames = (page) => page.locator("#rosterList .student-card .student-name");
const rosterCard = (page, name) => page.locator("#rosterList .student-card", { hasText: name });

async function studentByName(env, name) {
  return (await env.sql("select * from public.students where name = $1", [name]))[0] ?? null;
}

test.describe("학생 명단 관리", () => {
  test("관리자: 학년 탭, 추가(반 자동 계산·방과후 요일), 수정(명령퇴사 기간), 삭제", async ({ env, openAs, page }) => {
    answerDialogs(page, [true]);
    await openAs("admin01", "/students.html");
    await expect(page.locator("#gradeTabs .filter-chip")).toHaveText(["1학년", "2학년", "3학년"]);
    await expect(rosterNames(page)).toHaveText(["김민준", "최하늘", "홍길동"]);

    // 추가
    await page.click("#addStudentBtn");
    await page.fill("#inputName", "정다은");
    await page.fill("#inputSid", "10415");
    await expect(page.locator("#inputCls")).toHaveValue("1학년 4반");
    await page.fill("#inputEmail", "daeun@example.com");
    await page.click("#dayToggleRow >> text=화");
    await page.click("#dayToggleRow >> text=목");
    await page.click("#submitFormBtn");
    await expect(page.locator("#formWrap")).toBeHidden();
    await expect(rosterNames(page)).toHaveText(["김민준", "최하늘", "홍길동", "정다은"]);
    expect(await studentByName(env, "정다은")).toMatchObject({
      grade: 1,
      sid: "10415",
      cls: "1학년 4반",
      email: "daeun@example.com",
      afterschool_days: [false, true, false, true, false],
      leave_from: null,
    });

    // 수정: 명령퇴사 기간 지정
    await rosterCard(page, "정다은").getByRole("button", { name: "수정" }).click();
    await expect(page.locator("#inputName")).toHaveValue("정다은");
    await page.fill("#inputLeaveFrom", kstDatePlus(3));
    await page.fill("#inputLeaveTo", kstDatePlus(10));
    await page.fill("#inputLeaveReason", "가정 사정");
    await page.click("#submitFormBtn");
    await expect(rosterCard(page, "정다은")).toContainText(`명령퇴사 예정: ${kstDatePlus(3)} ~ ${kstDatePlus(10)}`);
    const updated = await studentByName(env, "정다은");
    expect(updated).toMatchObject({ leave_reason: "가정 사정", afterschool_days: [false, true, false, true, false] });

    // 삭제: 좌석표에 앉아 있던 학생이면 그 자리도 비워진다
    await rosterCard(page, "홍길동").getByRole("button", { name: "삭제" }).click();
    await expect(rosterNames(page)).toHaveText(["김민준", "최하늘", "정다은"]);
    expect(await studentByName(env, "홍길동")).toBeNull();
    const room = (await env.sql("select seat_map from public.rooms where id = $1", [ROOM.first]))[0];
    expect(room.seat_map).toEqual({ r0c1: STUDENT.minjun });
  });

  test("명령퇴사 기간 검증", async ({ openAs, page }) => {
    const alerts = collectAlerts(page);
    await openAs("admin01", "/students.html");
    await rosterCard(page, "홍길동").getByRole("button", { name: "수정" }).click();
    await page.fill("#inputLeaveFrom", kstDatePlus(1));
    await page.click("#submitFormBtn");
    await expect.poll(() => alerts.at(-1)).toBe("명령퇴사 기간은 시작일과 종료일을 모두 입력해 주세요.");
    await page.fill("#inputLeaveTo", kstDatePlus(0));
    await page.click("#submitFormBtn");
    await expect.poll(() => alerts.at(-1)).toBe("명령퇴사 종료일은 시작일보다 빠를 수 없습니다.");
    await expect(page.locator("#formWrap")).toBeVisible();
  });

  test("여러 명 한번에 추가", async ({ env, openAs, page }) => {
    await openAs("admin01", "/students.html");
    await page.click("#gradeTabs >> text=2학년");
    await page.click("#bulkAddBtn");
    await page.fill("#bulkInput", "강민서\t20203\tminseo@example.com\n윤도현\t20211\n잘못된줄");
    await expect(page.locator("#bulkPreview .bulk-preview__row")).toHaveCount(2);
    await expect(page.locator("#bulkPreview .bulk-preview__errors")).toContainText("3번째 줄");
    await expect(page.locator("#bulkSaveBtn")).toHaveText("일괄 저장 (2명)");
    await page.click("#bulkSaveBtn");
    await expect(page.locator("#bulkFormWrap")).toBeHidden();
    await expect(rosterNames(page)).toHaveText(["이서연", "강민서", "윤도현"]);
    expect(await studentByName(env, "윤도현")).toMatchObject({ grade: 2, cls: "2학년 2반", email: null });
  });

  test("담임: 담당 반만 보이고, 다른 반으로는 저장할 수 없다", async ({ env, openAs, page }) => {
    const alerts = collectAlerts(page);
    await openAs("homeroom01", "/students.html");
    await expect(page.locator("#gradeTabs .filter-chip")).toHaveText(["1학년"]);
    await expect(rosterNames(page)).toHaveText(["최하늘", "홍길동"]);

    await page.click("#addStudentBtn");
    await expect(page.locator("#inputCls")).toHaveValue("1학년 3반");
    await page.fill("#inputName", "오세훈");
    await page.fill("#inputSid", "10399");
    await page.click("#submitFormBtn");
    await expect(rosterNames(page)).toHaveText(["최하늘", "홍길동", "오세훈"]);

    await rosterCard(page, "오세훈").getByRole("button", { name: "수정" }).click();
    await page.fill("#inputCls", "1학년 1반");
    await page.click("#submitFormBtn");
    await expect.poll(() => alerts.at(-1)).toBe("담당 반(1학년 3반)의 학생만 등록·수정할 수 있습니다.");
    expect((await studentByName(env, "오세훈")).cls).toBe("1학년 3반");

    await page.click("#cancelFormBtn");
    await page.click("#bulkAddBtn");
    await page.fill("#bulkInput", "남궁민\t10120");
    await expect(page.locator("#bulkPreview .bulk-preview__errors")).toContainText("담당 반(1학년 3반)이 아닙니다");
    await expect(page.locator("#bulkSaveBtn")).toBeDisabled();
  });

  test("담임이 화면을 우회해도 서버가 다른 반 학생 쓰기를 막는다", async ({ env, openAs, page }) => {
    await openAs("homeroom01", "/students.html");
    await expect(rosterNames(page)).toHaveText(["최하늘", "홍길동"]);
    const result = await page.evaluate(async (minjunId) => {
      const { supabase } = await import("/js/supabase-client.js");
      const insert = await supabase.from("students").insert({ grade: 1, name: "몰래", sid: "10199", cls: "1학년 1반" });
      const update = await supabase.from("students").update({ name: "바뀜" }).eq("id", minjunId).select("id");
      return { insertCode: insert.error && insert.error.code, updatedRows: update.data && update.data.length };
    }, STUDENT.minjun);
    expect(result).toEqual({ insertCode: "42501", updatedRows: 0 });
    expect(await studentByName(env, "몰래")).toBeNull();
    expect((await env.sql("select name from public.students where id = $1", [STUDENT.minjun]))[0].name).toBe("김민준");
  });

  test("학년부장은 담당 학년 탭만 보인다", async ({ openAs, page }) => {
    await openAs("gm01", "/students.html");
    await expect(page.locator("#gradeTabs .filter-chip")).toHaveText(["1학년"]);
    await expect(rosterNames(page)).toHaveText(["김민준", "최하늘", "홍길동"]);
  });
});
