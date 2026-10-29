import fs from 'node:fs';
import path from 'node:path';
import type { Attachment } from '@open-rock/shared';
import { config, dataPath, ensureDir } from '../config.js';
import { classify, extractText } from '../extract.js';
import { HttpError, newId, safeId, writeFileAtomic } from '../util.js';

interface StoredMeta extends Attachment {
  createdAt: number;
}

function dir(id: string) {
  return dataPath('files', safeId(id));
}

function cleanName(name: string): string {
  const base = name.split(/[\\/]/).pop() || 'file';
  return base.replace(/[\u0000-\u001f]/g, '').slice(0, 180) || 'file';
}

export async function saveUpload(name: string, mimeIn: string, bytes: Uint8Array): Promise<Attachment> {
  if (bytes.byteLength > config.maxUploadBytes) {
    throw new HttpError(413, `That file is ${(bytes.byteLength / 1048576).toFixed(1)} MB. The limit is ${config.maxUploadBytes / 1048576} MB.`);
  }
  const fileName = cleanName(name);
  const { kind, mime } = classify(fileName, mimeIn, bytes);
  if (!kind) {
    throw new HttpError(415, `Open Rock can't read ${fileName}. Attach images (PNG, JPEG, GIF, WebP), PDFs, Office files, video or text files.`);
  }
  const id = newId('f_');
  const d = dir(id);
  ensureDir(d);
  await fs.promises.writeFile(path.join(d, 'blob'), bytes);
  let textChars: number | undefined;
  if (kind === 'document' || kind === 'text') {
    const text = await extractText(fileName, kind, bytes);
    if (text) {
      await fs.promises.writeFile(path.join(d, 'text.txt'), text, 'utf8');
      textChars = text.length;
    }
  }
  const meta: StoredMeta = {
    id,
    name: fileName,
    mime,
    size: bytes.byteLength,
    kind,
    hasText: textChars !== undefined,
    textChars,
    createdAt: Date.now(),
  };
  await writeFileAtomic(path.join(d, 'meta.json'), JSON.stringify(meta));
  return publicMeta(meta);
}

function publicMeta(m: StoredMeta): Attachment {
  const { createdAt: _c, ...rest } = m;
  return rest;
}

export async function getMeta(id: string): Promise<Attachment> {
  try {
    const raw = await fs.promises.readFile(path.join(dir(id), 'meta.json'), 'utf8');
    return publicMeta(JSON.parse(raw) as StoredMeta);
  } catch {
    throw new HttpError(404, 'File not found');
  }
}

export async function readBytes(id: string): Promise<Uint8Array> {
  return new Uint8Array(await fs.promises.readFile(path.join(dir(id), 'blob')));
}

export async function readText(id: string): Promise<string | null> {
  try {
    return await fs.promises.readFile(path.join(dir(id), 'text.txt'), 'utf8');
  } catch {
    return null;
  }
}

export async function deleteFile(id: string): Promise<void> {
  await fs.promises.rm(dir(id), { recursive: true, force: true });
}
