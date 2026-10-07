import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { HttpError } from "./http.ts";
import type { Profile } from "./types.ts";

type Env = { get(key: string): string | undefined };

// 새 API 키(SUPABASE_SECRET_KEYS, JSON)가 있으면 그걸, 없으면 레거시 service_role 키를 쓴다.
export function getServiceKey(env: Env = Deno.env): string {
  const secretKeys = env.get("SUPABASE_SECRET_KEYS");
  if (secretKeys) {
    try {
      const parsed = JSON.parse(secretKeys) as Record<string, string>;
      const key = parsed.default ?? Object.values(parsed)[0];
      if (key) return key;
    } catch {
      // 레거시 키로 넘어감
    }
  }
  const legacy = env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (legacy) return legacy;
  throw new Error("Supabase service key is not available in the function environment");
}

export function createAdminClient(): SupabaseClient {
  const url = Deno.env.get("SUPABASE_URL");
  if (!url) throw new Error("SUPABASE_URL is not available in the function environment");
  return createClient(url, getServiceKey(), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// 호출한 사용자의 JWT를 Auth 서버에 확인하고 프로필을 읽는다(config.toml에서 verify_jwt를 끄고 여기서 직접 검증).
export async function getCaller(req: Request, admin: SupabaseClient): Promise<Profile> {
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!token) throw new HttpError(401, "로그인이 필요합니다.");
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data?.user) throw new HttpError(401, "로그인이 만료되었습니다. 다시 로그인해 주세요.");
  const { data: profile, error: profileError } = await admin
    .from("profiles")
    .select("*")
    .eq("id", data.user.id)
    .maybeSingle();
  if (profileError) throw profileError;
  if (!profile || profile.disabled) throw new HttpError(403, "사용할 수 없는 계정입니다.");
  return profile as Profile;
}
