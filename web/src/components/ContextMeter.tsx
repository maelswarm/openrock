import { useMemo } from 'react';
import { estimateTokens } from '@open-rock/shared';
import { currentServer, useStore } from '../lib/store';
import { compact } from '../lib/format';

/** How full the chosen dedicated server's context window is: history + draft + reply reserve. */
export function ContextMeter({ draft, pendingImages }: { draft: string; pendingImages: number }) {
  const ds = useStore((s) => currentServer(s));
  // Like the server: images count only when the model is sent them, and the server's own context limit wins.
  const images = useStore((s) => !!s.models.dedicated.find((m) => m.id === ds?.id)?.capabilities.images);
  const serverCtx = useStore((s) => (ds ? s.dedicated[ds.id]?.contextSize : undefined));
  const contextSize = ds ? Math.min(ds.contextSize, serverCtx ?? Infinity) : 0;
  const sharedSystem = useStore((s) => s.settings?.dedicated.systemPrompt ?? '');
  const messages = useStore((s) => s.current?.messages);
  const conversationSystem = useStore((s) => s.current?.systemPrompt);

  const est = useMemo(() => {
    if (!ds) return null;
    const e = (role: 'user' | 'assistant' | 'system', text: string, images: number) => estimateTokens({ role, text, images }, ds.charsPerToken, ds.imageTokens);
    const draftTokens = draft || pendingImages ? e('user', draft, images ? pendingImages : 0) : 0;
    // After a reply, the server's own count (prompt + reply) is the best starting point.
    const last = messages?.[messages.length - 1];
    if (last?.role === 'assistant' && last.context && !last.context.estimated && last.usage) {
      return last.usage.inputTokens + last.usage.outputTokens + draftTokens;
    }
    const sys = conversationSystem ?? sharedSystem;
    let total = sys ? e('system', sys, 0) : 0;
    for (const m of messages ?? []) {
      if (m.role === 'assistant' && !m.content) continue;
      const fileChars = (m.attachments ?? []).filter((a) => a.kind !== 'image').reduce((n, a) => n + (a.textChars ?? 0), 0);
      const imageCount = (m.attachments ?? []).filter((a) => a.kind === 'image').length;
      total += e(m.role, m.content, images ? imageCount : 0) + Math.ceil(fileChars / (ds.charsPerToken || 3.6));
    }
    return total + draftTokens;
  }, [ds, images, sharedSystem, messages, conversationSystem, draft, pendingImages]);

  if (!ds || est === null) return null;
  const budget = Math.max(1, contextSize - ds.maxTokens);
  const share = est / budget;
  const level = share >= 1 ? 'over' : share >= 0.8 ? 'high' : 'ok';
  const label =
    share >= 1
      ? ds.contextStrategy === 'truncate'
        ? 'Older messages will be left out'
        : ds.contextStrategy === 'error'
          ? 'Over the context limit'
          : 'Over the context limit'
      : `${compact(est)} of ${compact(budget)} tokens`;
  return (
    <div
      className={`ctx-meter ctx-${level}`}
      title={`About ${est.toLocaleString()} tokens of history and draft. The context window is ${contextSize.toLocaleString()} tokens with ${ds.maxTokens.toLocaleString()} reserved for the reply.`}
    >
      <span className="ctx-track" aria-hidden="true">
        <span className="ctx-fill" style={{ width: `${Math.min(100, share * 100)}%` }} />
      </span>
      <span className="ctx-label">{label}</span>
    </div>
  );
}
