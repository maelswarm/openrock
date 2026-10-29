import { unzipSync, strFromU8 } from 'fflate';
import type { AttachmentKind } from '@open-rock/shared';

const MAX_TEXT_CHARS = 400_000;

const IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

const VIDEO_EXT = new Set(['mp4', 'mov', 'mkv', 'webm', 'flv', 'mpeg', 'mpg', 'wmv', '3gp']);
const DOC_EXT = new Set(['pdf', 'doc', 'docx', 'xls', 'xlsx', 'pptx']);
const TEXT_EXT = new Set([
  'txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'jsonl', 'xml', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'log', 'html', 'htm', 'css',
  'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'kts', 'swift', 'c', 'h', 'cpp', 'hpp', 'cc', 'cs', 'php',
  'sh', 'bash', 'zsh', 'ps1', 'bat', 'sql', 'r', 'scala', 'lua', 'pl', 'dart', 'vue', 'svelte', 'graphql', 'proto', 'tex', 'rst', 'env',
  'gradle', 'dockerfile', 'makefile', 'svg',
]);

export function extOf(name: string): string {
  const base = name.toLowerCase().split(/[\\/]/).pop() ?? '';
  if (base === 'dockerfile' || base === 'makefile') return base;
  const i = base.lastIndexOf('.');
  return i >= 0 ? base.slice(i + 1) : '';
}

export function classify(name: string, mime: string, bytes: Uint8Array): { kind: AttachmentKind | null; mime: string } {
  const ext = extOf(name);
  if (IMAGE_MIME[ext] || /^image\/(png|jpeg|gif|webp)$/.test(mime)) {
    return { kind: 'image', mime: IMAGE_MIME[ext] ?? mime };
  }
  if (VIDEO_EXT.has(ext) || mime.startsWith('video/')) return { kind: 'video', mime: mime || `video/${ext}` };
  if (DOC_EXT.has(ext)) return { kind: 'document', mime: mime || 'application/octet-stream' };
  if (TEXT_EXT.has(ext) || mime.startsWith('text/') || /json|xml|yaml|javascript/.test(mime)) {
    return { kind: 'text', mime: mime || 'text/plain' };
  }
  if (looksLikeText(bytes)) return { kind: 'text', mime: 'text/plain' };
  return { kind: null, mime };
}

function looksLikeText(bytes: Uint8Array): boolean {
  const sample = bytes.subarray(0, 8192);
  if (sample.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(sample);
    return true;
  } catch {
    return false;
  }
}

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(Number.parseInt(h, 16)))
    .replace(/&amp;/g, '&');
}

function docxText(zip: Record<string, Uint8Array>): string {
  const xml = zip['word/document.xml'];
  if (!xml) return '';
  const doc = strFromU8(xml);
  const paragraphs = doc.split(/<\/w:p>/);
  const out: string[] = [];
  for (const p of paragraphs) {
    let line = '';
    const re = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:tab\/>|<w:br\/>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(p))) {
      if (m[0] === '<w:tab/>') line += '\t';
      else if (m[0] === '<w:br/>') line += '\n';
      else line += decodeXml(m[1]);
    }
    out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function pptxText(zip: Record<string, Uint8Array>): string {
  const slides = Object.keys(zip)
    .filter((k) => /^ppt\/slides\/slide\d+\.xml$/.test(k))
    .sort((a, b) => Number(/(\d+)\.xml$/.exec(a)![1]) - Number(/(\d+)\.xml$/.exec(b)![1]));
  return slides
    .map((k, i) => {
      const xml = strFromU8(zip[k]);
      const paras = xml.split(/<\/a:p>/).map((p) => {
        let line = '';
        const re = /<a:t>([^<]*)<\/a:t>/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(p))) line += decodeXml(m[1]);
        return line;
      });
      return `## Slide ${i + 1}\n${paras.filter(Boolean).join('\n')}`;
    })
    .join('\n\n');
}

function xlsxText(zip: Record<string, Uint8Array>): string {
  const shared: string[] = [];
  const ss = zip['xl/sharedStrings.xml'];
  if (ss) {
    for (const si of strFromU8(ss).split(/<\/si>/)) {
      let t = '';
      const re = /<t(?:\s[^>]*)?>([^<]*)<\/t>/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(si))) t += decodeXml(m[1]);
      shared.push(t);
    }
  }
  const names = new Map<string, string>();
  const wb = zip['xl/workbook.xml'] ? strFromU8(zip['xl/workbook.xml']) : '';
  const rels = zip['xl/_rels/workbook.xml.rels'] ? strFromU8(zip['xl/_rels/workbook.xml.rels']) : '';
  const relTarget = new Map<string, string>();
  for (const m of rels.matchAll(/<Relationship[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"/g)) relTarget.set(m[1], m[2]);
  for (const m of rels.matchAll(/<Relationship[^>]*Target="([^"]+)"[^>]*Id="([^"]+)"/g)) relTarget.set(m[2], m[1]);
  for (const m of wb.matchAll(/<sheet\b[^>]*name="([^"]+)"[^>]*r:id="([^"]+)"/g)) {
    const target = relTarget.get(m[2]);
    if (target) names.set(`xl/${target.replace(/^\/?xl\//, '')}`, decodeXml(m[1]));
  }
  const sheets = Object.keys(zip)
    .filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k))
    .sort((a, b) => Number(/(\d+)\.xml$/.exec(a)![1]) - Number(/(\d+)\.xml$/.exec(b)![1]));
  const out: string[] = [];
  for (const k of sheets) {
    const xml = strFromU8(zip[k]);
    const rows: string[] = [];
    for (const row of xml.split(/<\/row>/)) {
      const cells: string[] = [];
      for (const c of row.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = c[1];
        const inner = c[2] ?? '';
        const type = /\bt="([^"]+)"/.exec(attrs)?.[1];
        const v = /<v>([^<]*)<\/v>/.exec(inner)?.[1];
        let value = '';
        if (type === 's' && v !== undefined) value = shared[Number(v)] ?? '';
        else if (type === 'inlineStr') value = decodeXml(/<t[^>]*>([^<]*)<\/t>/.exec(inner)?.[1] ?? '');
        else if (type === 'b') value = v === '1' ? 'TRUE' : 'FALSE';
        else if (v !== undefined) value = decodeXml(v);
        cells.push(value.includes(',') || value.includes('"') ? `"${value.replace(/"/g, '""')}"` : value);
      }
      if (cells.some((c) => c !== '')) rows.push(cells.join(','));
      if (rows.length >= 5000) break;
    }
    out.push(`## Sheet: ${names.get(k) ?? k.split('/').pop()}\n${rows.join('\n')}`);
  }
  return out.join('\n\n');
}

async function pdfText(bytes: Uint8Array): Promise<string> {
  const { extractText, getDocumentProxy } = await import('unpdf');
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const { text } = await extractText(pdf, { mergePages: false });
  const pages = Array.isArray(text) ? text : [text];
  return pages.map((t, i) => `--- Page ${i + 1} ---\n${t.trim()}`).join('\n\n');
}

/** Best-effort plain text for documents and text files. Returns null when nothing readable was found. */
export async function extractText(name: string, kind: AttachmentKind, bytes: Uint8Array): Promise<string | null> {
  const ext = extOf(name);
  let text = '';
  try {
    if (kind === 'text') {
      text = new TextDecoder('utf-8').decode(bytes);
    } else if (kind === 'document') {
      if (ext === 'pdf') text = await pdfText(bytes);
      else if (ext === 'docx' || ext === 'xlsx' || ext === 'pptx') {
        const zip = unzipSync(bytes);
        text = ext === 'docx' ? docxText(zip) : ext === 'xlsx' ? xlsxText(zip) : pptxText(zip);
      }
    }
  } catch (err) {
    console.warn(`[extract] could not read ${name}:`, err instanceof Error ? err.message : err);
    return null;
  }
  text = text.replace(/\u0000/g, '').trim();
  if (!text) return null;
  return text.length > MAX_TEXT_CHARS ? `${text.slice(0, MAX_TEXT_CHARS)}\n\n[…truncated]` : text;
}
