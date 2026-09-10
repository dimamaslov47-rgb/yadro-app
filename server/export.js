// server/export.js
// Экспорт ответа ИИ в .docx и .pdf на сервере (без внешних API, чистый Node).
'use strict';

const path = require('path');
const {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
} = require('docx');
const PDFDocument = require('pdfkit');

// DejaVu Sans поддерживает кириллицу — встроенные Base14-шрифты PDFKit её не знают.
const FONT_REGULAR = path.join(__dirname, 'fonts', 'DejaVuSans.ttf');
const FONT_BOLD = path.join(__dirname, 'fonts', 'DejaVuSans-Bold.ttf');

// Очень простой построчный парсер markdown-подобного текста.
// Не пытаемся полноценно поддержать весь markdown — только то,
// что реально встречается в ответах модели: заголовки (#, ##, ###),
// маркированные/нумерованные списки, блоки кода (```), обычные абзацы.
function parseBlocks(text) {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    if (/^```/.test(line)) {
      const lang = line.replace(/^```/, '').trim();
      const codeLines = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // skip closing ```
      blocks.push({ type: 'code', lang, text: codeLines.join('\n') });
      continue;
    }

    const heading = line.match(/^(#{1,3})\s+(.*)$/);
    if (heading) {
      blocks.push({ type: 'heading', level: heading[1].length, text: heading[2] });
      i++;
      continue;
    }

    if (/^\s*[-*]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*]\s+/, ''));
        i++;
      }
      blocks.push({ type: 'list', ordered: false, items });
      continue;
    }

    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+[.)]\s+/, ''));
        i++;
      }
      blocks.push({ type: 'list', ordered: true, items });
      continue;
    }

    if (line.trim() === '') {
      i++;
      continue;
    }

    const paraLines = [line];
    i++;
    while (i < lines.length && lines[i].trim() !== '' && !/^```/.test(lines[i]) && !/^(#{1,3})\s+/.test(lines[i]) && !/^\s*[-*]\s+/.test(lines[i]) && !/^\s*\d+[.)]\s+/.test(lines[i])) {
      paraLines.push(lines[i]);
      i++;
    }
    blocks.push({ type: 'para', text: paraLines.join(' ') });
  }
  return blocks;
}

// Убирает базовую markdown-разметку (**bold**, *italic*, `code`) для простого текстового вывода.
function stripInlineMarkdown(text) {
  return String(text || '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/`(.+?)`/g, '$1');
}

async function buildDocx(text, title) {
  const blocks = parseBlocks(text);
  const children = [];

  if (title) {
    children.push(new Paragraph({ text: title, heading: HeadingLevel.HEADING_1 }));
  }

  for (const block of blocks) {
    if (block.type === 'heading') {
      const levelMap = { 1: HeadingLevel.HEADING_1, 2: HeadingLevel.HEADING_2, 3: HeadingLevel.HEADING_3 };
      children.push(new Paragraph({ text: stripInlineMarkdown(block.text), heading: levelMap[block.level] || HeadingLevel.HEADING_3 }));
    } else if (block.type === 'code') {
      for (const codeLine of block.text.split('\n')) {
        children.push(
          new Paragraph({
            children: [new TextRun({ text: codeLine || ' ', font: 'Consolas', size: 20 })],
            shading: { fill: 'F2F2F2' },
          })
        );
      }
    } else if (block.type === 'list') {
      block.items.forEach((item, idx) => {
        const prefix = block.ordered ? `${idx + 1}. ` : '• ';
        children.push(new Paragraph({ text: prefix + stripInlineMarkdown(item) }));
      });
    } else if (block.type === 'para') {
      children.push(new Paragraph({ text: stripInlineMarkdown(block.text) }));
    }
  }

  if (children.length === 0) {
    children.push(new Paragraph({ text: '' }));
  }

  const doc = new Document({
    sections: [{ properties: {}, children }],
  });
  return Packer.toBuffer(doc);
}

function buildPdf(text, title) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50 });
    doc.registerFont('Body', FONT_REGULAR);
    doc.registerFont('Body-Bold', FONT_BOLD);
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.font('Body');

    if (title) {
      doc.fontSize(16).font('Body-Bold').text(title, { align: 'left' });
      doc.moveDown(0.5);
    }

    const blocks = parseBlocks(text);
    for (const block of blocks) {
      if (block.type === 'heading') {
        const sizeMap = { 1: 15, 2: 13, 3: 12 };
        doc.fontSize(sizeMap[block.level] || 12).font('Body-Bold').text(stripInlineMarkdown(block.text));
        doc.moveDown(0.3);
      } else if (block.type === 'code') {
        doc.fontSize(9).font('Body');
        doc.text(block.text || ' ', { align: 'left' });
        doc.moveDown(0.3);
      } else if (block.type === 'list') {
        doc.fontSize(11).font('Body');
        block.items.forEach((item, idx) => {
          const prefix = block.ordered ? `${idx + 1}. ` : '• ';
          doc.text(prefix + stripInlineMarkdown(item));
        });
        doc.moveDown(0.2);
      } else if (block.type === 'para') {
        doc.fontSize(11).font('Body').text(stripInlineMarkdown(block.text), { align: 'left' });
        doc.moveDown(0.2);
      }
    }

    doc.end();
  });
}

// parseBlocks/stripInlineMarkdown также используются server/documents.js (rtf/odt) —
// один и тот же разбор markdown-подобного текста для всех текстовых форматов.
module.exports = { buildDocx, buildPdf, parseBlocks, stripInlineMarkdown };
