// Turns an uploaded Word/PDF/text file into something Claude can read.
// Parsing untrusted files happens in a worker thread with a memory cap and a timeout (extract-worker.js),
// so a zip bomb or a hostile PDF fails the request instead of taking the server down.
// Text is preferred (cheaper). A PDF whose text layer is missing (scans) or garbled (visually-ordered
// Hebrew) is sent to Claude as a native PDF document instead.
import path from 'node:path';
import { Worker } from 'node:worker_threads';

export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const MAX_TEXT_CHARS = 600_000;
const WORKER_TIMEOUT_MS = 60_000;
const WORKER_LIMITS = { maxOldGenerationSizeMb: 512, maxYoungGenerationSizeMb: 64 };

export class UserFacingError extends Error {}

const normalize = (text) =>
  text.replace(/\r\n?/g, '\n').replace(/[ \t ]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();

// Busboy decodes multipart filenames as latin1; recover UTF-8 (Hebrew) names.
export function decodeFileName(name) {
  const recovered = Buffer.from(name, 'latin1').toString('utf8');
  return recovered.includes('�') ? name : recovered;
}

const count = (text, re) => (text.match(re) || []).length;

function pdfTextIsUsable(text, pages) {
  if (text.length < 400) return false;
  // Scanned pages with only a typed header/stamp carry very little text per page.
  if (pages > 0 && text.length / pages < 250) return false;
  const hebrew = count(text, /[א-ת]/g);
  if (hebrew < 100) return true; // not Hebrew — let the classifier decide
  // Visually-ordered extraction reverses words: "של" comes out as "לש".
  const logical = count(text, /(^|\s)(של|את|על|כי|הנאשם)(?=\s|$)/g);
  const reversed = count(text, /(^|\s)(לש|תא|לע|יכ|םשאנה)(?=\s|$)/g);
  return logical >= reversed;
}

function assertLength(text) {
  if (text.length > MAX_TEXT_CHARS) {
    throw new UserFacingError('המסמך ארוך מדי לניתוח (מעל 600 אלף תווים). יש לצרף את החלק הרלוונטי בלבד.');
  }
  if (text.length < 200) {
    throw new UserFacingError('לא נמצא במסמך טקסט מספיק לניתוח.');
  }
  return text;
}

export function documentFromText(text, name = 'טקסט שהודבק') {
  return { kind: 'text', name, text: assertLength(normalize(text)) };
}

function parseInWorker(kind, buffer) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./extract-worker.js', import.meta.url), {
      workerData: { kind, buffer },
      resourceLimits: WORKER_LIMITS,
    });
    let settled = false;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate();
      fn(value);
    };
    const timer = setTimeout(() => settle(reject, new Error('extraction timed out')), WORKER_TIMEOUT_MS);
    worker.on('message', (message) => {
      if (message.ok) settle(resolve, message);
      else settle(reject, message.userError ? new UserFacingError(message.userError) : new Error(message.error));
    });
    worker.on('error', (err) => settle(reject, err)); // includes ERR_WORKER_OUT_OF_MEMORY
    worker.on('exit', (code) => settle(reject, new Error(`extraction worker exited with code ${code}`)));
  });
}

export async function extractDocument(file) {
  const name = decodeFileName(file.originalname || 'document');
  const ext = path.extname(name).toLowerCase();

  if (ext === '.docx') {
    let text;
    try {
      ({ text } = await parseInWorker('docx', file.buffer));
    } catch (err) {
      if (err instanceof UserFacingError) throw err;
      console.warn('[extract] docx parsing failed', err.message);
      throw new UserFacingError('לא ניתן היה לקרוא את קובץ ה-Word. נסו לשמור אותו מחדש או לצרף אותו כ-PDF.');
    }
    return documentFromText(text, name);
  }
  if (ext === '.pdf') {
    if (!file.buffer.subarray(0, 1024).toString('latin1').includes('%PDF-')) {
      throw new UserFacingError('הקובץ אינו PDF תקין.');
    }
    let text = '';
    let pages = 0;
    try {
      const parsed = await parseInWorker('pdf', file.buffer);
      text = normalize(parsed.text || '');
      pages = parsed.pages || 0;
    } catch (err) {
      if (err instanceof UserFacingError) throw err;
      console.warn('[extract] pdf text extraction failed, sending the PDF itself', err.message);
    }
    if (pdfTextIsUsable(text, pages)) return { kind: 'text', name, text: assertLength(text), pages };
    return { kind: 'pdf', name, base64: file.buffer.toString('base64') };
  }
  if (ext === '.txt' || ext === '.md') {
    return documentFromText(file.buffer.toString('utf8'), name);
  }
  if (ext === '.doc') {
    throw new UserFacingError('קובץ Word בפורמט הישן (.doc) אינו נתמך. יש לשמור אותו כ-docx או כ-PDF ולצרף שוב.');
  }
  throw new UserFacingError('ניתן לצרף קובצי Word (docx), PDF או טקסט בלבד.');
}

// A one-page PDF built in memory, used to prove at boot that PDF parsing works on this runtime.
function probePdf(text) {
  const content = `BT /F1 12 Tf 20 50 Td (${text}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 100] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = objects.map((body, i) => {
    const offset = pdf.length;
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
    return offset;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

export async function probePdfExtraction() {
  const expected = 'teanot selfcheck';
  const { text, pages } = await parseInWorker('pdf', probePdf(expected));
  return { pages, textFound: normalize(text || '').includes(expected) };
}

// The Claude content block that carries the document in the first user turn.
export function documentBlock(doc) {
  if (doc.kind === 'pdf') {
    return {
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: doc.base64 },
      title: doc.name,
    };
  }
  return {
    type: 'document',
    source: { type: 'text', media_type: 'text/plain', data: doc.text },
    title: doc.name,
  };
}
