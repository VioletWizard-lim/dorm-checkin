// 엑셀(.xlsx)·CSV·PDF 파일을 표(문자열 2차원 배열)로 읽는다 — 방과후 출석부 등록용(사용자 요청).
// xlsx는 외부 라이브러리 없이: zip 안의 XML이므로 zip 목록을 직접 읽고, 압축은 브라우저의 DecompressionStream으로 푼다.
// PDF는 PDF.js(CDN, 버전 고정)를 PDF를 고를 때만 불러와 글자와 위치를 읽고 줄·칸으로 다시 맞춘다.
//   글자가 들어 있는 PDF(엑셀·한글에서 PDF로 저장한 것)만 된다 — 스캔한 그림 PDF는 글자가 없어 읽지 못한다.
// 예전 형식(.xls)은 읽지 못한다(엑셀에서 "다른 이름으로 저장 → .xlsx"로 바꾸거나 표를 복사해 붙여넣기).

// tests/e2e/package.json의 pdfjs-dist와 같은 버전이어야 한다(다르면 E2E가 바로 알려 줌)
const PDFJS_VERSION = "5.7.284";
const PDFJS_ROOT = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}`;

export async function readSheetFile(file) {
  const name = (file.name || "").toLowerCase();
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) return readXlsx(bytes); // "PK" = zip(xlsx)
  if (String.fromCharCode(...bytes.subarray(0, 5)) === "%PDF-") return readPdf(bytes);
  if (name.endsWith(".xls") || (bytes[0] === 0xd0 && bytes[1] === 0xcf)) {
    throw new Error("예전 엑셀 형식(.xls)은 읽을 수 없습니다. 엑셀에서 .xlsx로 저장하거나, 표를 복사해 붙여넣어 주세요.");
  }
  return parseCsv(decodeText(bytes));
}

function decodeText(bytes) {
  const utf8 = new TextDecoder("utf-8").decode(bytes);
  if (!utf8.includes("�")) return utf8.replace(/^﻿/, "");
  try {
    return new TextDecoder("euc-kr").decode(bytes); // 한글 엑셀이 저장한 CSV
  } catch {
    return utf8;
  }
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === "," || ch === "\t") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.map((r) => r.map((c) => c.trim()));
}

// ───────────── xlsx ─────────────

async function readXlsx(bytes) {
  const entries = readZipEntries(bytes);
  const text = async (path) => (entries.has(path) ? new TextDecoder("utf-8").decode(await inflateEntry(bytes, entries.get(path))) : null);
  const parser = new DOMParser();
  const xml = (s) => parser.parseFromString(s, "application/xml");

  const shared = [];
  const sharedXml = await text("xl/sharedStrings.xml");
  if (sharedXml) {
    for (const si of xml(sharedXml).getElementsByTagName("si")) {
      shared.push(Array.from(si.getElementsByTagName("t"), (t) => t.textContent).join(""));
    }
  }

  // 시트 순서대로(workbook.xml + rels). 찾지 못하면 이름순
  let sheetPaths = [];
  const workbookXml = await text("xl/workbook.xml");
  const relsXml = await text("xl/_rels/workbook.xml.rels");
  if (workbookXml && relsXml) {
    const targets = {};
    for (const rel of xml(relsXml).getElementsByTagName("Relationship")) {
      targets[rel.getAttribute("Id")] = rel.getAttribute("Target");
    }
    for (const sheet of xml(workbookXml).getElementsByTagName("sheet")) {
      const id = sheet.getAttribute("r:id") || sheet.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id");
      const target = targets[id];
      if (target) sheetPaths.push(target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.\//, "")}`);
    }
  }
  if (sheetPaths.length === 0) {
    sheetPaths = Array.from(entries.keys()).filter((p) => /^xl\/worksheets\/sheet\d+\.xml$/.test(p)).sort();
  }

  // 여러 시트(반마다 시트를 나눈 출석부 등)는 이어 붙인다 — 시트 사이에 빈 줄
  const rows = [];
  for (const path of sheetPaths) {
    const sheetXml = await text(path);
    if (!sheetXml) continue;
    if (rows.length > 0) rows.push([]);
    for (const rowEl of xml(sheetXml).getElementsByTagName("row")) {
      const row = [];
      for (const c of rowEl.getElementsByTagName("c")) {
        const col = columnIndex(c.getAttribute("r"));
        const type = c.getAttribute("t");
        const v = c.getElementsByTagName("v")[0];
        let value = "";
        if (type === "s") value = shared[Number(v && v.textContent)] ?? "";
        else if (type === "inlineStr") value = Array.from(c.getElementsByTagName("t"), (t) => t.textContent).join("");
        else value = v ? v.textContent : "";
        row[col >= 0 ? col : row.length] = value.trim();
      }
      rows.push(Array.from(row, (x) => x ?? ""));
    }
  }
  return rows;
}

function columnIndex(ref) {
  const letters = /^([A-Z]+)/.exec(ref || "");
  if (!letters) return -1;
  let n = 0;
  for (const ch of letters[1]) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

// zip 끝의 중앙 디렉터리에서 파일 목록(이름 → 로컬 헤더 위치·압축 방식·크기)
function readZipEntries(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("엑셀 파일을 읽지 못했습니다(손상된 파일).");
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const entries = new Map();
  for (let i = 0; i < count; i++) {
    if (view.getUint32(p, true) !== 0x02014b50) break;
    const method = view.getUint16(p + 10, true);
    const compressedSize = view.getUint32(p + 20, true);
    const nameLength = view.getUint16(p + 28, true);
    const extraLength = view.getUint16(p + 30, true);
    const commentLength = view.getUint16(p + 32, true);
    const localOffset = view.getUint32(p + 42, true);
    const name = new TextDecoder("utf-8").decode(bytes.subarray(p + 46, p + 46 + nameLength));
    entries.set(name, { method, compressedSize, localOffset });
    p += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

async function inflateEntry(bytes, entry) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const p = entry.localOffset;
  const start = p + 30 + view.getUint16(p + 26, true) + view.getUint16(p + 28, true);
  const data = bytes.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) return data;
  if (entry.method !== 8) throw new Error("엑셀 파일을 읽지 못했습니다(지원하지 않는 압축).");
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// ───────────── PDF ─────────────

async function readPdf(bytes) {
  let pdfjs;
  try {
    pdfjs = await import(`${PDFJS_ROOT}/legacy/build/pdf.min.mjs`);
  } catch {
    throw new Error("PDF를 읽는 도구를 불러오지 못했습니다. 인터넷 연결을 확인하거나, 엑셀(.xlsx) 파일로 불러와 주세요.");
  }
  pdfjs.GlobalWorkerOptions.workerSrc = `${PDFJS_ROOT}/legacy/build/pdf.worker.min.mjs`;
  let doc;
  try {
    doc = await pdfjs.getDocument({
      data: bytes,
      cMapUrl: `${PDFJS_ROOT}/cmaps/`,
      cMapPacked: true,
      standardFontDataUrl: `${PDFJS_ROOT}/standard_fonts/`,
      isEvalSupported: false,
    }).promise;
  } catch (error) {
    if (error && error.name === "PasswordException") throw new Error("암호가 걸린 PDF는 읽을 수 없습니다.");
    throw new Error("PDF 파일을 읽지 못했습니다(손상된 파일).");
  }
  const rows = [];
  let anyText = false;
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const content = await page.getTextContent();
    const items = content.items
      .filter((it) => typeof it.str === "string" && it.str.trim())
      .map((it) => ({
        text: it.str.trim(),
        x: it.transform[4],
        y: it.transform[5],
        w: it.width || 0,
        h: Math.abs(it.height || it.transform[3]) || 10,
      }));
    if (items.length === 0) continue;
    anyText = true;
    if (rows.length > 0) rows.push([]); // 쪽 사이에 빈 줄
    rows.push(...pdfItemsToRows(items));
  }
  if (!anyText) {
    throw new Error("PDF에서 글자를 찾지 못했습니다. 스캔한 그림 PDF는 읽을 수 없으니 엑셀(.xlsx) 파일로 불러와 주세요.");
  }
  return rows;
}

// 글자 조각(위치 포함) → 줄(같은 높이) → 칸(가로 간격). 칸 번호는 그 쪽에서 칸이 가장 많은 줄(보통 머리글)의 칸 위치에 맞춘다
function pdfItemsToRows(items) {
  items.sort((a, b) => b.y - a.y || a.x - b.x);
  const lines = [];
  for (const it of items) {
    const line = lines[lines.length - 1];
    if (line && Math.abs(line.y - it.y) <= Math.max(2, Math.min(line.h, it.h) * 0.5)) line.items.push(it);
    else lines.push({ y: it.y, h: it.h, items: [it] });
  }
  const lineCells = lines.map((line) => {
    const sorted = line.items.sort((a, b) => a.x - b.x);
    const cells = [];
    for (const it of sorted) {
      const cell = cells[cells.length - 1];
      // 같은 칸 안의 글자 조각은 거의 붙어 있고, 칸 사이는 글자 크기만큼 넘게 떨어져 있다
      if (cell && it.x - cell.end < it.h * 0.8) {
        cell.text += (it.x - cell.end > it.h * 0.15 ? " " : "") + it.text;
        cell.end = Math.max(cell.end, it.x + it.w);
      } else {
        cells.push({ text: it.text, start: it.x, end: it.x + it.w });
      }
    }
    return cells;
  });
  const template = lineCells.reduce((best, cells) => (cells.length > best.length ? cells : best), []);
  const centers = template.map((c) => (c.start + c.end) / 2);
  return lineCells.map((cells) => {
    if (cells.length === template.length) return cells.map((c) => c.text);
    const row = new Array(centers.length).fill("");
    for (const c of cells) {
      const mid = (c.start + c.end) / 2;
      let best = 0;
      centers.forEach((x, i) => {
        if (Math.abs(x - mid) < Math.abs(centers[best] - mid)) best = i;
      });
      row[best] = row[best] ? `${row[best]} ${c.text}` : c.text;
    }
    return row;
  });
}
