import { assertEquals, assertMatch } from "jsr:@std/assert@1";
import { normalizeStaffId, normalizeStudentId, randomPassword, randomPin, staffEmail, studentEmail } from "./accounts.ts";
import { getServiceKey } from "./supabase.ts";

Deno.test("staff ids are lowercase letters and digits only", () => {
  assertEquals(normalizeStaffId(" Kim01 "), "kim01");
  assertEquals(normalizeStaffId("kim.01"), null);
  assertEquals(normalizeStaffId(""), null);
  assertEquals(staffEmail("kim01"), "kim01@donghall.local");
});

Deno.test("student ids also allow dot, underscore and hyphen", () => {
  assertEquals(normalizeStudentId("Hong.Gil_dong-1"), "hong.gil_dong-1");
  assertEquals(normalizeStudentId("hong gil"), null);
  assertEquals(normalizeStudentId("홍길동"), null);
  assertEquals(studentEmail("hong"), "hong@student.donghall.local");
});

Deno.test("generated passwords use the unambiguous alphabet", () => {
  assertMatch(randomPassword(8), /^[ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789]{8}$/);
  assertEquals(randomPassword(4, () => new Uint32Array([0, 1, 53, 54])), "AB9A");
});

Deno.test("student pins are 6 digits", () => {
  assertMatch(randomPin(), /^[0-9]{6}$/);
  assertEquals(randomPin(6, () => new Uint32Array([10, 11, 12, 13, 14, 19])), "012349");
});

Deno.test("service key prefers the new secret keys and falls back to the legacy key", () => {
  const env = (vars: Record<string, string>) => ({ get: (k: string) => vars[k] });
  assertEquals(getServiceKey(env({ SUPABASE_SECRET_KEYS: '{"default":"sb_secret_x"}', SUPABASE_SERVICE_ROLE_KEY: "legacy" })), "sb_secret_x");
  assertEquals(getServiceKey(env({ SUPABASE_SECRET_KEYS: "not json", SUPABASE_SERVICE_ROLE_KEY: "legacy" })), "legacy");
  assertEquals(getServiceKey(env({ SUPABASE_SERVICE_ROLE_KEY: "legacy" })), "legacy");
});
