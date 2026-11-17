import { fork } from 'node:child_process';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import yauzl from 'yauzl';
import sax from 'sax';

export const MAX_GROUP_FILE_BYTES = 16 * 1024 * 1024;
const MAX_TEXT = 16000;
const MAX_XML_BYTES = 8 * 1024 * 1024;
const MAX_PDF_PAGES = 30;
const MAX_PARSE_MS = 10000;
const PARSER_ARG = '--parse-group-file-text';
const TEXT_EXTENSIONS = new Set(['.txt', '.md', '.json', '.csv', '.tsv', '.log']);
const OFFICE_EXTENSIONS = new Set(['.docx', '.xlsx', '.pptx']);

export function supportsGroupFile(name) {
  const ext = path.extname(name).toLowerCase();
  return TEXT_EXTENSIONS.has(ext) || OFFICE_EXTENSIONS.has(ext) || ext === '.pdf';
}

function decodeText(buffer) {
  if (buffer[0] === 0xff && buffer[1] === 0xfe) return new TextDecoder('utf-16le', { fatal: true }).decode(buffer);
  if (buffer[0] === 0xfe && buffer[1] === 0xff) return new TextDecoder('utf-16be', { fatal: true }).decode(buffer);
  return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
}

function parseXml(buffer, handlers) {
  const parser = sax.parser(true, { strictEntities: true });
  parser.ondoctype = () => { throw new Error('文档包含不受支持的 DTD'); };
  Object.assign(parser, handlers);
  parser.oncdata = parser.ontext;
  parser.write(decodeText(buffer)).close();
}

function officeSection(ext, name) {
  if (ext === '.docx') return name === 'word/document.xml';
  if (ext === '.pptx') return /^ppt\/slides\/slide\d+\.xml$/.test(name);
  return name === 'xl/sharedStrings.xml' || /^xl\/worksheets\/sheet\d+\.xml$/.test(name);
}

async function readOffice(buffer, ext) {
  const archive = await yauzl.fromBufferPromise(buffer, { lazyEntries: true, autoClose: false, strictFileNames: true });
  try {
    if (archive.entryCount > 4096) throw new Error('文档内条目过多');
    const parts = new Map();
    let xmlBytes = 0;
    for await (const entry of archive.eachEntry()) {
      if (!officeSection(ext, entry.fileName)) continue;
      xmlBytes += entry.uncompressedSize;
      if (xmlBytes > MAX_XML_BYTES || parts.size >= 100 || parts.has(entry.fileName)) throw new Error('文档结构超过解析上限');
      const chunks = [];
      const stream = await archive.openReadStreamPromise(entry);
      for await (const chunk of stream) chunks.push(chunk);
      parts.set(entry.fileName, Buffer.concat(chunks));
    }
    return parts;
  } finally {
    archive.close();
  }
}

function columnNumber(reference) {
  const letters = /^([A-Z]{1,3})[1-9]\d*$/.exec(reference ?? '')?.[1];
  if (!letters) return 0;
  let column = 0;
  for (const letter of letters) column = column * 26 + letter.charCodeAt(0) - 64;
  return column;
}

function spreadsheetText(parts) {
  const strings = [];
  const shared = parts.get('xl/sharedStrings.xml');
  if (shared) {
    let text = '';
    let inText = false;
    parseXml(shared, {
      onopentag: ({ name }) => { if (name === 't') inText = true; },
      ontext: (value) => { if (inText) text += value; },
      onclosetag: (name) => {
        if (name === 't') inText = false;
        if (name === 'si') { strings.push(text); text = ''; }
      }
    });
    parts.delete('xl/sharedStrings.xml');
  }
  let result = '';
  let hasValue = false;
  for (const [name, xml] of parts) {
    result += `[${path.basename(name, '.xml')}]\n`;
    let cell;
    let inValue = false;
    let nextColumn = 1;
    parseXml(xml, {
      onopentag: ({ name, attributes }) => {
        if (name === 'c') cell = { type: attributes.t, value: '', column: columnNumber(attributes.r) };
        if (name === 'v' || name === 't') inValue = true;
      },
      ontext: (value) => { if (cell && inValue) cell.value += value; },
      onclosetag: (name) => {
        if (name === 'v' || name === 't') inValue = false;
        if (name === 'c' && cell) {
          const gap = Math.max(0, cell.column - nextColumn);
          const value = cell.type === 's' ? (strings[Number(cell.value)] ?? '') : cell.value;
          if (value.trim()) hasValue = true;
          if (result.length <= MAX_TEXT) {
            result += '\t'.repeat(Math.min(gap, MAX_TEXT + 1 - result.length));
            result += `${value.slice(0, MAX_TEXT)}\t`;
          }
          nextColumn += gap + 1;
          cell = null;
        }
        if (name === 'row') {
          nextColumn = 1;
          if (result.length <= MAX_TEXT) result += '\n';
        }
      }
    });
    if (hasValue && result.length > MAX_TEXT) break;
  }
  return hasValue ? result : '';
}

function documentText(parts, ext) {
  const prefix = ext === '.docx' ? 'w' : 'a';
  let text = '';
  for (const [, xml] of parts) {
    let inText = false;
    let inWordRun = false;
    parseXml(xml, {
      onopentag: ({ name }) => {
        if (name === `${prefix}:t`) inText = true;
        if (name === 'w:r') inWordRun = true;
        if (text.length > MAX_TEXT) return;
        if (name === 'a:br' || (inWordRun && (name === 'w:br' || name === 'w:cr'))) text += '\n';
        if (inWordRun && name === 'w:tab') text += '\t';
      },
      ontext: (value) => { if (inText && text.length <= MAX_TEXT) text += value.slice(0, MAX_TEXT); },
      onclosetag: (name) => {
        if (name === 'w:r') inWordRun = false;
        if (name === `${prefix}:t`) inText = false;
        if (name === `${prefix}:p` && text.length <= MAX_TEXT) text += '\n';
      }
    });
    if (text.length > MAX_TEXT) break;
  }
  return text;
}

async function pdfText(buffer) {
  if (!buffer.subarray(0, 1024).includes('%PDF-')) throw new Error('PDF 文件格式无效');
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const pdfRoot = path.dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'));
  const task = getDocument({
    data: Uint8Array.from(buffer), isEvalSupported: false, disableFontFace: true, useSystemFonts: false,
    useWorkerFetch: false, enableXfa: false, stopAtErrors: true, verbosity: 0,
    cMapUrl: `${pdfRoot}/cmaps/`, cMapPacked: true,
    standardFontDataUrl: `${pdfRoot}/standard_fonts/`
  });
  try {
    const pdf = await task.promise;
    let text = '';
    for (let i = 1; i <= Math.min(pdf.numPages, MAX_PDF_PAGES); i++) {
      const page = await pdf.getPage(i);
      const { items } = await page.getTextContent();
      for (const item of items) {
        if (typeof item.str !== 'string') continue;
        text += item.str.slice(0, MAX_TEXT) + (item.hasEOL ? '\n' : ' ');
        if (text.length > MAX_TEXT) break;
      }
      page.cleanup();
      if (text.length > MAX_TEXT) break;
      text += '\n';
    }
    return { text, truncated: pdf.numPages > MAX_PDF_PAGES };
  } finally {
    await task.destroy();
  }
}

async function extract(buffer, ext) {
  if (ext === '.pdf') return pdfText(buffer);
  if (TEXT_EXTENSIONS.has(ext)) {
    let text;
    try {
      text = decodeText(buffer);
    } catch {
      // QQ attachments from older Windows tools often use GB18030.
      text = new TextDecoder('gb18030', { fatal: true }).decode(buffer);
    }
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text)) throw new Error('文件包含二进制数据');
    return { text };
  }
  const office = await readOffice(buffer, ext);
  const parts = new Map([...office].sort(([a], [b]) => a.localeCompare(b, 'en', { numeric: true })));
  return { text: ext === '.xlsx' ? spreadsheetText(parts) : documentText(parts, ext) };
}

if (process.argv[2] === PARSER_ARG && typeof process.send === 'function') {
  process.once('message', async ({ bytes, ext }) => {
    let message;
    try {
      const result = await extract(Buffer.from(bytes), ext);
      const text = result.text.trim();
      message = { text: text.slice(0, MAX_TEXT), truncated: Boolean(result.truncated || text.length > MAX_TEXT) };
    } catch {
      message = { error: '文件格式无效、受保护或超过解析上限' };
    }
    if (process.connected) process.send(message, () => {
      if (process.connected) process.disconnect();
    });
  });
}

let activeJobs = 0;

export async function extractGroupFileText(buffer, name) {
  if (!supportsGroupFile(name)) throw new Error('不支持此附件格式');
  if (!buffer.length || buffer.length > MAX_GROUP_FILE_BYTES) throw new Error('文件为空或超过 16 MB');
  if (activeJobs >= 2) throw new Error('附件解析繁忙');
  const ext = path.extname(name).toLowerCase();
  activeJobs++;
  try {
    return await new Promise((resolve, reject) => {
      // PDF.js loads a native canvas binding. Keep native failures out of the Agent process.
      const execPath = process.versions.electron
        ? fileURLToPath(new URL('../../../runtime/node.exe', import.meta.url))
        : process.execPath;
      const parser = fork(fileURLToPath(import.meta.url), [PARSER_ARG], {
        execPath, execArgv: ['--max-old-space-size=96'], serialization: 'advanced',
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true, timeout: MAX_PARSE_MS
      });
      let result;
      parser.once('message', (message) => { result = message; });
      parser.once('error', () => reject(new Error('无法解析附件')));
      parser.once('close', (code) => {
        if (code === null) reject(new Error('附件解析超时或超过资源上限'));
        else if (code !== 0 || !result) reject(new Error('无法解析附件'));
        else if (result.error) reject(new Error(result.error));
        else if (!result.text) {
          reject(new Error(ext === '.pdf' ? '未提取到文字，扫描版 PDF 需要 OCR' : '未提取到附件正文'));
        }
        else resolve(result);
      });
      parser.send({ bytes: buffer, ext }, (error) => {
        if (error) parser.kill();
      });
    });
  } finally {
    activeJobs--;
  }
}
