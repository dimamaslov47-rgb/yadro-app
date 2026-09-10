// server/attachments.js
// Извлечение текста из загруженных документов и таблиц для вложений в чат — расширенный список
// форматов (документы, таблицы, презентации, структурированные/код-файлы). Изображения сюда не
// попадают — они кодируются в base64 прямо в браузере (см. public/script.js) и уходят в модель
// как multimodal image_url part, без похода на backend. Аудио/видео — отдельный путь
// (см. server/transcribe.js), сюда тоже не попадают.
'use strict';

const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const ExcelJS = require('exceljs');
const AdmZip = require('adm-zip');

// Защита от разбухания контекста одним вложением — обрезаем длинные документы.
const MAX_EXTRACTED_CHARS = 12000;

// Расширения, которые читаем как обычный UTF-8 текст без какой-либо дополнительной обработки:
// markdown/json/csv и самые частые языки программирования и конфиг-форматы.
const PLAIN_TEXT_EXT = new Set([
  '.txt', '.md', '.markdown', '.csv', '.json', '.yml', '.yaml', '.xml', '.log',
  '.py', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.sh', '.bash', '.ps1',
  '.c', '.cpp', '.h', '.hpp', '.java', '.go', '.rs', '.rb', '.php', '.sql',
  '.html', '.htm', '.css', '.ini', '.conf', '.toml', '.env',
]);

function extOf(name) {
  const m = /\.[a-z0-9]+$/i.exec(String(name || ''));
  return m ? m[0].toLowerCase() : '';
}

// ---------- RTF ----------
// Минимальный best-effort RTF→текст: \uNNNN? (юникод-escape, наш собственный формат генерации
// и большинство современных RTF), \'XX (шестнадцатеричный байт в кодировке cp1251 — так кодировали
// кириллицу старые версии Word; для другой кодовой страницы результат менее точен, но не мусорный),
// \par/\line как разрыв строки, остальные control words и группы {\*...} — просто убираем.
const CP1251_DECODER = new TextDecoder('windows-1251');
// Служебные RTF-группы (таблицы шрифтов/цветов/стилей, инфо генератора и т.п.) не содержат
// видимого текста для читателя — их целиком вырезаем по границам { }, иначе их
// содержимое (названия шрифтов и т.п.) попадает в результат как мусор.
const RTF_SKIP_GROUPS = new Set(['fonttbl', 'colortbl', 'stylesheet', 'info', 'generator', 'themedata', 'listtable', 'listoverridetable', '*', 'pict', 'object', 'shppict', 'nonshppict', 'fldinst', 'xmlnstbl']);
function rtfDropNonTextGroups(text) {
  let out = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (ch === '{') {
      let j = i + 1;
      while (j < n && text[j] === ' ') j++;
      let isSkip = false;
      if (text[j] === '\\') {
        let k = j + 1;
        if (text[k] === '*') {
          isSkip = true; // \* — флаг «ignorable» по RTF-спецификации: группа безопасна для пропуска целиком
        } else {
          let word = '';
          while (k < n && /[a-zA-Z]/.test(text[k])) { word += text[k]; k++; }
          isSkip = RTF_SKIP_GROUPS.has(word);
        }
      }
      if (isSkip) {
        let depth = 1;
        i++;
        while (i < n && depth > 0) {
          if (text[i] === '\\') { i += 2; continue; } // пропускаем escaped-символ, чтобы \{ \} не ломали счётчик глубины
          if (text[i] === '{') depth++;
          else if (text[i] === '}') depth--;
          i++;
        }
        continue;
      }
      i++; // обычная группа — саму скобку убираем, содержимое оставляем
      continue;
    }
    if (ch === '}') { i++; continue; }
    out += ch;
    i++;
  }
  return out;
}
function stripRtf(buffer) {
  let text = buffer.toString('latin1'); // latin1 — 1 байт = 1 code unit, безопасно для посимвольного парсинга
  text = rtfDropNonTextGroups(text);
  text = text.replace(/\\par[d]?\b|\\line\b/g, '\n');
  text = text.replace(/\\u(-?\d+)\s?\??/g, (_, code) => {
    const n = parseInt(code, 10);
    return String.fromCodePoint(n < 0 ? n + 65536 : n);
  });
  text = text.replace(/\\'([0-9a-fA-F]{2})/g, (_, hex) => {
    const byte = parseInt(hex, 16);
    if (byte < 0x80) return String.fromCharCode(byte);
    try { return CP1251_DECODER.decode(Buffer.from([byte])); } catch { return '?'; }
  });
  text = text.replace(/\\[a-zA-Z]+-?\d*/g, ' '); // остальные control words
  text = text.replace(/\\\r?\n/g, '\n');
  return text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

// ---------- ODT ----------
// ODT — zip с content.xml внутри (см. server/documents.js buildOdt). Заголовки/абзацы читаем как
// строки; таблицы/списки со сложной вложенностью не разбираются отдельно (best-effort).
function odtXmlToText(xml) {
  return xml
    .replace(/<\/text:h>/g, '\n')
    .replace(/<\/text:p>/g, '\n')
    .replace(/<text:line-break\s*\/?>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
function extractOdt(buffer) {
  const zip = new AdmZip(buffer);
  const entry = zip.getEntry('content.xml');
  if (!entry) throw new Error('Не найден content.xml внутри ODT — возможно, файл повреждён');
  return odtXmlToText(entry.getData().toString('utf8'));
}

// ---------- PPTX ----------
// Презентация — zip со слайдами ppt/slides/slideN.xml, текст лежит в тегах <a:t>...</a:t>.
function pptxXmlToText(xml) {
  const runs = [...xml.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => m[1]);
  return runs
    .join(' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .trim();
}
function extractPptx(buffer) {
  const zip = new AdmZip(buffer);
  const slideEntries = zip
    .getEntries()
    .filter((e) => /^ppt\/slides\/slide\d+\.xml$/.test(e.entryName))
    .sort((a, b) => {
      const na = parseInt(a.entryName.match(/slide(\d+)\.xml/)[1], 10);
      const nb = parseInt(b.entryName.match(/slide(\d+)\.xml/)[1], 10);
      return na - nb;
    });
  if (!slideEntries.length) throw new Error('Не найдено ни одного слайда внутри PPTX — возможно, файл повреждён');
  const parts = slideEntries.map((e, idx) => {
    const text = pptxXmlToText(e.getData().toString('utf8'));
    return `[Слайд ${idx + 1}]\n${text || '(пусто)'}`;
  });
  return parts.join('\n\n');
}

// ---------- XLSX/XLS ----------
// Табличные данные превращаем в текст со строками через табуляцию — компактно и понятно модели.
async function extractXlsx(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const parts = [];
  wb.eachSheet((ws) => {
    const rows = [];
    ws.eachRow((row) => {
      const cells = [];
      row.eachCell({ includeEmpty: true }, (cell) => cells.push(cell.value == null ? '' : String(cell.value)));
      rows.push(cells.join('\t'));
    });
    parts.push(`[Лист «${ws.name}»]\n${rows.join('\n')}`);
  });
  return parts.join('\n\n');
}

async function extractText(buffer, mimetype, originalName) {
  const name = (originalName || '').toLowerCase();
  const ext = extOf(name);
  let text = '';

  if (mimetype === 'application/pdf' || ext === '.pdf') {
    const data = await pdfParse(buffer);
    text = data.text || '';
  } else if (
    mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    ext === '.docx'
  ) {
    const result = await mammoth.extractRawText({ buffer });
    text = result.value || '';
  } else if (ext === '.doc') {
    throw new Error('Старый формат .doc (не .docx) не поддерживается — пересохраните файл как .docx и приложите снова');
  } else if (ext === '.rtf') {
    text = stripRtf(buffer);
  } else if (ext === '.odt') {
    text = extractOdt(buffer);
  } else if (
    mimetype === 'application/vnd.openxmlformats-officedocument.presentationml.presentation' ||
    ext === '.pptx'
  ) {
    text = extractPptx(buffer);
  } else if (
    mimetype === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
    ext === '.xlsx'
  ) {
    text = await extractXlsx(buffer);
  } else if (ext === '.xls') {
    // Старый бинарный формат Excel — exceljs его не читает; явно и понятно сообщаем об ограничении,
    // а не тихо возвращаем мусор из бинарных байт.
    throw new Error('Старый формат .xls (не .xlsx) не поддерживается — пересохраните файл как .xlsx и приложите снова');
  } else if ((mimetype || '').startsWith('text/') || PLAIN_TEXT_EXT.has(ext)) {
    text = buffer.toString('utf8');
  } else {
    throw new Error('Формат файла не поддерживается для чтения (документы, таблицы, презентации, markdown/json/код — см. список поддерживаемых расширений)');
  }
  text = text.trim();
  if (!text) throw new Error('Не удалось извлечь текст из файла (возможно, документ пустой или это сканы без текстового слоя)');
  const truncated = text.length > MAX_EXTRACTED_CHARS;
  return { text: text.slice(0, MAX_EXTRACTED_CHARS), truncated };
}

module.exports = { extractText, MAX_EXTRACTED_CHARS };
