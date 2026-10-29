import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';
import { ArrowUp, LoaderCircle, Paperclip, Square, X } from 'lucide-react';
import type { Attachment, ModelInfo } from '@open-rock/shared';
import { uploadFile, api } from '../lib/api';
import { acceptFor, capabilitySummary, formatBytes, guessKind, prepareImage, rejectReason } from '../lib/files';
import { useStore } from '../lib/store';
import { KindIcon } from './AttachmentView';
import { ContextMeter } from './ContextMeter';

interface Pending {
  key: string;
  name: string;
  size: number;
  kind: Attachment['kind'];
  status: 'uploading' | 'ready' | 'error';
  progress: number;
  attachment?: Attachment;
  error?: string;
  preview?: string;
  controller: AbortController;
}

export interface ComposerHandle {
  addFiles(files: File[]): void;
  focus(): void;
}

interface Props {
  model: ModelInfo | null;
  disabledReason?: string | null;
}

let keySeq = 0;

export const Composer = forwardRef<ComposerHandle, Props>(function Composer({ model, disabledReason }, ref) {
  const mode = useStore((s) => s.mode);
  const streaming = useStore((s) => !!s.streaming);
  const send = useStore((s) => s.send);
  const stop = useStore((s) => s.stop);
  const prefs = useStore((s) => s.prefs);
  const toast = useStore((s) => s.toast);
  const currentId = useStore((s) => s.current?.id ?? null);
  const [text, setText] = useState('');
  const [pending, setPending] = useState<Pending[]>([]);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const caps = model?.capabilities;
  const modelName = model?.name ?? 'This model';

  // Fresh composer for each chat.
  useEffect(() => {
    setText('');
    setPending((p) => {
      p.forEach((x) => x.preview && URL.revokeObjectURL(x.preview));
      return [];
    });
  }, [currentId]);

  useLayoutEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, Math.round(window.innerHeight * 0.4))}px`;
  }, [text]);

  const addFiles = useCallback(
    (files: File[]) => {
      for (const original of files) {
        const kind = guessKind(original);
        const reason = rejectReason(kind, caps, modelName);
        if (reason) {
          toast(`${original.name}: ${reason}`, 'error');
          continue;
        }
        const key = `p${++keySeq}`;
        const controller = new AbortController();
        const item: Pending = {
          key,
          name: original.name,
          size: original.size,
          kind,
          status: 'uploading',
          progress: 0,
          controller,
          preview: kind === 'image' ? URL.createObjectURL(original) : undefined,
        };
        setPending((p) => [...p, item]);
        const update = (patch: Partial<Pending>) => setPending((p) => p.map((x) => (x.key === key ? { ...x, ...patch } : x)));
        (async () => {
          const file = kind === 'image' ? await prepareImage(original, prefs.downscaleImages) : original;
          const att = await uploadFile(file, (f) => update({ progress: f }), controller.signal);
          update({ status: 'ready', attachment: att, progress: 1, size: att.size, kind: att.kind });
        })().catch((err) => {
          if (controller.signal.aborted) return;
          update({ status: 'error', error: err instanceof Error ? err.message : String(err) });
        });
      }
    },
    [caps, modelName, prefs.downscaleImages, toast],
  );

  useImperativeHandle(ref, () => ({ addFiles, focus: () => taRef.current?.focus() }), [addFiles]);

  const remove = (p: Pending) => {
    p.controller.abort();
    if (p.preview) URL.revokeObjectURL(p.preview);
    if (p.attachment) void api.deleteFile(p.attachment.id).catch(() => undefined);
    setPending((list) => list.filter((x) => x.key !== p.key));
  };

  const blocked = pending.map((p) => (p.status === 'ready' ? rejectReason(p.kind, caps, modelName) : null)).find(Boolean) ?? null;
  const uploading = pending.some((p) => p.status === 'uploading');
  const ready = pending.filter((p) => p.status === 'ready' && p.attachment);
  const canSend = !streaming && !uploading && !blocked && !disabledReason && (text.trim().length > 0 || ready.length > 0);

  const submit = () => {
    if (!canSend) return;
    const atts = ready.map((p) => p.attachment!);
    pending.forEach((p) => p.preview && URL.revokeObjectURL(p.preview));
    setPending([]);
    const content = text;
    setText('');
    void send(content, atts);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
    const wantsSend = prefs.enterToSend ? !e.shiftKey : e.metaKey || e.ctrlKey;
    if (wantsSend) {
      e.preventDefault();
      submit();
    }
  };

  const hint = disabledReason ?? blocked ?? (pending.some((p) => p.status === 'error') ? 'Remove the files that failed to upload.' : capabilitySummary(caps, mode));

  return (
    <div className="composer-wrap">
      <div className="composer">
        {pending.length > 0 && (
          <ul className="pending" aria-label="Attachments">
            {pending.map((p) => (
              <li key={p.key} className={`pending-item status-${p.status}`} title={p.error ?? p.name}>
                {p.preview ? <img src={p.preview} alt="" /> : <span className="pending-icon"><KindIcon kind={p.kind} size={16} /></span>}
                <span className="pending-text">
                  <span className="pending-name">{p.name}</span>
                  <span className="pending-sub">{p.status === 'error' ? p.error : p.status === 'uploading' ? `Uploading ${Math.round(p.progress * 100)}%` : formatBytes(p.size)}</span>
                </span>
                {p.status === 'uploading' && <span className="pending-bar" style={{ width: `${Math.round(p.progress * 100)}%` }} />}
                <button className="icon-btn" onClick={() => remove(p)} aria-label={`Remove ${p.name}`}>
                  <X size={13} />
                </button>
              </li>
            ))}
          </ul>
        )}
        <textarea
          ref={taRef}
          className="composer-input"
          rows={1}
          value={text}
          placeholder={mode === 'dedicated' ? `Message ${modelName}` : model ? `Message ${model.name}` : 'Pick a model to start'}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={(e) => {
            const files = Array.from(e.clipboardData.files);
            if (files.length) {
              e.preventDefault();
              addFiles(files);
            }
          }}
          aria-label="Message"
        />
        <div className="composer-row">
          <button className="icon-btn attach" onClick={() => fileRef.current?.click()} aria-label="Attach files" title="Attach files" disabled={streaming}>
            <Paperclip size={17} />
          </button>
          <input
            ref={fileRef}
            type="file"
            multiple
            hidden
            accept={acceptFor(caps)}
            onChange={(e) => {
              addFiles(Array.from(e.target.files ?? []));
              e.target.value = '';
            }}
          />
          <span className={`composer-hint${blocked || disabledReason ? ' warn' : ''}`}>{hint}</span>
          {mode === 'dedicated' && <ContextMeter draft={text} pendingImages={pending.filter((p) => p.kind === 'image').length} />}
          {streaming ? (
            <button className="send-btn stop" onClick={stop} aria-label="Stop reply" title="Stop">
              <Square size={14} fill="currentColor" />
            </button>
          ) : (
            <button className="send-btn" onClick={submit} disabled={!canSend} aria-label="Send message" title={prefs.enterToSend ? 'Send (Enter)' : 'Send (Ctrl+Enter)'}>
              {uploading ? <LoaderCircle size={16} className="spin" /> : <ArrowUp size={17} strokeWidth={2.4} />}
            </button>
          )}
        </div>
      </div>
    </div>
  );
});
