// Runs inside a worker thread started by extract.js: parses one untrusted file and posts back its text.
// The worker has its own memory cap, so a decompression bomb or pathological PDF only kills the worker.
import { createRequire } from 'node:module';
import path from 'node:path';
import zlib from 'node:zlib';
import { parentPort, workerData } from 'node:worker_threads';

const MAX_PDF_PAGES = 600;
const MAX_CHARS = 700_000;
const MAX_DOCX_INFLATED_BYTES = 120 * 1024 * 1024;
const MAX_DOCX_ENTRIES = 5000;

class UserError extends Error {}

// A .docx is a zip. The sizes it declares can lie, so every entry is actually inflated here with a hard
// output cap (zlib maxOutputLength) before mammoth touches it. This bounds memory — including ArrayBuffer
// memory, which the worker's heap limit does not cover — against decompression bombs.
function verifyDocx(buffer) {
  const corrupt = () => new UserError('קובץ ה-Word פגום או אינו בפורמט docx.');
  const floor = Math.max(0, buffer.length - 65_557);
  let eocd = -1;
  for (let i = buffer.length - 22; i >= floor; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw corrupt();
  const entries = buffer.readUInt16LE(eocd + 10);
  const directoryOffset = buffer.readUInt32LE(eocd + 16);
  if (entries > MAX_DOCX_ENTRIES || directoryOffset > buffer.length) throw corrupt();
  let budget = MAX_DOCX_INFLATED_BYTES;
  let pos = directoryOffset;
  for (let n = 0; n < entries; n++) {
    if (pos + 46 > buffer.length || buffer.readUInt32LE(pos) !== 0x02014b50) throw corrupt();
    const method = buffer.readUInt16LE(pos + 10);
    const compressedSize = buffer.readUInt32LE(pos + 20);
    const localOffset = buffer.readUInt32LE(pos + 42);
    pos += 46 + buffer.readUInt16LE(pos + 28) + buffer.readUInt16LE(pos + 30) + buffer.readUInt16LE(pos + 32);
    if (compressedSize === 0xffffffff || localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== 0x04034b50) throw corrupt();
    const start = localOffset + 30 + buffer.readUInt16LE(localOffset + 26) + buffer.readUInt16LE(localOffset + 28);
    if (start + compressedSize > buffer.length) throw corrupt();
    let size;
    if (method === 0) {
      size = compressedSize;
    } else if (method === 8) {
      try {
        size = zlib.inflateRawSync(buffer.subarray(start, start + compressedSize), { maxOutputLength: budget + 1 }).length;
      } catch (err) {
        if (err.code === 'ERR_BUFFER_TOO_LARGE' || err instanceof RangeError) throw new UserError('קובץ ה-Word גדול מדי לעיבוד. יש לצרף גרסה קטנה יותר או את החלק הרלוונטי.');
        throw corrupt();
      }
    } else {
      throw corrupt();
    }
    budget -= size;
    if (budget < 0) throw new UserError('קובץ ה-Word גדול מדי לעיבוד. יש לצרף גרסה קטנה יותר או את החלק הרלוונטי.');
  }
}

async function docxText(bytes) {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  verifyDocx(buffer);
  const { default: mammoth } = await import('mammoth');
  const { value } = await mammoth.extractRawText({ buffer });
  return { text: value };
}

async function pdfText(bytes) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  // pdf.js wants directory "URLs" with forward slashes and a trailing slash, on Windows too.
  const pdfjsDir = path.dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json')).replaceAll('\\', '/');
  const loadingTask = pdfjs.getDocument({
    data: bytes,
    isEvalSupported: false, // never compile code from font data
    disableFontFace: true,
    useSystemFonts: false,
    verbosity: 0,
    cMapUrl: `${pdfjsDir}/cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${pdfjsDir}/standard_fonts/`,
  });
  try {
    const doc = await loadingTask.promise;
    if (doc.numPages > MAX_PDF_PAGES) {
      return { userError: `קובץ ה-PDF ארוך מדי (${doc.numPages} עמודים; עד ${MAX_PDF_PAGES}). יש לצרף את החלק הרלוונטי.` };
    }
    let text = '';
    for (let i = 1; i <= doc.numPages && text.length < MAX_CHARS; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      let lastY;
      for (const item of content.items) {
        if (typeof item.str !== 'string') continue;
        const y = item.transform[5];
        if (lastY !== undefined && Math.abs(y - lastY) > 1) text += '\n';
        text += item.str;
        if (item.hasEOL) {
          text += '\n';
          lastY = undefined;
        } else {
          lastY = y;
        }
      }
      text += '\n\n';
      page.cleanup();
    }
    return { text, pages: doc.numPages };
  } finally {
    await loadingTask.destroy();
  }
}

try {
  const result = workerData.kind === 'docx' ? await docxText(workerData.buffer) : await pdfText(workerData.buffer);
  parentPort.postMessage(result.userError ? { ok: false, userError: result.userError } : { ok: true, ...result });
} catch (err) {
  parentPort.postMessage(err instanceof UserError
    ? { ok: false, userError: err.message }
    : { ok: false, error: String(err?.message || err) });
}
