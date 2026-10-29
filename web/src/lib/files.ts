import type { AttachmentKind, ModelCapabilities } from '@open-rock/shared';

const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif', 'heic', 'heif', 'tif', 'tiff'];
const VIDEO_EXT = ['mp4', 'mov', 'mkv', 'webm', 'flv', 'mpeg', 'mpg', 'wmv', '3gp'];
const DOC_EXT = ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'pptx'];
const TEXT_EXT = [
  'txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'jsonl', 'xml', 'yaml', 'yml', 'toml', 'ini', 'log', 'html', 'htm', 'css', 'js', 'mjs', 'ts', 'tsx',
  'jsx', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift', 'c', 'h', 'cpp', 'hpp', 'cs', 'php', 'sh', 'ps1', 'bat', 'sql', 'r', 'lua', 'dart', 'vue',
  'svelte', 'tex', 'rst', 'svg',
];

export function extOf(name: string) {
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i + 1).toLowerCase() : '';
}

export function guessKind(file: File): AttachmentKind {
  const ext = extOf(file.name);
  if (file.type.startsWith('image/') && ext !== 'svg') return 'image';
  if (IMAGE_EXT.includes(ext)) return 'image';
  if (file.type.startsWith('video/') || VIDEO_EXT.includes(ext)) return 'video';
  if (DOC_EXT.includes(ext)) return 'document';
  return 'text';
}

/** The file-picker filter for a model. */
export function acceptFor(caps: ModelCapabilities | undefined): string {
  const exts = [...DOC_EXT, ...TEXT_EXT];
  if (caps?.images) exts.push(...IMAGE_EXT);
  if (caps?.video) exts.push(...VIDEO_EXT);
  return exts.map((e) => `.${e}`).join(',');
}

/** Why a model can't take this file, or null if it can. */
export function rejectReason(kind: AttachmentKind, caps: ModelCapabilities | undefined, modelName: string): string | null {
  if (!caps) return null;
  if (kind === 'image' && !caps.images) return `${modelName} can't read images.`;
  if (kind === 'video' && !caps.video) return `${modelName} can't watch video.`;
  return null;
}

/** Plain-language summary of what a model accepts, for the composer. */
export function capabilitySummary(caps: ModelCapabilities | undefined, mode: 'bedrock' | 'dedicated'): string {
  if (!caps) return '';
  const parts: string[] = [];
  if (caps.images) parts.push('images');
  if (caps.video) parts.push('video');
  parts.push(mode === 'bedrock' && caps.documents ? 'PDFs, Office files' : 'documents (as text)');
  parts.push('code');
  const last = parts.pop();
  return `Reads ${parts.join(', ')} and ${last}`;
}

const MAX_EDGE = 2048;
const MAX_BYTES = 3.5 * 1024 * 1024;

/**
 * Shrink big photos before upload so they fit Bedrock's 3.75 MB image limit and don't waste tokens.
 * Also converts formats models can't take (BMP, AVIF, TIFF…) to PNG or JPEG when the browser can decode them.
 */
export async function prepareImage(file: File, downscale: boolean): Promise<File> {
  const ext = extOf(file.name);
  const native = ['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext) && /^image\/(png|jpeg|gif|webp)$/.test(file.type);
  if (native && (!downscale || ext === 'gif')) return file;
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return file; // let the server explain
  }
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  if (native && scale === 1 && file.size <= MAX_BYTES) {
    bitmap.close();
    return file;
  }
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return file;
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  const keepPng = file.type === 'image/png' && w * h < 1_500_000;
  const type = keepPng ? 'image/png' : 'image/jpeg';
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, type, 0.9));
  if (!blob) return file;
  const base = file.name.replace(/\.[^.]+$/, '') || 'image';
  return new File([blob], `${base}.${keepPng ? 'png' : 'jpg'}`, { type });
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}
