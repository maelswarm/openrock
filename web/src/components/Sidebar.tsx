import { useMemo, useState } from 'react';
import { ChartColumn, Pencil, Plus, Search, Settings, Trash2 } from 'lucide-react';
import type { ConversationSummary } from '@open-rock/shared';
import { useStore } from '../lib/store';
import { navigate } from '../lib/route';
import { dayGroup } from '../lib/format';
import { ModeSwitch } from './ModeSwitch';

export function Sidebar() {
  const open = useStore((s) => s.sidebarOpen);
  const conversations = useStore((s) => s.conversations);
  const route = useStore((s) => s.route);
  const currentId = route.name === 'chat' ? route.id : undefined;
  const [query, setQuery] = useState('');

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q ? conversations.filter((c) => c.title.toLowerCase().includes(q) || c.modelName.toLowerCase().includes(q)) : conversations;
    const out: { label: string; items: ConversationSummary[] }[] = [];
    for (const c of list) {
      const label = dayGroup(c.updatedAt);
      const g = out[out.length - 1];
      if (g && g.label === label) g.items.push(c);
      else out.push({ label, items: [c] });
    }
    return out;
  }, [conversations, query]);

  return (
    <aside className="sidebar" data-open={open || undefined} aria-label="Conversations">
      <div className="brand">
        <img src="/icon.svg" alt="" width={26} height={26} />
        <span className="wordmark">Open Rock</span>
      </div>

      <ModeSwitch />

      <button className="btn btn-new" onClick={() => navigate({ name: 'chat' })}>
        <Plus size={16} aria-hidden="true" />
        New chat
      </button>

      {conversations.length > 6 && (
        <label className="search">
          <Search size={14} aria-hidden="true" />
          <input type="search" placeholder="Search chats" value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
      )}

      <nav className="conv-list">
        {groups.length === 0 && <p className="conv-empty">{query ? 'No chats match.' : 'Your chats will show up here.'}</p>}
        {groups.map((g) => (
          <section key={g.label}>
            <h2 className="conv-group">{g.label}</h2>
            <ul>
              {g.items.map((c) => (
                <ConversationItem key={c.id} c={c} active={c.id === currentId} />
              ))}
            </ul>
          </section>
        ))}
      </nav>

      <div className="sidebar-foot">
        <a className={`foot-link${route.name === 'usage' ? ' active' : ''}`} href="#/usage">
          <ChartColumn size={16} aria-hidden="true" />
          Usage
        </a>
        <a className={`foot-link${route.name === 'settings' ? ' active' : ''}`} href="#/settings/variable">
          <Settings size={16} aria-hidden="true" />
          Settings
        </a>
      </div>
    </aside>
  );
}

function ConversationItem({ c, active }: { c: ConversationSummary; active: boolean }) {
  const rename = useStore((s) => s.renameConversation);
  const remove = useStore((s) => s.deleteConversation);
  const toast = useStore((s) => s.toast);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(c.title);
  const [confirming, setConfirming] = useState(false);

  if (editing) {
    return (
      <li className="conv-item editing">
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setEditing(false);
            if (title.trim() && title !== c.title) await rename(c.id, title.trim()).catch((err) => toast(String(err.message ?? err), 'error'));
          }}
        >
          <input className="input input-sm" autoFocus value={title} onChange={(e) => setTitle(e.target.value)} onBlur={() => setEditing(false)} aria-label="Chat name" />
        </form>
      </li>
    );
  }

  return (
    <li className={`conv-item${active ? ' active' : ''}`} data-mode={c.mode}>
      <a href={`#/c/${encodeURIComponent(c.id)}`} title={`${c.title}\n${c.modelName}`}>
        <span className="conv-mode" aria-label={c.mode === 'bedrock' ? 'Variable' : 'Dedicated'} />
        <span className="conv-title">{c.title}</span>
      </a>
      <div className="conv-actions">
        {confirming ? (
          <>
            <button className="chip-btn danger" onClick={() => remove(c.id).catch((err) => toast(String(err.message ?? err), 'error'))}>
              Delete
            </button>
            <button className="chip-btn" onClick={() => setConfirming(false)}>
              Keep
            </button>
          </>
        ) : (
          <>
            <button className="icon-btn" aria-label="Rename chat" onClick={() => { setTitle(c.title); setEditing(true); }}>
              <Pencil size={13} />
            </button>
            <button className="icon-btn" aria-label="Delete chat" onClick={() => setConfirming(true)}>
              <Trash2 size={13} />
            </button>
          </>
        )}
      </div>
    </li>
  );
}
