// Supabase 테이블 하나를 화면에 실시간으로 맞춰 두는 도우미.
// - 처음에 전체를 조회하고, Realtime 변경 알림이 오면 다시 조회한다.
//   알림 내용을 직접 끼워 넣지 않고 다시 읽기 때문에, 연결이 끊겼다 다시 붙거나 알림에서 큰 값이 빠져도
//   항상 서버와 같은 상태가 된다(학교 규모라 다시 읽는 비용은 작음).
// - 구독이 (다시) 연결될 때마다 다시 조회해서 끊겨 있던 동안의 변경을 따라잡는다.
// - Realtime 연결이 안 되는 네트워크(웹소켓 차단 등)에서도 15초마다 다시 조회해서 화면이 멈추지 않게 한다.
import { supabase } from "./supabase-client.js";

const CHANGE_DEBOUNCE_MS = 100;
// Supabase API는 한 번에 최대 1000행(기본 설정)까지만 돌려주므로 그보다 많으면 나눠 읽는다.
const PAGE_SIZE = 1000;
const RETRY_MS = 5000;
const FALLBACK_POLL_MS = 15000;
let channelSeq = 0;

// eq: { 열: 값 } — 조회 조건. Realtime 필터에는 첫 번째 조건만 쓴다(나머지는 다시 조회할 때 걸러짐).
// order: 정렬할 열 목록(오름차순). 나눠 읽을 때 순서가 흔들리지 않도록 마지막 열은 유일한 값(기본키)이어야 한다.
// onRows(rows): 조회가 끝날 때마다 전체 행 배열로 호출
// onError(error): 조회 실패 시(자동으로 다시 시도함)
// augment(rows): (선택) 행을 넘기기 전에 더 읽어 붙인다(학생 명단의 연락처 등). 실패하면 error를 돌려줌 → 조회 실패와 같이 처리
export function liveTable({ table, select = "*", eq = null, order, augment = null, onRows, onError }) {
  let stopped = false;
  let loading = false;
  let loadAgain = false;
  let subscribed = false;
  let debounceTimer = null;
  let retryTimer = null;
  // refresh()를 기다리는 쪽: 그 호출 뒤에 시작한 조회가 끝나면 풀어 준다.
  let waiters = [];

  async function load() {
    if (stopped) return;
    if (loading) {
      loadAgain = true;
      return;
    }
    loading = true;
    clearTimeout(retryTimer);
    const done = waiters;
    waiters = [];
    let { data, error } = await fetchAll();
    if (!error && augment && !stopped) error = await augment(data);
    loading = false;
    if (!stopped) {
      if (error) {
        if (onError) onError(error);
        retryTimer = setTimeout(load, RETRY_MS);
      } else {
        onRows(data || []);
      }
    }
    for (const resolve of done) resolve();
    if (loadAgain && !stopped) {
      loadAgain = false;
      load();
    }
  }

  async function fetchAll() {
    const rows = [];
    for (let from = 0; ; from += PAGE_SIZE) {
      let query = supabase.from(table).select(select);
      for (const [column, value] of Object.entries(eq || {})) query = query.eq(column, value);
      for (const column of order) query = query.order(column, { ascending: true });
      const { data, error } = await query.range(from, from + PAGE_SIZE - 1);
      if (error) return { data: null, error };
      rows.push(...data);
      if (data.length < PAGE_SIZE) return { data: rows, error: null };
    }
  }

  function scheduleLoad() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(load, CHANGE_DEBOUNCE_MS);
  }

  const [filterEntry] = Object.entries(eq || {});
  const binding = { event: "*", schema: "public", table };
  if (filterEntry) binding.filter = `${filterEntry[0]}=eq.${filterEntry[1]}`;

  const channel = supabase
    .channel(`live-${table}-${++channelSeq}`)
    .on("postgres_changes", binding, scheduleLoad)
    .subscribe((status, err) => {
      if (status === "SUBSCRIBED") {
        subscribed = true;
        load();
      } else {
        subscribed = false;
        if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          console.warn(`실시간 연결 문제(${table}): ${status}`, err || "");
        }
      }
    });

  const pollTimer = setInterval(() => {
    if (!subscribed) load();
  }, FALLBACK_POLL_MS);

  function onVisible() {
    if (document.visibilityState === "visible") load();
  }
  document.addEventListener("visibilitychange", onVisible);

  load();

  return {
    // 직접 쓰기를 한 뒤 알림을 기다리지 않고 바로 화면에 반영하고 싶을 때. 다시 읽기가 끝나면 풀리는 Promise.
    refresh() {
      return new Promise((resolve) => {
        waiters.push(resolve);
        load();
      });
    },
    stop() {
      stopped = true;
      for (const resolve of waiters) resolve();
      waiters = [];
      clearTimeout(debounceTimer);
      clearTimeout(retryTimer);
      clearInterval(pollTimer);
      document.removeEventListener("visibilitychange", onVisible);
      supabase.removeChannel(channel);
    },
  };
}
