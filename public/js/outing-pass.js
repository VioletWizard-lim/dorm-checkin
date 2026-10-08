// 외출증 이미지(JPEG) 만들기 — 학생에게 MMS로 보낼 종이 외출증 모양.
// 서버(Deno)에서는 한글 글꼴로 그림을 그리기 어려워서, 화면에 이미 있는 Noto Sans KR로 브라우저 canvas에서 그린다.
// 결과는 data: 접두어를 뺀 base64. 솔라피 MMS 한도(200KB)보다 작게 만든다.

const WIDTH = 640;
const HEIGHT = 860;
const MAX_BYTES = 190 * 1024;
const FONT = '"Noto Sans KR", "Apple SD Gothic Neo", "Malgun Gothic", sans-serif';

// 그릴 글자가 든 글꼴 조각을 받아 둔다. Google Fonts의 한글 글꼴은 글자 범위별로 나뉘어 있어서
// 실제로 쓸 글자를 넘겨야 그 조각을 받는다. 네트워크가 막혀 있어도 오래 붙잡지 않음.
async function ensureFont(text) {
  if (!document.fonts || !document.fonts.load) return;
  const timeout = new Promise((resolve) => setTimeout(resolve, 2000));
  try {
    await Promise.race([
      Promise.all([document.fonts.load(`700 40px ${FONT}`, text), document.fonts.load(`400 24px ${FONT}`, text)]),
      timeout,
    ]);
  } catch {
    // 기본 글꼴로 그린다
  }
}

// 폭에 맞게 줄바꿈(띄어쓰기 단위, 한 단어가 너무 길면 글자 단위). 최대 줄 수를 넘으면 마지막 줄 끝을 …로
function wrapText(ctx, text, maxWidth, maxLines) {
  const fits = (value) => ctx.measureText(value).width <= maxWidth;
  const lines = [];
  let line = "";
  for (const word of String(text).split(/(\s+)/)) {
    if (!word) continue;
    if (fits(line + word)) {
      line += word;
      continue;
    }
    if (line.trim()) lines.push(line.trimEnd());
    line = "";
    if (/^\s+$/.test(word)) continue;
    for (const ch of word) {
      if (!fits(line + ch) && line) {
        lines.push(line);
        line = ch;
      } else {
        line += ch;
      }
    }
  }
  if (line.trim()) lines.push(line.trimEnd());
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    kept[maxLines - 1] = `${kept[maxLines - 1].slice(0, -1)}…`;
    return kept;
  }
  return lines;
}

// pass: { name, cls, number, sid, dateLabel, start, back, reason, teacher }
export async function renderOutingPassJpeg(pass) {
  const rows = [
    ["이름", pass.name],
    ["학년·반·번호", `${pass.cls}${pass.number ? ` ${pass.number}번` : ""}`],
    ["학번", pass.sid || "-"],
    ["외출 일시", `${pass.dateLabel} ${pass.start} ~ ${pass.back}`],
    ["사유", pass.reason || "사유 미기재"],
    ["확인 교사", pass.teacher || "-"],
  ];
  const footer = "복귀하면 사감 선생님께 꼭 알려 주세요.";
  await ensureFont(["외 출 증", "기숙사 외출 확인", footer, ...rows.flat()].join(""));
  const canvas = document.createElement("canvas");
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  ctx.fillStyle = "#FFFFFF";
  ctx.fillRect(0, 0, WIDTH, HEIGHT);
  ctx.strokeStyle = "#1C2230";
  ctx.lineWidth = 4;
  ctx.strokeRect(24, 24, WIDTH - 48, HEIGHT - 48);

  ctx.fillStyle = "#1C2230";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `700 52px ${FONT}`;
  ctx.fillText("외 출 증", WIDTH / 2, 100);
  ctx.font = `400 22px ${FONT}`;
  ctx.fillStyle = "#5B6475";
  ctx.fillText("기숙사 외출 확인", WIDTH / 2, 150);

  const left = 56;
  const labelWidth = 170;
  const right = WIDTH - 56;
  let y = 200;
  ctx.textAlign = "left";
  ctx.lineWidth = 1.5;
  for (const [label, value] of rows) {
    ctx.font = `400 26px ${FONT}`;
    const lines = wrapText(ctx, value, right - left - labelWidth - 16, label === "사유" ? 3 : 2);
    const rowHeight = Math.max(80, 30 + lines.length * 36);
    ctx.strokeStyle = "#D5D9E2";
    ctx.beginPath();
    ctx.moveTo(left, y + rowHeight);
    ctx.lineTo(right, y + rowHeight);
    ctx.stroke();
    ctx.fillStyle = "#5B6475";
    ctx.font = `700 22px ${FONT}`;
    ctx.fillText(label, left + 8, y + rowHeight / 2);
    ctx.fillStyle = "#1C2230";
    ctx.font = `${label === "외출 일시" ? 700 : 400} 26px ${FONT}`;
    const top = y + rowHeight / 2 - ((lines.length - 1) * 36) / 2;
    lines.forEach((text, i) => ctx.fillText(text, left + labelWidth, top + i * 36));
    y += rowHeight;
  }

  ctx.textAlign = "center";
  ctx.fillStyle = "#C0392B";
  ctx.font = `700 24px ${FONT}`;
  ctx.fillText(footer, WIDTH / 2, HEIGHT - 80);

  for (const quality of [0.85, 0.7, 0.55]) {
    const base64 = canvas.toDataURL("image/jpeg", quality).split(",")[1] || "";
    if (base64.length * 0.75 <= MAX_BYTES) return base64;
  }
  return null;
}
