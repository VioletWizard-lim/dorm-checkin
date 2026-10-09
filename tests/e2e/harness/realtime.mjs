// Supabase Realtime(postgres_changes) 흉내. 브라우저의 웹소켓을 Playwright routeWebSocket으로 가로채
// Phoenix 프로토콜(vsn 2.0.0: [join_ref, ref, topic, event, payload] 배열)로 응답한다.
// 행 변경은 setup.sql의 트리거가 NOTIFY로 보내고, 실제 Supabase처럼
//   - 필터(열=eq.값)가 맞고 구독자가 RLS로 그 행을 볼 수 있을 때만 보낸다(DELETE는 필터·RLS 없이 기본키만).
//   - UPDATE·DELETE의 old_record에는 기본키만 담는다(replica identity 기본값과 같음).
import pg from "pg";
import { verifyJwt } from "./jwt.mjs";

const PRIMARY_KEYS = {
  students: ["id"],
  rooms: ["id"],
  profiles: ["id"],
  outing_requests: ["id"],
  outings: ["date", "student_id"],
  afterschool_dates: ["date"],
};

const pick = (row, keys) => Object.fromEntries(keys.map((k) => [k, row[k]]));

function matchesBinding(binding, table, type, record) {
  if (binding.schema && binding.schema !== "*" && binding.schema !== "public") return false;
  if (binding.table && binding.table !== "*" && binding.table !== table) return false;
  if (binding.event !== "*" && binding.event !== type) return false;
  if (!binding.filter || type === "DELETE") return true;
  const m = /^([a-z_]+)=eq\.(.*)$/.exec(binding.filter);
  if (!m) return true;
  return record[m[1]] !== null && record[m[1]] !== undefined && String(record[m[1]]) === m[2];
}

export class RealtimeHub {
  constructor({ connection, pool, jwtSecret }) {
    this.connection = connection;
    this.pool = pool;
    this.jwtSecret = jwtSecret;
    this.sockets = new Set();
    this.nextBindingId = 1;
    this.queue = Promise.resolve();
    this.paused = false;
  }

  async start() {
    const { rows } = await this.pool.query(
      `select table_name, column_name, udt_name from information_schema.columns
        where table_schema = 'public' order by table_name, ordinal_position`
    );
    this.columns = {};
    for (const row of rows) {
      (this.columns[row.table_name] ??= []).push({ name: row.column_name, type: row.udt_name });
    }
    this.listener = new pg.Client(this.connection);
    await this.listener.connect();
    this.listener.on("notification", (msg) => {
      const change = JSON.parse(msg.payload);
      this.queue = this.queue.then(() => this.dispatch(change)).catch((err) => console.error("realtime dispatch", err));
    });
    await this.listener.query("listen e2e_changes");
  }

  async stop() {
    await this.listener?.end().catch(() => {});
  }

  // 테스트에서 "실시간 연결이 끊긴 상황"을 만들 때 쓴다(알림을 버림).
  setPaused(paused) {
    this.paused = paused;
  }

  attach(ws) {
    const socket = { ws, channels: new Map() };
    this.sockets.add(socket);
    ws.onMessage((raw) => this.onMessage(socket, raw));
    ws.onClose(() => this.sockets.delete(socket));
  }

  send(socket, message) {
    try {
      socket.ws.send(JSON.stringify(message));
    } catch {
      this.sockets.delete(socket);
    }
  }

  claimsOf(token) {
    return verifyJwt(token, this.jwtSecret) ?? { role: "anon" };
  }

  onMessage(socket, raw) {
    let parsed;
    try {
      parsed = JSON.parse(typeof raw === "string" ? raw : raw.toString("utf8"));
    } catch {
      return;
    }
    const [joinRef, ref, topic, event, payload = {}] = parsed;
    const reply = (status, response = {}) => this.send(socket, [joinRef, ref, topic, "phx_reply", { status, response }]);

    if (event === "heartbeat") return reply("ok");
    if (event === "phx_join") {
      const bindings = (payload.config?.postgres_changes ?? []).map((b) => ({
        id: this.nextBindingId++,
        event: b.event,
        schema: b.schema,
        table: b.table,
        filter: b.filter,
      }));
      socket.channels.set(topic, { joinRef, claims: this.claimsOf(payload.access_token), bindings });
      reply("ok", { postgres_changes: bindings });
      this.send(socket, [
        joinRef,
        null,
        topic,
        "system",
        { status: "ok", message: "Subscribed to PostgreSQL", extension: "postgres_changes", channel: topic.replace(/^realtime:/, "") },
      ]);
      return;
    }
    if (event === "access_token") {
      const channel = socket.channels.get(topic);
      if (channel && payload.access_token) channel.claims = this.claimsOf(payload.access_token);
      return;
    }
    if (event === "phx_leave") {
      socket.channels.delete(topic);
      return reply("ok");
    }
    return reply("ok");
  }

  // 구독자 권한으로 그 행이 보이는지(RLS) 확인한다.
  async canSee(claims, table, record) {
    if (claims.role === "service_role") return true;
    const keys = PRIMARY_KEYS[table];
    if (!keys) return false;
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
      await client.query(claims.role === "authenticated" ? "set local role authenticated" : "set local role anon");
      const where = keys.map((k, i) => `${k} = $${i + 1}`).join(" and ");
      const { rows } = await client.query(`select 1 from public.${table} where ${where}`, keys.map((k) => record[k]));
      return rows.length > 0;
    } catch {
      return false;
    } finally {
      await client.query("rollback").catch(() => {});
      client.release();
    }
  }

  async dispatch({ table, type, record, old_record, commit_timestamp }) {
    if (this.paused) return;
    const keys = PRIMARY_KEYS[table] ?? [];
    for (const socket of this.sockets) {
      for (const [topic, channel] of socket.channels) {
        const ids = channel.bindings.filter((b) => matchesBinding(b, table, type, record)).map((b) => b.id);
        if (ids.length === 0) continue;
        if (type !== "DELETE" && !(await this.canSee(channel.claims, table, record))) continue;
        const data = { schema: "public", table, commit_timestamp, type, columns: this.columns[table] ?? [], errors: null };
        if (type !== "DELETE") data.record = record;
        if (type !== "INSERT") data.old_record = pick(old_record ?? {}, keys);
        this.send(socket, [channel.joinRef, null, topic, "postgres_changes", { ids, data }]);
      }
    }
  }
}
