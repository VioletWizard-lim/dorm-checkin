// 교사 화면(check.html·seat.html)의 외출증 팝업 — 학생 화면과 같은 외출증(outing-pass.js)을 <dialog>로 띄운다.
// getPass(studentId)는 { title, pass }를 돌려주고, 외출이 끝났으면(복귀·취소) null을 돌려준다(→ 팝업이 닫힘).
// 화면은 다시 그릴 때마다 refresh()를 불러, 열려 있는 동안 바뀐 기록을 반영한다.
import { drawOutingPass } from "./outing-pass.js";

export function createPassDialog(getPass) {
  const dialog = document.createElement("dialog");
  dialog.className = "pass-dialog";
  dialog.id = "passDialog";
  dialog.setAttribute("aria-labelledby", "passDialogTitle");
  dialog.innerHTML = `
    <div class="pass-dialog__header">
      <span class="pass-dialog__title" id="passDialogTitle">외출증</span>
      <button type="button" class="btn-secondary btn-small" data-pass-close>닫기</button>
    </div>
    <canvas class="pass-canvas" id="passDialogCanvas" role="img" aria-label="외출증"></canvas>
  `;
  document.body.append(dialog);
  const titleEl = dialog.querySelector("#passDialogTitle");
  const canvas = dialog.querySelector("#passDialogCanvas");

  let studentId = "";
  let drawnKey = "";

  function refresh() {
    if (!studentId || !dialog.open) return;
    const result = getPass(studentId);
    if (!result) {
      dialog.close();
      return;
    }
    titleEl.textContent = result.title;
    const key = JSON.stringify(result.pass);
    if (key === drawnKey) return;
    drawnKey = key;
    drawOutingPass(canvas, result.pass);
  }

  dialog.addEventListener("close", () => {
    studentId = "";
    drawnKey = "";
  });
  dialog.addEventListener("click", (event) => {
    // [닫기] 또는 바깥(어두운 부분)을 누르면 닫힘. Esc는 브라우저가 처리
    if (event.target === dialog || event.target.closest("[data-pass-close]")) dialog.close();
  });

  return {
    open(id) {
      studentId = id;
      drawnKey = "";
      dialog.showModal();
      refresh();
    },
    refresh,
  };
}
