// 교직원 화면 자동 로그아웃: 2시간 동안 아무 조작(마우스·키보드·터치)이 없으면 이 기기에서 로그아웃한다(사용자 요청).
// 현황판(display.html)도 포함 — 켜 두기만 하고 2시간이 지나면 다시 로그인해야 한다. 학생 화면은 적용하지 않음.
// 마지막 조작 시각은 localStorage에 둬서 같은 브라우저의 다른 탭에서 조작해도 함께 연장되고,
// 브라우저를 닫았다가 2시간 뒤에 다시 열어도 바로 로그아웃된다.

const IDLE_LIMIT_MS = 2 * 60 * 60 * 1000;
const STORAGE_KEY = "dormcheckin.lastActivityAt";
const WRITE_EVERY_MS = 15 * 1000; // 마우스를 움직일 때마다 저장하지 않도록
const CHECK_EVERY_MS = 30 * 1000;

function readLastActivity() {
  try {
    const value = Number(localStorage.getItem(STORAGE_KEY));
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

// 지금을 마지막 조작 시각으로 기록한다(로그인 직후에도 부름 — 예전 기록 때문에 바로 로그아웃되지 않게)
export function markActivity() {
  try {
    localStorage.setItem(STORAGE_KEY, String(Date.now()));
  } catch {
    // 저장소를 못 쓰면 이 탭 안에서만 센다
  }
}

function isIdleExpired(now = Date.now()) {
  const last = readLastActivity();
  return last !== null && now - last >= IDLE_LIMIT_MS;
}

let started = false;

// 화면을 여는 시점에 이미 2시간이 지났으면 true(부르는 쪽이 바로 로그아웃).
// 아니면 조작을 지켜보다가 2시간이 지나면 onExpire를 부른다.
export function startIdleLogout(onExpire) {
  if (isIdleExpired()) return true;
  if (readLastActivity() === null) markActivity();
  if (started) return false;
  started = true;

  let lastWrite = 0;
  const onActivity = () => {
    const now = Date.now();
    if (now - lastWrite < WRITE_EVERY_MS) return;
    lastWrite = now;
    markActivity();
  };
  for (const type of ["pointerdown", "pointermove", "keydown", "wheel", "touchstart", "scroll"]) {
    window.addEventListener(type, onActivity, { passive: true, capture: true });
  }

  let expired = false;
  const check = () => {
    if (expired || !isIdleExpired()) return;
    expired = true;
    onExpire();
  };
  setInterval(check, CHECK_EVERY_MS);
  // 절전·다른 탭에 있다가 돌아왔을 때 바로 확인
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") check();
  });
  return false;
}
