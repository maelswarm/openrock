import { memo, useState } from 'react';
import { Check, ChevronRight, CircleAlert, Copy, Pencil, RotateCcw } from 'lucide-react';
import type { ChatMessage } from '@open-rock/shared';
import { Markdown } from './Markdown';
import { MessageAttachments } from './AttachmentView';
import { compact, duration } from '../lib/format';

interface Props {
  m: ChatMessage;
  streaming: boolean;
  isLast: boolean;
  showTokens: boolean;
  busy: boolean;
  onEdit?: (text: string) => void;
  onRegenerate?: () => void;
}

function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="icon-btn"
      aria-label={done ? 'Copied' : 'Copy message'}
      title={done ? 'Copied' : 'Copy'}
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setDone(true);
        setTimeout(() => setDone(false), 1400);
      }}
    >
      {done ? <Check size={14} /> : <Copy size={14} />}
    </button>
  );
}

function stopLabel(reason?: string): string | null {
  if (reason === 'max_tokens' || reason === 'length') return 'Stopped at the max output length.';
  if (reason === 'stopped') return 'Stopped.';
  if (reason === 'content_filtered' || reason === 'guardrail_intervened') return 'Stopped by a content filter.';
  return null;
}

export const Message = memo(function Message({ m, streaming, isLast, showTokens, busy, onEdit, onRegenerate }: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(m.content);

  if (m.role === 'user') {
    if (editing) {
      return (
        <div className="msg msg-user editing">
          <textarea className="input edit-area" value={draft} onChange={(e) => setDraft(e.target.value)} autoFocus rows={Math.min(12, draft.split('\n').length + 1)} aria-label="Edit message" />
          <div className="edit-actions">
            <button className="btn btn-quiet" onClick={() => setEditing(false)}>
              Cancel
            </button>
            <button
              className="btn btn-primary"
              disabled={!draft.trim() || busy}
              onClick={() => {
                setEditing(false);
                onEdit?.(draft);
              }}
            >
              Send edit
            </button>
          </div>
          <p className="hint">Sending an edit replaces this message and every reply after it.</p>
        </div>
      );
    }
    return (
      <div className="msg-user-wrap">
        <div className="msg msg-user">
          {m.attachments?.length ? <MessageAttachments items={m.attachments} /> : null}
          {m.content && <div className="user-text">{m.content}</div>}
        </div>
        <div className="msg-actions">
          <CopyButton text={m.content} />
          {onEdit && !busy && !m.id.startsWith('tmp_') && (
            <button className="icon-btn" aria-label="Edit message" title="Edit" onClick={() => { setDraft(m.content); setEditing(true); }}>
              <Pencil size={14} />
            </button>
          )}
        </div>
      </div>
    );
  }

  const thinking = streaming && !m.content && !m.reasoning && !m.error;
  const stopped = stopLabel(m.stopReason);
  return (
    <div className="msg msg-assistant" aria-busy={streaming || undefined}>
      {m.reasoning && (
        <details className="reasoning" open={streaming && !m.content}>
          <summary>
            <ChevronRight size={14} aria-hidden="true" />
            {streaming && !m.content ? 'Thinking…' : 'Thinking'}
          </summary>
          <div className="reasoning-body">{m.reasoning}</div>
        </details>
      )}
      {thinking && (
        <div className="typing" aria-label="Waiting for the reply">
          <span />
          <span />
          <span />
        </div>
      )}
      {m.content && <Markdown text={m.content} />}
      {streaming && m.content && <span className="caret" aria-hidden="true" />}
      {m.notices?.map((n, i) => (
        <p key={i} className="notice">
          {n}
        </p>
      ))}
      {m.error && (
        <div className="msg-error" role="alert">
          <CircleAlert size={16} aria-hidden="true" />
          <div>
            <p>{m.error}</p>
            {isLast && onRegenerate && !busy && (
              <button className="btn btn-quiet btn-sm" onClick={onRegenerate}>
                <RotateCcw size={13} aria-hidden="true" />
                Try again
              </button>
            )}
          </div>
        </div>
      )}
      {!streaming && !m.error && (m.content || stopped) && (
        <div className="msg-meta">
          {stopped && <span className="meta-stop">{stopped}</span>}
          {m.modelName && <span>{m.modelName}</span>}
          {showTokens && m.usage && (m.usage.inputTokens > 0 || m.usage.outputTokens > 0) && (
            <span title={`${m.usage.inputTokens.toLocaleString()} input tokens${m.usage.cacheReadTokens ? `, ${m.usage.cacheReadTokens.toLocaleString()} read from cache` : ''}, ${m.usage.outputTokens.toLocaleString()} output tokens`}>
              {compact(m.usage.inputTokens + (m.usage.cacheReadTokens ?? 0))} in, {compact(m.usage.outputTokens)} out
            </span>
          )}
          {showTokens && m.latencyMs ? <span>{duration(m.latencyMs)}</span> : null}
          <span className="msg-actions inline">
            <CopyButton text={m.content} />
            {isLast && onRegenerate && !busy && (
              <button className="icon-btn" aria-label="Regenerate reply" title="Regenerate" onClick={onRegenerate}>
                <RotateCcw size={14} />
              </button>
            )}
          </span>
        </div>
      )}
    </div>
  );
});
