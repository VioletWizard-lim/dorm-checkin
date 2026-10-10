// 교직원 화면 공통 메뉴(사용자 요청: 화면을 옮길 때마다 메뉴가 바뀌지 않게).
// 모든 화면이 같은 순서로 같은 메뉴를 보여 주고, 지금 화면은 빼지 않고 그 자리에서 강조한다.
// 각 화면의 <nav id="appNav">를 requireStaff()로 받은 프로필에 맞춰 채운다.
// 링크를 숨기는 건 편의 기능이고, 실제 권한은 서버(RLS·RPC)와 각 화면의 리다이렉트가 막는다.
import { escapeHtml } from "./util.js";

function hasManagedClasses(profile) {
  return Object.values(profile.managedClasses || {}).some((classes) => Object.keys(classes || {}).length > 0);
}

// 외출 체크를 할 수 있는 계정(관리자·학년부장·담임)에게만 체크 화면 이름이 "외출 체크".
// 자습 감독·기숙사부·담당 반 없는 교사는 그 화면에서 복귀·자리 없음 해제·보기만 하므로 "학생 상태"(사용자 요청)
export function checkPageLabel(profile) {
  const role = profile?.role || "teacher";
  const canCheckOut = role === "admin" || role === "gradeManager" || (role === "teacher" && hasManagedClasses(profile || {}));
  return canCheckOut ? "외출 체크" : "학생 상태";
}

// 순서 고정. visible(role, homeroom): 그 계정이 들어갈 수 있는 화면인지(화면의 리다이렉트 기준과 같음)
const NAV_ITEMS = [
  { id: "checkLink", page: "check.html", label: checkPageLabel, visible: (role) => role !== "afterschoolTeacher" },
  { id: "displayLink", page: "display.html", label: "현황판", visible: (role) => role !== "afterschoolTeacher" },
  { id: "seatLink", page: "seat.html", label: "좌석 배치판", visible: (role) => role !== "afterschoolTeacher" },
  {
    id: "manageLink",
    page: "students.html",
    label: "학생 명단 관리",
    visible: (role, homeroom) => ["admin", "gradeManager", "dormStaff"].includes(role) || (role === "teacher" && homeroom),
  },
  {
    id: "historyLink",
    page: "history.html",
    label: "외출 기록",
    visible: (role, homeroom) => ["admin", "gradeManager"].includes(role) || (role === "teacher" && homeroom),
  },
  { id: "afterschoolLink", page: "afterschool.html", label: "방과후 일정", visible: (role) => role === "admin" },
  { id: "accountsLink", page: "accounts.html", label: "계정 관리", visible: (role) => role === "admin" },
];

function currentPage() {
  return window.location.pathname.split("/").pop() || "check.html";
}

export function renderNav(profile) {
  const nav = document.getElementById("appNav");
  if (!nav) return;
  const role = profile?.role || "teacher";
  const homeroom = hasManagedClasses(profile || {});
  const here = currentPage();
  nav.innerHTML = NAV_ITEMS.filter((item) => item.page === here || item.visible(role, homeroom))
    .map((item) => {
      const current = item.page === here;
      return `<a href="./${item.page}" id="${item.id}" class="app-nav__link${current ? " is-current" : ""}"${
        current ? ' aria-current="page"' : ""
      }>${escapeHtml(typeof item.label === "function" ? item.label(profile) : item.label)}</a>`;
    })
    .join("");
}
