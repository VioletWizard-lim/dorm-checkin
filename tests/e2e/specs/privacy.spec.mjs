import { test, expect } from "./fixtures.mjs";

// 학생 아이디·연락처·이메일은 담당 범위 교직원에게만(사용자 요청 — 예전에는 교직원이면 F12로 전교생 연락처가 보였음).
// 화면이 받는 응답(F12 → Network에 보이는 것)에 그 값이 없는지 본다.
const CONTACT_VALUES = ["01011112222", "01033334444", "hong@example.com", "hong123", "seoyeon.lee", "jihun_p"];

function collectStudentResponses(page) {
  const bodies = [];
  page.on("response", async (res) => {
    if (/\/rest\/v1\/(students|rpc\/student_contacts|profiles)/.test(res.url())) {
      bodies.push(await res.text().catch(() => ""));
    }
  });
  return bodies;
}

const studentCard = (page, name) => page.locator("#studentList .student-card", { hasText: name });
const rosterCard = (page, name) => page.locator("#rosterList .student-card", { hasText: name });

test.describe("학생 개인정보", () => {
  for (const loginId of ["super01", "dorm01", "teacher01"]) {
    test(`${loginId}: 체크 화면 응답에 학생 아이디·연락처·이메일이 없다`, async ({ openAs, page }) => {
      const bodies = collectStudentResponses(page);
      await openAs(loginId, "/check.html");
      await expect(studentCard(page, "홍길동")).toBeVisible();
      const all = bodies.join("\n");
      expect(all).toContain("홍길동");
      for (const value of CONTACT_VALUES) expect(all).not.toContain(value);
    });
  }

  test("담임은 담당 반 학생의 연락처만 받는다(수정 폼에 그대로 보임)", async ({ openAs, page }) => {
    const bodies = collectStudentResponses(page);
    await openAs("homeroom01", "/students.html");
    await rosterCard(page, "홍길동").getByRole("button", { name: "수정" }).click();
    await expect(page.locator("#inputLoginId")).toHaveValue("hong123");
    await expect(page.locator("#inputPhone")).toHaveValue("010-1111-2222");
    await expect(page.locator("#inputParentPhone")).toHaveValue("010-3333-4444");
    await expect(page.locator("#inputEmail")).toHaveValue("hong@example.com");
    const all = bodies.join("\n");
    expect(all).toContain("hong123");
    for (const value of ["seoyeon.lee", "jihun_p"]) expect(all).not.toContain(value); // 다른 반
  });

  test("기숙사부는 학생 명단 화면에서도 연락처를 받지 않는다", async ({ openAs, page }) => {
    const bodies = collectStudentResponses(page);
    await openAs("dorm01", "/students.html");
    await expect(rosterCard(page, "홍길동")).toBeVisible();
    const all = bodies.join("\n");
    for (const value of CONTACT_VALUES) expect(all).not.toContain(value);
  });
});
