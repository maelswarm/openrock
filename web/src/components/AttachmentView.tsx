import { useEffect, useState } from 'react';
import { File as FileIcon, FileText, Film, Image as ImageIcon } from 'lucide-react';
import type { Attachment } from '@open-rock/shared';
import { fileUrl } from '../lib/api';
import { formatBytes } from '../lib/files';

export function KindIcon({ kind, size = 15 }: { kind: Attachment['kind']; size?: number }) {
  if (kind === 'image') return <ImageIcon size={size} aria-hidden="true" />;
  if (kind === 'video') return <Film size={size} aria-hidden="true" />;
  if (kind === 'document') return <FileText size={size} aria-hidden="true" />;
  return <FileIcon size={size} aria-hidden="true" />;
}

export function Thumb({ id, name }: { id: string; name: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    fileUrl(id)
      .then((u) => live && setSrc(u))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [id]);
  return src ? <img src={src} alt={name} /> : <span className="thumb-placeholder" aria-hidden="true" />;
}

function Lightbox({ item, onClose }: { item: Attachment; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="lightbox" role="dialog" aria-modal="true" aria-label={item.name} onClick={onClose}>
      <Thumb id={item.id} name={item.name} />
      <span className="lightbox-name">{item.name}</span>
    </div>
  );
}

/** Files shown on a sent message. */
export function MessageAttachments({ items }: { items: Attachment[] }) {
  const images = items.filter((a) => a.kind === 'image');
  const others = items.filter((a) => a.kind !== 'image');
  const [open, setOpen] = useState<Attachment | null>(null);
  return (
    <div className="msg-files">
      {images.length > 0 && (
        <div className="msg-images">
          {images.map((a) => (
            <button key={a.id} type="button" className="msg-image" onClick={() => setOpen(a)} title={a.name} aria-label={`View ${a.name}`}>
              <Thumb id={a.id} name={a.name} />
            </button>
          ))}
        </div>
      )}
      {open && <Lightbox item={open} onClose={() => setOpen(null)} />}
      {others.map((a) => (
        <span key={a.id} className="file-chip" title={a.hasText ? `${a.name}\n${(a.textChars ?? 0).toLocaleString()} characters of text` : a.name}>
          <KindIcon kind={a.kind} />
          <span className="file-chip-name">{a.name}</span>
          <span className="file-chip-size">{formatBytes(a.size)}</span>
        </span>
      ))}
    </div>
  );
}
