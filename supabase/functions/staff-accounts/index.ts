import { jsonResponse, readJson, serve } from "../_shared/http.ts";
import { createAdminClient, getCaller } from "../_shared/supabase.ts";
import { randomPassword } from "../_shared/accounts.ts";
import type { Profile } from "../_shared/types.ts";
import { handleStaffAccounts } from "./handler.ts";

serve(async (req) => {
  const admin = createAdminClient();
  const caller = await getCaller(req, admin);
  const body = await readJson(req);

  const result = await handleStaffAccounts(body, {
    caller,
    auth: admin.auth.admin,
    profiles: {
      async get(id) {
        const { data, error } = await admin.from("profiles").select("*").eq("id", id).maybeSingle();
        if (error) throw error;
        return data as Profile | null;
      },
      async insert(row) {
        const { error } = await admin.from("profiles").insert(row);
        return { error };
      },
      async update(id, patch) {
        const { error } = await admin.from("profiles").update(patch).eq("id", id);
        return { error };
      },
    },
    generatePassword: () => randomPassword(8),
  });
  return jsonResponse(200, result);
});
