import { jsonResponse, readJson, serve } from "../_shared/http.ts";
import { createAdminClient, getCaller } from "../_shared/supabase.ts";
import { randomPin } from "../_shared/accounts.ts";
import { createSmsSender, smsConfigFromEnv } from "../_shared/solapi.ts";
import type { Profile } from "../_shared/types.ts";
import { handleStudentAccounts, loginPageUrl, type StudentRow } from "./handler.ts";

// in.(...) 조건이 URL에 들어가므로 id가 많으면 나눠서 조회한다.
async function inChunks<T>(ids: string[], load: (chunk: string[]) => Promise<T[]>): Promise<T[]> {
  const rows: T[] = [];
  for (let i = 0; i < ids.length; i += 50) rows.push(...(await load(ids.slice(i, i + 50))));
  return rows;
}

serve(async (req) => {
  const smsConfig = smsConfigFromEnv();
  const admin = createAdminClient();
  const caller = await getCaller(req, admin);
  const body = await readJson(req);

  const result = await handleStudentAccounts(body, {
    caller,
    auth: admin.auth.admin,
    students: {
      getMany: (ids) =>
        inChunks(ids, async (chunk) => {
          const { data, error } = await admin.from("students").select("id, grade, cls, name, login_id, phone").in("id", chunk);
          if (error) throw error;
          return (data ?? []) as StudentRow[];
        }),
      async delete(id) {
        const { error } = await admin.from("students").delete().eq("id", id);
        return { error };
      },
    },
    profiles: {
      findByStudentIds: (ids) =>
        inChunks(ids, async (chunk) => {
          const { data, error } = await admin.from("profiles").select("*").in("student_id", chunk);
          if (error) throw error;
          return (data ?? []) as Profile[];
        }),
      async insert(row) {
        const { error } = await admin.from("profiles").insert(row);
        return { error };
      },
    },
    generatePin: () => randomPin(6),
    sms: smsConfig ? createSmsSender(smsConfig) : null,
    appUrl: loginPageUrl(req.headers.get("Origin"), body.appPath),
  });
  return jsonResponse(200, result);
});
