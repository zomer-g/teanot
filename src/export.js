// Exports of sentencing decisions and guidelines as PDF or DOCX: 13pt Arial, centered, line spacing 1.5, and
// margins of 3cm at the top and 2cm on the sides and at the bottom.
// Both formats render the same block list (title / heading / paragraph / page break).
//
// PDF: pdf-lib cannot shape or reorder right-to-left text, so lines are broken here in logical order and each line
// is reordered to visual order with bidi-js (Unicode Bidirectional Algorithm) before it is drawn. The font is
// Arimo (SIL Open Font License), which has the metrics of Arial, a Microsoft font that may not be bundled, so the
// lines break where Arial would break them. DOCX names "Arial" itself, which Word has.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { PDFDocument, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import bidiFactory from 'bidi-js';
import { AlignmentType, Document, Packer, Paragraph, TextRun } from 'docx';

const bidi = bidiFactory();

export const FONT_SIZE = 13;
const CM = 72 / 2.54;
const A4 = [595.28, 841.89];
const MARGIN_TOP = 3 * CM;
const MARGIN_SIDE = 2 * CM;
const MARGIN_BOTTOM = 2 * CM;
const TEXT_WIDTH = A4[0] - 2 * MARGIN_SIDE;
const LINE_SPACING = 1.5;
const SIZES = { title: 16, heading: 14, subheading: FONT_SIZE, paragraph: FONT_SIZE, meta: FONT_SIZE };
// Twentieths of a point: 567 = 1cm. Word counts line spacing in 240ths of a line, so 360 is 1.5 lines.
const DOCX_MARGIN = { top: 3 * 567, right: 2 * 567, bottom: 2 * 567, left: 2 * 567, header: 567, footer: 567 };
const DOCX_LINE = Math.round(240 * LINE_SPACING);
const DOCX_FONT = 'Arial';

// ---------- Block model ----------

export const title = (text) => ({ type: 'title', text });
export const heading = (text) => ({ type: 'heading', text });
export const subheading = (text) => ({ type: 'subheading', text });
export const paragraph = (text) => ({ type: 'paragraph', text });
export const meta = (text) => ({ type: 'meta', text });
export const pageBreak = () => ({ type: 'break' });
// PDF only: the pages of an original PDF document, inserted as they are.
export const originalPdf = (bytes) => ({ type: 'pdf', bytes });
// Long text becomes one paragraph per line break.
export const paragraphs = (text) => String(text ?? '').split(/\r?\n/).map((line) => paragraph(line));

const BOLD = new Set(['title', 'heading', 'subheading']);

// Bidi controls and zero-width characters are dropped (the algorithm has already used them), and Hebrew points and
// cantillation, which pdf-lib would draw without positioning, are removed from the PDF only.
const INVISIBLE = /[​-‏‪-‮⁦-⁩﻿­]/g;
const HEBREW_MARKS = /[֑-ֽֿׁׂׄ-ׇ]/g;
const clean = (text) => String(text ?? '').replace(/\t/g, ' ').replace(INVISIBLE, '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');

// ---------- PDF ----------

const fontDir = path.join(path.dirname(createRequire(import.meta.url).resolve('@fontsource/arimo/package.json')), 'files');
const FONT_SUBSETS = ['hebrew', 'latin', 'latin-ext', 'greek', 'cyrillic'];
const fontBytes = (weight) => FONT_SUBSETS
  .map((subset) => path.join(fontDir, `arimo-${subset}-${weight}-normal.woff`))
  .filter((file) => fs.existsSync(file))
  .map((file) => fs.readFileSync(file));
let fontFiles = null;

async function embedFonts(doc) {
  fontFiles ??= { regular: fontBytes(400), bold: fontBytes(700) };
  doc.registerFontkit(fontkit);
  const load = (list) => Promise.all(list.map(async (bytes) => {
    const fk = fontkit.create(bytes);
    return { pdf: await doc.embedFont(bytes, { subset: true }), fk, scale: 1 / fk.unitsPerEm, widths: new Map() };
  }));
  return { regular: await load(fontFiles.regular), bold: await load(fontFiles.bold) };
}

const HEBREW_LETTER = /[֐-׿יִ-ﭏ]/;

// Splits a visual-order string into runs of one font each. Characters no font has are dropped.
function fontRuns(text, fonts) {
  const runs = [];
  let current = null;
  for (const char of text) {
    const cp = char.codePointAt(0);
    const font = current?.font.fk.hasGlyphForCodePoint(cp) ? current.font : fonts.find((f) => f.fk.hasGlyphForCodePoint(cp));
    if (!font) continue;
    if (current && current.font === font) current.text += char;
    else runs.push(current = { font, text: char });
  }
  return runs;
}

function charWidth(font, char, size) {
  let width = font.widths.get(char);
  if (width === undefined) {
    width = font.fk.glyphForCodePoint(char.codePointAt(0)).advanceWidth * font.scale;
    font.widths.set(char, width);
  }
  return width * size;
}

function measure(text, fonts, size) {
  let width = 0;
  for (const run of fontRuns(text, fonts)) for (const char of run.text) width += charWidth(run.font, char, size);
  return width;
}

// Visual order of text[start..end) under the paragraph's embedding levels, with mirrored brackets.
function visualLine(text, levels, start, end) {
  const order = [];
  for (let i = start; i < end; i++) order.push(i);
  for (const [from, to] of bidi.getReorderSegments(text, levels, start, end - 1)) {
    const a = from - start;
    const b = to - start;
    for (let i = a, j = b; i < j; i++, j--) [order[i], order[j]] = [order[j], order[i]];
  }
  const mirrored = bidi.getMirroredCharactersMap(text, levels.levels, start, end - 1);
  return order.map((i) => mirrored.get(i) ?? text[i]).join('');
}

// Greedy line breaking on spaces, in logical order. A word wider than the line is split by characters.
function breakLines(text, fonts, size) {
  const space = measure(' ', fonts, size);
  const lines = [];
  let lineStart = -1;
  let lineEnd = -1;
  let lineWidth = 0;
  for (const match of text.matchAll(/\S+/g)) {
    let start = match.index;
    const end = start + match[0].length;
    let width = measure(match[0], fonts, size);
    if (lineStart >= 0 && lineWidth + space + width <= TEXT_WIDTH) {
      lineEnd = end;
      lineWidth += space + width;
      continue;
    }
    if (lineStart >= 0) lines.push([lineStart, lineEnd]);
    while (width > TEXT_WIDTH) {
      let cut = start;
      let w = 0;
      while (cut < end && w + measure(text[cut], fonts, size) <= TEXT_WIDTH) w += measure(text[cut++], fonts, size);
      if (cut === start) cut++;
      lines.push([start, cut]);
      start = cut;
      width = measure(text.slice(start, end), fonts, size);
    }
    [lineStart, lineEnd, lineWidth] = [start, end, width];
  }
  if (lineStart >= 0) lines.push([lineStart, lineEnd]);
  return lines;
}

class PdfWriter {
  constructor(doc, fonts) {
    this.doc = doc;
    this.fonts = fonts;
    this.page = null;
    this.y = 0;
  }

  newPage() {
    this.page = this.doc.addPage(A4);
    this.y = A4[1] - MARGIN_TOP;
  }

  space(points) {
    if (!this.page) this.newPage();
    this.y -= points;
  }

  // fontkit reverses a run it detects as Hebrew script, so such a run is handed over in reverse and comes out in
  // the visual order computed here.
  drawLine(visual, fonts, size, color) {
    const lineHeight = size * LINE_SPACING;
    if (!this.page || this.y - lineHeight < MARGIN_BOTTOM) this.newPage();
    this.y -= lineHeight;
    const runs = fontRuns(visual, fonts);
    const width = runs.reduce((sum, run) => sum + [...run.text].reduce((w, ch) => w + charWidth(run.font, ch, size), 0), 0);
    let x = MARGIN_SIDE + (TEXT_WIDTH - width) / 2;
    const baseline = this.y + size * 0.3;
    for (const run of runs) {
      const text = HEBREW_LETTER.test(run.text) ? [...run.text].reverse().join('') : run.text;
      this.page.drawText(text, { x, y: baseline, size, font: run.font.pdf, color });
      x += [...run.text].reduce((w, ch) => w + charWidth(run.font, ch, size), 0);
    }
  }

  block(block) {
    if (block.type === 'break') {
      this.page = null;
      return;
    }
    const size = SIZES[block.type] ?? FONT_SIZE;
    const fonts = BOLD.has(block.type) ? this.fonts.bold : this.fonts.regular;
    const color = block.type === 'meta' ? rgb(0.25, 0.27, 0.3) : rgb(0, 0, 0);
    const text = clean(block.text).replace(HEBREW_MARKS, '').replace(/\s+$/, '');
    if (block.type === 'heading' || block.type === 'subheading') this.space(size * 0.6);
    if (!text.trim()) {
      this.space(size * 0.75);
      return;
    }
    const levels = bidi.getEmbeddingLevels(text, 'rtl');
    for (const [start, end] of breakLines(text, fonts, size)) this.drawLine(visualLine(text, levels, start, end), fonts, size, color);
    this.space(block.type === 'title' ? size * 0.8 : size * 0.35);
  }
}

// sourcePdf: bytes of an original PDF to put first, as is. Returns a Buffer.
export async function renderPdf(blocks, { sourcePdf = null, docTitle = null } = {}) {
  const doc = await PDFDocument.create();
  if (docTitle) doc.setTitle(docTitle);
  doc.setLanguage('he');
  if (sourcePdf) {
    const source = await PDFDocument.load(sourcePdf, { ignoreEncryption: true });
    for (const page of await doc.copyPages(source, source.getPageIndices())) doc.addPage(page);
  }
  const writer = new PdfWriter(doc, await embedFonts(doc));
  for (const block of blocks) {
    // An original document inserted as is (its own pages); the next text starts on a fresh page.
    if (block.type === 'pdf') {
      const source = await PDFDocument.load(block.bytes, { ignoreEncryption: true });
      for (const page of await doc.copyPages(source, source.getPageIndices())) doc.addPage(page);
      writer.page = null;
      continue;
    }
    writer.block(block);
  }
  if (!doc.getPageCount()) writer.newPage();
  return Buffer.from(await doc.save());
}

// Whether an uploaded PDF can be copied into an export (encrypted or damaged files cannot).
export async function canEmbedPdf(bytes) {
  try {
    await PDFDocument.load(bytes, { ignoreEncryption: true });
    return true;
  } catch {
    return false;
  }
}

// ---------- DOCX ----------

export async function renderDocx(blocks, { docTitle = null } = {}) {
  const children = [];
  let breakBefore = false;
  for (const block of blocks) {
    if (block.type === 'break') {
      breakBefore = children.length > 0;
      continue;
    }
    const size = SIZES[block.type] ?? FONT_SIZE;
    const bold = BOLD.has(block.type);
    children.push(new Paragraph({
      bidirectional: true,
      alignment: AlignmentType.CENTER,
      pageBreakBefore: breakBefore,
      spacing: { line: DOCX_LINE, lineRule: 'auto', after: block.type === 'title' ? 240 : 80, before: bold && block.type !== 'title' ? 160 : 0 },
      children: [new TextRun({
        text: clean(block.text),
        bold,
        boldComplexScript: bold,
        rightToLeft: true,
        size: size * 2,
        sizeComplexScript: size * 2,
        color: block.type === 'meta' ? '40454D' : undefined,
        font: { ascii: DOCX_FONT, hAnsi: DOCX_FONT, cs: DOCX_FONT, eastAsia: DOCX_FONT },
      })],
    }));
    breakBefore = false;
  }
  const doc = new Document({
    title: docTitle ?? undefined,
    styles: { default: { document: { run: { font: DOCX_FONT, size: FONT_SIZE * 2 } } } },
    sections: [{
      properties: {
        page: { size: { width: 11906, height: 16838 }, margin: DOCX_MARGIN },
        bidi: true,
      },
      children,
    }],
  });
  return Packer.toBuffer(doc);
}
