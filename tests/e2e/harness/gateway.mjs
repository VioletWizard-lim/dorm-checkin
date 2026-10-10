// 가짜 Supabase 게이트웨이: https://<project>.supabase.co 로 가는 요청을 받아
//   /auth/v1/*      → Supabase Auth(GoTrue) 흉내(아래 AuthStore)
//   /rest/v1/*      → 로컬 PostgREST(실제 RLS가 적용되는 Postgres)
//   /functions/v1/* → 로컬에서 Deno로 띄운 실제 Edge Function
// 브라우저 요청은 Playwright route로, Edge Function의 요청은 HTTP 서버로 들어온다.
import { createServer } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { signJwt, verifyJwt } from "./jwt.mjs";

export const JWT_SECRET = "e2e-only-jwt-secret-0123456789abcdef";
export const SECRET_KEY = "sb_secret_e2e_only";

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "*",
  "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  "access-control-expose-headers": "content-range, content-profile, preference-applied, x-supabase-api-version",
};

const json = (status, body, extra = {}) => ({
  status,
  headers: { ...CORS_HEADERS, "content-type": "application/json", ...extra },
  body: Buffer.from(JSON.stringify(body)),
});

class AuthError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// GoTrue 흉내. 사용자는 auth.users(외래키 대상)와 메모리(비밀번호·차단 여부) 양쪽에 둔다.
export class AuthStore {
  constructor(pool) {
    this.pool = pool;
    this.users = new Map();
    this.refreshTokens = new Map();
  }

  findByEmail(email) {
    const target = String(email ?? "").toLowerCase();
    return [...this.users.values()].find((u) => u.email === target) ?? null;
  }

  async createUser({ id = randomUUID(), email, password, app_metadata = {}, user_metadata = {} }) {
    const normalized = String(email ?? "").toLowerCase();
    if (!normalized.includes("@")) throw new AuthError(400, "validation_failed", "Unable to validate email address");
    if (this.findByEmail(normalized)) {
      throw new AuthError(422, "email_exists", "A user with this email address has already been registered");
    }
    if (String(password ?? "").length < 6) {
      throw new AuthError(422, "weak_password", "Password should be at least 6 characters.");
    }
    await this.pool.query("insert into auth.users (id, email) values ($1, $2)", [id, normalized]);
    const now = new Date().toISOString();
    const user = { id, email: normalized, password, app_metadata, user_metadata, bannedUntil: null, created_at: now, updated_at: now };
    this.users.set(id, user);
    return user;
  }

  async updateUser(id, attrs) {
    const user = this.users.get(id);
    if (!user) throw new AuthError(404, "user_not_found", "User not found");
    if (typeof attrs.password === "string") {
      if (attrs.password.length < 6) throw new AuthError(422, "weak_password", "Password should be at least 6 characters.");
      user.password = attrs.password;
    }
    // 관리자 API는 user_metadata, 본인 수정(PUT /user)은 data — GoTrue처럼 기존 값에 합친다
    const metadata = attrs.user_metadata ?? attrs.data;
    if (metadata && typeof metadata === "object") user.user_metadata = { ...user.user_metadata, ...metadata };
    if (typeof attrs.ban_duration === "string") {
      user.bannedUntil = attrs.ban_duration === "none" ? null : new Date(Date.now() + 100 * 365 * 24 * 3600 * 1000);
      // 차단하면 그 사용자의 리프레시 토큰을 모두 끊는다.
      if (user.bannedUntil) {
        for (const [token, userId] of this.refreshTokens) if (userId === id) this.refreshTokens.delete(token);
      }
    }
    user.updated_at = new Date().toISOString();
    return user;
  }

  async deleteUser(id) {
    const user = this.users.get(id);
    if (!user) throw new AuthError(404, "user_not_found", "User not found");
    await this.pool.query("delete from auth.users where id = $1", [id]);
    this.users.delete(id);
    return user;
  }

  async clear() {
    await this.pool.query("delete from auth.users");
    this.users.clear();
    this.refreshTokens.clear();
  }

  isBanned(user) {
    return Boolean(user.bannedUntil && user.bannedUntil.getTime() > Date.now());
  }

  userJson(user) {
    return {
      id: user.id,
      aud: "authenticated",
      role: "authenticated",
      email: user.email,
      email_confirmed_at: user.created_at,
      phone: "",
      app_metadata: { provider: "email", providers: ["email"], ...user.app_metadata },
      user_metadata: user.user_metadata ?? {},
      identities: [],
      created_at: user.created_at,
      updated_at: user.updated_at,
      banned_until: user.bannedUntil ? user.bannedUntil.toISOString() : undefined,
    };
  }

  issueSession(user, lifetimeSeconds = 3600) {
    const now = Math.floor(Date.now() / 1000);
    const accessToken = signJwt(
      {
        sub: user.id,
        aud: "authenticated",
        role: "authenticated",
        email: user.email,
        iat: now,
        exp: now + lifetimeSeconds,
        session_id: randomUUID(),
        app_metadata: user.app_metadata,
      },
      JWT_SECRET
    );
    const refreshToken = randomBytes(16).toString("hex");
    this.refreshTokens.set(refreshToken, user.id);
    return {
      access_token: accessToken,
      token_type: "bearer",
      expires_in: lifetimeSeconds,
      expires_at: now + lifetimeSeconds,
      refresh_token: refreshToken,
      user: this.userJson(user),
    };
  }
}

const serviceJwt = signJwt({ role: "service_role", iss: "e2e" }, JWT_SECRET);
const anonJwt = signJwt({ role: "anon", iss: "e2e" }, JWT_SECRET);

function bearerOf(headers) {
  return String(headers.authorization ?? "").replace(/^Bearer\s+/i, "").trim();
}

function isServiceCall(headers) {
  const bearer = bearerOf(headers);
  if (headers.apikey === SECRET_KEY || bearer === SECRET_KEY) return true;
  const claims = verifyJwt(bearer, JWT_SECRET);
  return claims?.role === "service_role";
}

function parseBody(body) {
  if (!body || body.length === 0) return {};
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    return {};
  }
}

export function createGateway({ auth, postgrestUrl, functionUrls }) {
  const stats = { requests: [] };

  async function handleAuth(method, path, search, headers, body) {
    const params = new URLSearchParams(search);
    const apiHeaders = { "x-supabase-api-version": "2024-01-01" };
    try {
      if (method === "POST" && path === "/auth/v1/token") {
        const input = parseBody(body);
        const grant = params.get("grant_type");
        if (grant === "password") {
          const user = auth.findByEmail(input.email);
          if (!user || user.password !== input.password) {
            throw new AuthError(400, "invalid_credentials", "Invalid login credentials");
          }
          if (auth.isBanned(user)) throw new AuthError(400, "user_banned", "User is banned");
          return json(200, auth.issueSession(user), apiHeaders);
        }
        if (grant === "refresh_token") {
          const userId = auth.refreshTokens.get(input.refresh_token);
          const user = userId ? auth.users.get(userId) : null;
          if (!user) throw new AuthError(400, "refresh_token_not_found", "Invalid Refresh Token: Refresh Token Not Found");
          if (auth.isBanned(user)) throw new AuthError(400, "user_banned", "User is banned");
          auth.refreshTokens.delete(input.refresh_token);
          return json(200, auth.issueSession(user), apiHeaders);
        }
        throw new AuthError(400, "validation_failed", "unsupported grant_type");
      }

      if (method === "GET" && path === "/auth/v1/user") {
        const claims = verifyJwt(bearerOf(headers), JWT_SECRET);
        const user = claims?.sub ? auth.users.get(claims.sub) : null;
        if (!claims) throw new AuthError(401, "bad_jwt", "invalid JWT");
        if (!user) throw new AuthError(403, "user_not_found", "User from sub claim in JWT does not exist");
        return json(200, auth.userJson(user), apiHeaders);
      }

      // 본인 정보 수정(supabase.auth.updateUser) — 비밀번호·user_metadata(data)
      if (method === "PUT" && path === "/auth/v1/user") {
        const claims = verifyJwt(bearerOf(headers), JWT_SECRET);
        const user = claims?.sub ? auth.users.get(claims.sub) : null;
        if (!claims) throw new AuthError(401, "bad_jwt", "invalid JWT");
        if (!user) throw new AuthError(403, "user_not_found", "User from sub claim in JWT does not exist");
        const input = parseBody(body);
        if (typeof input.password === "string" && input.password === user.password) {
          throw new AuthError(422, "same_password", "New password should be different from the old password.");
        }
        return json(200, auth.userJson(await auth.updateUser(user.id, { password: input.password, data: input.data })), apiHeaders);
      }

      if (method === "POST" && path === "/auth/v1/logout") {
        return { status: 204, headers: { ...CORS_HEADERS, ...apiHeaders }, body: Buffer.alloc(0) };
      }

      const adminMatch = /^\/auth\/v1\/admin\/users(?:\/([0-9a-f-]{36}))?$/.exec(path);
      if (adminMatch) {
        if (!isServiceCall(headers)) throw new AuthError(403, "not_admin", "User not allowed");
        const id = adminMatch[1];
        const input = parseBody(body);
        if (method === "POST" && !id) {
          const user = await auth.createUser({
            email: input.email,
            password: input.password,
            app_metadata: input.app_metadata ?? {},
            user_metadata: input.user_metadata ?? {},
          });
          return json(200, auth.userJson(user), apiHeaders);
        }
        if (method === "PUT" && id) return json(200, auth.userJson(await auth.updateUser(id, input)), apiHeaders);
        if (method === "DELETE" && id) return json(200, auth.userJson(await auth.deleteUser(id)), apiHeaders);
      }
      throw new AuthError(404, "not_found", `e2e gateway: ${method} ${path} 미지원`);
    } catch (error) {
      if (error instanceof AuthError) return json(error.status, { code: error.code, message: error.message }, apiHeaders);
      throw error;
    }
  }

  async function forward(targetUrl, method, headers, body, overrideHeaders = {}) {
    const forwarded = {};
    for (const name of [
      "accept",
      "accept-profile",
      "content-profile",
      "content-type",
      "prefer",
      "range",
      "range-unit",
      "apikey",
      "authorization",
      "x-client-info",
      "origin", // 함수가 문자에 넣을 접속 주소를 만들 때 씀(실제 Supabase도 넘겨줌)
    ]) {
      if (headers[name] !== undefined) forwarded[name] = headers[name];
    }
    Object.assign(forwarded, overrideHeaders);
    const response = await fetch(targetUrl, {
      method,
      headers: forwarded,
      body: method === "GET" || method === "HEAD" ? undefined : body,
    });
    const responseHeaders = { ...CORS_HEADERS };
    for (const name of ["content-type", "content-range", "preference-applied", "location"]) {
      const value = response.headers.get(name);
      if (value) responseHeaders[name] = value;
    }
    return { status: response.status, headers: responseHeaders, body: Buffer.from(await response.arrayBuffer()) };
  }

  async function handle({ method, path, search = "", headers = {}, body = null }) {
    stats.requests.push(`${method} ${path}`);
    if (method === "OPTIONS") return { status: 200, headers: CORS_HEADERS, body: Buffer.alloc(0) };

    if (path.startsWith("/auth/v1/")) return handleAuth(method, path, search, headers, body);

    if (path.startsWith("/rest/v1/")) {
      // 실제 Supabase처럼: 사용자 JWT면 그대로, secret 키면 service_role, 그 외(publishable 키)는 anon으로 PostgREST에 넘긴다.
      const bearer = bearerOf(headers);
      let authorization;
      if (verifyJwt(bearer, JWT_SECRET)) authorization = `Bearer ${bearer}`;
      else if (isServiceCall(headers)) authorization = `Bearer ${serviceJwt}`;
      else if (bearer.split(".").length === 3) return json(401, { code: "PGRST301", message: "JWT expired" });
      else authorization = `Bearer ${anonJwt}`;
      return forward(`${postgrestUrl}${path.slice("/rest/v1".length)}${search}`, method, headers, body, {
        authorization,
      });
    }

    const fnMatch = /^\/functions\/v1\/([a-z0-9-]+)$/.exec(path);
    if (fnMatch && functionUrls[fnMatch[1]]) {
      return forward(`${functionUrls[fnMatch[1]]}/${search}`, method, headers, body);
    }
    return json(404, { message: `e2e gateway: ${method} ${path} 미지원` });
  }

  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const url = new URL(req.url, "http://gateway.local");
    try {
      const result = await handle({
        method: req.method,
        path: url.pathname,
        search: url.search,
        headers: req.headers,
        body: Buffer.concat(chunks),
      });
      res.writeHead(result.status, result.headers);
      res.end(result.body);
    } catch (error) {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end(String(error?.stack ?? error));
    }
  });

  return {
    handle,
    stats,
    async listen(port) {
      await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
      return `http://127.0.0.1:${port}`;
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
