// 외출증 그리기 — 학생 화면(student.html)에 띄우는 종이 외출증 모양(도장 포함).
// 예전에는 학생에게 MMS로 보냈지만 문자 비용 때문에 화면에 띄우는 것으로 바꿨다(학부모에게는 안내 문자만).

const WIDTH = 640;
const HEIGHT = 860;
const FONT = '"Noto Sans KR", "Apple SD Gothic Neo", "Malgun Gothic", sans-serif';
// 가운데에 찍는 도장 문구(위·가운데). 아래 줄에는 외출 날짜가 들어간다.
const STAMP_TOP = "강화고 기숙사";
const STAMP_MAIN = "외출승인";
const STAMP_COLOR = "#C0392B";
// 맨 아래에 넣는 학교 로고(마크 + 학교 이름). 원본이 작아서(163×55) 1.6배로 그림
const SCHOOL_LOGO_URL = new URL("../img/school-logo.png", import.meta.url).href;
const LOGO_SCALE = 1.6;

let logoPromise = null;
function loadSchoolLogo() {
  if (!logoPromise) {
    logoPromise = new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null); // 로고를 못 불러와도 외출증은 그린다
      img.src = SCHOOL_LOGO_URL;
    });
  }
  return logoPromise;
}

// 빨간 도장: 이중 테두리 원 + 문구, 살짝 기울이고 반투명하게(글자 위에 찍은 것처럼)
function drawStamp(ctx, cx, cy, bottomText) {
  const r = 120;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate((-14 * Math.PI) / 180);
  ctx.globalAlpha = 0.5;
  ctx.strokeStyle = STAMP_COLOR;
  ctx.fillStyle = STAMP_COLOR;
  ctx.lineWidth = 7;
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.arc(0, 0, r - 12, 0, Math.PI * 2);
  ctx.stroke();
  // 가운데 띠
  ctx.lineWidth = 2.5;
  for (const y of [-34, 34]) {
    const half = Math.sqrt((r - 12) ** 2 - y ** 2);
    ctx.beginPath();
    ctx.moveTo(-half, y);
    ctx.lineTo(half, y);
    ctx.stroke();
  }
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `700 22px ${FONT}`;
  ctx.fillText(STAMP_TOP, 0, -64);
  ctx.font = `900 46px ${FONT}`;
  ctx.fillText(STAMP_MAIN, 0, 2);
  ctx.font = `700 26px ${FONT}`;
  ctx.fillText(bottomText, 0, 64);
  ctx.restore();
}

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

// canvas에 외출증을 그린다. pass: { name, cls, number, dateLabel, start, back, reason, teacher }
export async function drawOutingPass(canvas, pass) {
  const rows = [
    ["이름", pass.name],
    ["학년·반·번호", `${pass.cls}${pass.number ? ` ${pass.number}번` : ""}`],
    ["외출 일시", `${pass.dateLabel} ${pass.start} ~ ${pass.back}`],
    ["사유", pass.reason || "사유 미기재"],
    ["확인 교사", pass.teacher || "-"],
  ];
  const footer = "복귀하면 사감 선생님께 꼭 알려 주세요.";
  const [logo] = await Promise.all([
    loadSchoolLogo(),
    ensureFont(["외 출 증", "기숙사 외출 확인", footer, STAMP_TOP, STAMP_MAIN, ...rows.flat()].join("")),
  ]);
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  ctx.fillStyle = "#FFFFFF";
  ctx.fillRect(0, 0, WIDTH, HEIGHT);
  ctx.strokeStyle = "#1C2230";
  ctx.lineWidth = 4;
  ctx.strokeRect(24, 24, WIDTH - 48, HEIGHT - 48);
  // 도장은 내용 가운데에 먼저 찍고 그 위에 글자를 써서, 글자가 가려지지 않게 한다
  drawStamp(ctx, WIDTH / 2, 430, pass.dateLabel);

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
  ctx.fillText(footer, WIDTH / 2, HEIGHT - 150);

  // 맨 아래 가운데에 학교 로고
  if (logo) {
    const w = logo.naturalWidth * LOGO_SCALE;
    const h = logo.naturalHeight * LOGO_SCALE;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(logo, (WIDTH - w) / 2, HEIGHT - 44 - h, w, h);
  }
}
