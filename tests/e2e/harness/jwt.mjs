// HS256 JWT 서명·검증(PostgREST가 같은 비밀값으로 검증한다).
import { createHmac, timingSafeEqual } from "node:crypto";

const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");

export function signJwt(payload, secret) {
  const head = `${encode({ alg: "HS256", typ: "JWT" })}.${encode(payload)}`;
  const signature = createHmac("sha256", secret).update(head).digest("base64url");
  return `${head}.${signature}`;
}

// 서명이 맞고 만료되지 않았으면 payload, 아니면 null
export function verifyJwt(token, secret) {
  const parts = String(token ?? "").split(".");
  if (parts.length !== 3) return null;
  const expected = createHmac("sha256", secret).update(`${parts[0]}.${parts[1]}`).digest();
  const actual = Buffer.from(parts[2], "base64url");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (payload.exp && payload.exp * 1000 < Date.now()) return null;
  return payload;
}
