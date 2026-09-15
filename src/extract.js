// Turns an uploaded Word/PDF/text file into something Claude can read.
// Text is preferred (cheaper). A PDF whose text layer is missing (scans) or garbled
// (visually-ordered Hebrew) is sent to Claude as a native PDF document instead.
import path from 'node:path';
import mammoth from 'mammoth';
// Import the library entry directly: pdf-parse's index.js runs a debug harness under ESM.
import pdfParse from 'pdf-parse/lib/pdf-parse.js';

export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const MAX_TEXT_CHARS = 600_000;

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

export async function extractDocument(file) {
  const name = decodeFileName(file.originalname || 'document');
  const ext = path.extname(name).toLowerCase();

  if (ext === '.docx') {
    const { value } = await mammoth.extractRawText({ buffer: file.buffer });
    return documentFromText(value, name);
  }
  if (ext === '.pdf') {
    let text = '';
    let pages = 0;
    try {
      const parsed = await pdfParse(file.buffer);
      text = normalize(parsed.text || '');
      pages = parsed.numpages || 0;
    } catch (err) {
      console.warn('[extract] pdf text extraction failed, falling back to native PDF', err.message);
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
