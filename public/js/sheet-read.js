// 엑셀(.xlsx)·CSV 파일을 표(문자열 2차원 배열)로 읽는다 — 방과후 출석부 등록용(사용자 요청).
// 외부 라이브러리 없이: xlsx는 zip 안의 XML이므로 zip 목록을 직접 읽고, 압축은 브라우저의 DecompressionStream으로 푼다.
// 예전 형식(.xls)은 읽지 못한다(엑셀에서 "다른 이름으로 저장 → .xlsx"로 바꾸거나 표를 복사해 붙여넣기).

export async function readSheetFile(file) {
  const name = (file.name || "").toLowerCase();
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) return readXlsx(bytes); // "PK" = zip(xlsx)
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

export function parseCsv(text) {
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
