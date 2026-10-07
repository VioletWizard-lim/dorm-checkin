import { defineConfig } from "@playwright/test";

// 환경(Postgres·PostgREST·Edge Function)을 워커 하나에서 한 번만 띄우므로 순서대로 실행한다.
export default defineConfig({
  testDir: "./specs",
  testMatch: "*.spec.mjs",
  workers: 1,
  fullyParallel: false,
  timeout: 45_000,
  expect: { timeout: 8_000 },
  reporter: process.env.CI ? [["list"], ["github"]] : [["list"]],
  outputDir: "./test-results",
  use: {
    baseURL: "http://dorm.test",
    browserName: "chromium",
    // 학교(한국) 기준 날짜로 동작하는지 보기 위해 브라우저 시간대를 서울로 둔다.
    timezoneId: "Asia/Seoul",
    locale: "ko-KR",
    viewport: { width: 1280, height: 900 },
    trace: "retain-on-failure",
  },
});
