// server/documents.js
// Генерация «офисных» бинарных документов для инструмента create_document (режим «Компьютер»).
// PDF и DOCX уже умел делать server/export.js (кнопка «Скачать ответ») — здесь они просто
// переиспользуются, а добавляются XLSX/PPTX/CSV/RTF/ODT. Все генераторы — чистый JS,
// без нативных модулей (стиль всего проекта — см. package.json/description).
'use strict';

const ExcelJS = require('exceljs');
const PptxGenJS = require('pptxgenjs');
const archiver = require('archiver');
const { buildPdf, buildDocx, parseBlocks, stripInlineMarkdown } = require('./export');

// ---------- XLSX ----------
// args.sheets: [{ name, rows: [[...],[...]] }] — предпочтительный вариант (несколько листов).
// args.rows: [[...],[...]] — сокращённый вариант для одной таблицы (один лист "Лист1").
async function buildXlsx({ sheets, rows, title } = {}) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Ядро';
  const sheetList = Array.isArray(sheets) && sheets.length ? sheets : [{ name: title || 'Лист1', rows: rows || [] }];
  for (const s of sheetList) {
    const name = String(s.name || 'Лист1').slice(0, 31) || 'Лист1'; // Excel-лимит имени листа — 31 символ
    const ws = wb.addWorksheet(name);
    const data = Array.isArray(s.rows) ? s.rows : [];
    data.forEach((row, idx) => {
      const cells = Array.isArray(row) ? row : [row];
      ws.addRow(cells);
      if (idx === 0) ws.getRow(1).font = { bold: true }; // первая строка — как заголовок таблицы
    });
    ws.columns.forEach((col) => {
      let maxLen = 8;
      col.eachCell?.({ includeEmpty: false }, (cell) => {
        const len = String(cell.value ?? '').length;
        if (len > maxLen) maxLen = len;
      });
      col.width = Math.min(maxLen + 2, 60);
    });
  }
  return wb.xlsx.writeBuffer().then((buf) => Buffer.from(buf));
}

// ---------- PPTX ----------
// args.slides: [{ title, bullets: [string], notes? }]
async function buildPptx({ slides, title } = {}) {
  const pptx = new PptxGenJS();
  const list = Array.isArray(slides) && slides.length ? slides : [{ title: title || 'Слайд 1', bullets: [] }];
  for (const s of list) {
    const slide = pptx.addSlide();
    if (s.title) {
      slide.addText(String(s.title), { x: 0.5, y: 0.3, w: 9, h: 1, fontSize: 24, bold: true });
    }
    const bullets = Array.isArray(s.bullets) ? s.bullets : [];
    if (bullets.length) {
      slide.addText(
        bullets.map((b) => ({ text: String(b), options: { bullet: true, breakLine: true } })),
        { x: 0.5, y: 1.4, w: 9, h: 5, fontSize: 16, valign: 'top' }
      );
    }
    if (s.notes) slide.addNotes(String(s.notes));
  }
  const buf = await pptx.write({ outputType: 'nodebuffer' });
  return Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
}

// ---------- CSV ----------
// args.rows: [[...],[...]]. Экранируем по RFC 4180 (кавычки при запятой/кавычке/переносе строки).
// BOM в начале — иначе Excel на Windows часто показывает кириллицу как кракозябры.
function csvEscapeCell(v) {
  const s = v === null || v === undefined ? '' : String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}
function buildCsv({ rows } = {}) {
  const data = Array.isArray(rows) ? rows : [];
  const lines = data.map((row) => (Array.isArray(row) ? row : [row]).map(csvEscapeCell).join(','));
  return Buffer.from('\uFEFF' + lines.join('\r\n'), 'utf8');
}

// ---------- RTF ----------
// Ручной минимальный RTF-writer: заголовки жирным, списки с префиксом, код — как обычный текст
// (RTF не умеет моноширинный шрифт без font table, а один шрифт на весь документ проще и надёжнее).
// Кириллица/любой юникод — через \uNNNN (RTF Unicode escape), с ASCII-фолбэком "?" следом,
// как требует спецификация RTF 1.9.1 §Unicode RTF.
function rtfEscapeText(text) {
  let out = '';
  for (const ch of String(text || '')) {
    const code = ch.codePointAt(0);
    if (ch === '\\' || ch === '{' || ch === '}') {
      out += '\\' + ch;
    } else if (code < 0x80) {
      out += ch;
    } else {
      out += `\\u${code}?`;
    }
  }
  return out;
}
function buildRtf({ content, title } = {}) {
  const blocks = parseBlocks(content);
  const parts = ['{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0 Calibri;}}\\f0\\fs22'];
  if (title) parts.push(`{\\b\\fs32 ${rtfEscapeText(title)}}\\par\\par`);
  for (const block of blocks) {
    if (block.type === 'heading') {
      const sizeMap = { 1: 30, 2: 26, 3: 24 };
      parts.push(`{\\b\\fs${sizeMap[block.level] || 24} ${rtfEscapeText(stripInlineMarkdown(block.text))}}\\par`);
    } else if (block.type === 'code') {
      for (const line of block.text.split('\n')) parts.push(`${rtfEscapeText(line || ' ')}\\par`);
    } else if (block.type === 'list') {
      block.items.forEach((item, idx) => {
        const prefix = block.ordered ? `${idx + 1}. ` : '\\bullet  ';
        parts.push(`${prefix}${rtfEscapeText(stripInlineMarkdown(item))}\\par`);
      });
    } else if (block.type === 'para') {
      parts.push(`${rtfEscapeText(stripInlineMarkdown(block.text))}\\par`);
    }
  }
  parts.push('}');
  return Buffer.from(parts.join('\n'), 'ascii');
}

// ---------- ODT ----------
// Минимальный валидный ODT (OpenDocument Text) — zip с mimetype (без сжатия, первым файлом,
// как требует спецификация), META-INF/manifest.xml и content.xml. Поддержаны заголовки,
// абзацы и списки (маркированные/нумерованные как обычные абзацы с префиксом — полноценные
// list-стили ODF ради простоты не реализованы, этого достаточно для читаемого документа
// в LibreOffice/Word). Код — как обычный абзац моноширинным стилем не помечен (та же причина, что в RTF).
function xmlEscape(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
}
async function buildOdt({ content, title } = {}) {
  const blocks = parseBlocks(content);
  const bodyParts = [];
  if (title) bodyParts.push(`<text:h text:style-name="Heading_20_1">${xmlEscape(title)}</text:h>`);
  for (const block of blocks) {
    if (block.type === 'heading') {
      const styleMap = { 1: 'Heading_20_1', 2: 'Heading_20_2', 3: 'Heading_20_3' };
      bodyParts.push(`<text:h text:style-name="${styleMap[block.level] || 'Heading_20_3'}">${xmlEscape(stripInlineMarkdown(block.text))}</text:h>`);
    } else if (block.type === 'code') {
      for (const line of block.text.split('\n')) bodyParts.push(`<text:p>${xmlEscape(line || ' ')}</text:p>`);
    } else if (block.type === 'list') {
      block.items.forEach((item, idx) => {
        const prefix = block.ordered ? `${idx + 1}. ` : '• ';
        bodyParts.push(`<text:p>${xmlEscape(prefix + stripInlineMarkdown(item))}</text:p>`);
      });
    } else if (block.type === 'para') {
      bodyParts.push(`<text:p>${xmlEscape(stripInlineMarkdown(block.text))}</text:p>`);
    }
  }
  if (!bodyParts.length) bodyParts.push('<text:p></text:p>');

  const contentXml =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" ' +
    'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" office:version="1.2">' +
    '<office:body><office:text>' +
    bodyParts.join('') +
    '</office:text></office:body></office:document-content>';

  const manifestXml =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.2">' +
    '<manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.text"/>' +
    '<manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>' +
    '</manifest:manifest>';

  return new Promise((resolve, reject) => {
    const archive = archiver('zip', { zlib: { level: 9 } });
    const chunks = [];
    archive.on('data', (c) => chunks.push(c));
    archive.on('error', reject);
    archive.on('end', () => resolve(Buffer.concat(chunks)));
    // mimetype должен идти первым и без сжатия — так его читает libreoffice/большинство ридеров.
    archive.append('application/vnd.oasis.opendocument.text', { name: 'mimetype', store: true });
    archive.append(manifestXml, { name: 'META-INF/manifest.xml' });
    archive.append(contentXml, { name: 'content.xml' });
    archive.finalize();
  });
}

module.exports = { buildPdf, buildDocx, buildXlsx, buildPptx, buildCsv, buildRtf, buildOdt };
