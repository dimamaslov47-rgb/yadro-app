// server/files.js
// Рабочая область файлов задачи для режима «Компьютер»: инструмент write_file сохраняет
// сюда файлы, а по завершении хода (или по запросу) они собираются в один итоговый архив
// и отдаются пользователю на скачивание. Каждый тред имеет свою изолированную папку —
// data/task-files/<threadId>/ — треды не видят файлы друг друга.
'use strict';

const fs = require('fs');
const path = require('path');
const archiver = require('archiver');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const FILES_ROOT = path.join(DATA_DIR, 'task-files');

// Максимальный размер одного файла и суммарный размер задачи — защита от того, что
// модель по ошибке (или в цикле) насохраняет мегабайты текста.
const MAX_FILE_BYTES = 2 * 1024 * 1024; // 2 МБ на файл
const MAX_TOTAL_BYTES = 20 * 1024 * 1024; // 20 МБ на тред

function safeName(name) {
  const base = path.basename(String(name || 'file.txt')).trim();
  // Убираем всё, кроме букв/цифр/точки/дефиса/подчёркивания — не даём выйти за пределы папки.
  const cleaned = base.replace(/[^\p{L}\p{N}._-]+/gu, '_').replace(/^\.+/, '') || 'file.txt';
  return cleaned.slice(0, 200);
}

function threadDir(threadId) {
  return path.join(FILES_ROOT, String(threadId));
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function dirSize(dir) {
  if (!fs.existsSync(dir)) return 0;
  return fs.readdirSync(dir).reduce((sum, f) => {
    try {
      return sum + fs.statSync(path.join(dir, f)).size;
    } catch {
      return sum;
    }
  }, 0);
}

// Сохраняет файл, возвращает { filename, bytes } либо бросает Error с понятным сообщением
// (тексты ошибок показываются модели как результат tool-вызова, поэтому пишем по-русски и кратко).
// `content` может быть обычной строкой (текстовый инструмент write_file, как раньше)
// или готовым Buffer (бинарные документы из server/documents.js — pdf/docx/xlsx/pptx/odt и т.п.,
// где приведение к utf8-строке испортило бы содержимое).
function writeTaskFile(threadId, filename, content) {
  const dir = threadDir(threadId);
  ensureDir(dir);
  const name = safeName(filename);
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(String(content ?? ''), 'utf8');
  if (buf.length > MAX_FILE_BYTES) {
    throw new Error(`Файл слишком большой (${buf.length} байт, лимит ${MAX_FILE_BYTES} байт)`);
  }
  const currentTotal = dirSize(dir);
  if (currentTotal + buf.length > MAX_TOTAL_BYTES) {
    throw new Error(`Превышен суммарный лимит файлов задачи (${MAX_TOTAL_BYTES} байт)`);
  }
  fs.writeFileSync(path.join(dir, name), buf);
  return { filename: name, bytes: buf.length };
}

function listTaskFiles(threadId) {
  const dir = threadDir(threadId);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => fs.statSync(path.join(dir, f)).isFile())
    .map((f) => ({ filename: f, bytes: fs.statSync(path.join(dir, f)).size }));
}

function hasTaskFiles(threadId) {
  return listTaskFiles(threadId).length > 0;
}

// Собирает все файлы треда в один .zip и возвращает Buffer. Если файл ровно один —
// вызывающий код (server.js) решает, отдавать ли его как есть или всё равно в zip;
// здесь всегда отдаём zip для простоты одного формата скачивания.
async function buildTaskZip(threadId) {
  const dir = threadDir(threadId);
  const files = listTaskFiles(threadId);
  if (files.length === 0) return null;

  return new Promise((resolve, reject) => {
    const archive = archiver('zip', { zlib: { level: 9 } });
    const chunks = [];
    archive.on('data', (c) => chunks.push(c));
    archive.on('error', reject);
    archive.on('end', () => resolve(Buffer.concat(chunks)));
    for (const f of files) {
      archive.file(path.join(dir, f.filename), { name: f.filename });
    }
    archive.finalize();
  });
}

// Очищает файлы треда — вызывается после успешной отдачи архива пользователю, чтобы то же
// самое задание не «доехало» повторно в следующем ответе, если агент продолжит работу в треде.
function clearTaskFiles(threadId) {
  const dir = threadDir(threadId);
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = { writeTaskFile, listTaskFiles, hasTaskFiles, buildTaskZip, clearTaskFiles, threadDir };
