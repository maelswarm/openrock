import { useEffect, useMemo, useRef, useState } from 'react';
import { Brain, ChevronDown, FileText, Film, Image, LoaderCircle, RefreshCw, Search, Settings } from 'lucide-react';
import { serverAddress, type DedicatedServer, type ModelInfo } from '@open-rock/shared';
import { currentModel, currentServer, useStore } from '../lib/store';
import { retireDate } from '../lib/models';

function CapIcons({ m }: { m: ModelInfo }) {
  const c = m.capabilities;
  return (
    <span className="cap-icons">
      {c.images && <Image size={13} aria-label="Reads images" />}
      {c.documents && <FileText size={13} aria-label="Reads PDFs and Office files" />}
      {c.video && <Film size={13} aria-label="Watches video" />}
      {c.reasoning && <Brain size={13} aria-label="Extended thinking" />}
    </span>
  );
}

export function ModelPicker() {
  const mode = useStore((s) => s.mode);
  const models = useStore((s) => s.models[s.mode]);
  const loading = useStore((s) => s.modelsLoading[s.mode]);
  const error = useStore((s) => s.modelsError[s.mode]);
  const model = useStore((s) => currentModel(s));
  const select = useStore((s) => s.selectModel);
  const loadModels = useStore((s) => s.loadModels);
  const streaming = useStore((s) => !!s.streaming);
  const hasKey = useStore((s) => !!s.settings?.aws.bedrockApiKey || !!s.info?.bedrockKeyFromEnv);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return models;
    return models.filter((m) => `${m.name} ${m.provider} ${m.id}`.toLowerCase().includes(q));
  }, [models, query]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  useEffect(() => {
    setActive(Math.max(0, filtered.findIndex((m) => m.id === model?.id)));
  }, [open, filtered, model?.id]);

  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active, open]);

  if (mode === 'dedicated') return <ServerPicker />;

  const choose = (m: ModelInfo) => {
    select(m.id);
    setOpen(false);
    setQuery('');
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(filtered.length - 1, a + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const m = filtered[active];
      if (m) choose(m);
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  };

  let lastProvider = '';
  return (
    <div className="model-picker" ref={rootRef}>
      <button
        className="model-button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        disabled={streaming}
        title={model?.id}
      >
        {loading && !models.length ? (
          <span className="model-name muted">Loading models…</span>
        ) : model ? (
          <>
            <span className="model-name">{model.name}</span>
            <span className="model-provider">{model.provider}</span>
          </>
        ) : (
          <span className="model-name muted">{!hasKey ? 'No API key yet' : error ? 'Models unavailable' : 'Pick a model'}</span>
        )}
        <ChevronDown size={15} aria-hidden="true" />
      </button>
      {open && (
        <div className="popover model-pop" onKeyDown={onKey}>
          <div className="model-search">
            <Search size={14} aria-hidden="true" />
            <input
              autoFocus
              placeholder={`Search ${models.length} models`}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setActive(0);
              }}
              aria-label="Search models"
              aria-controls="model-list"
            />
            <button className="icon-btn" onClick={() => loadModels('bedrock', true)} aria-label="Refresh model list" title="Refresh model list">
              {loading ? <LoaderCircle size={14} className="spin" /> : <RefreshCw size={14} />}
            </button>
          </div>
          {error && <p className="pop-error">{error}</p>}
          <ul className="model-list" id="model-list" role="listbox" ref={listRef} aria-label="Bedrock models">
            {filtered.map((m, i) => {
              const header = m.provider !== lastProvider ? m.provider : null;
              lastProvider = m.provider;
              return (
                <li key={m.id} role="presentation">
                  {header && <div className="model-group">{header}</div>}
                  <div
                    role="option"
                    aria-selected={m.id === model?.id}
                    data-index={i}
                    data-active={i === active || undefined}
                    className="model-option"
                    onMouseEnter={() => setActive(i)}
                    onClick={() => choose(m)}
                  >
                    <span className="model-option-main">
                      <span className="model-option-name">
                        {m.name}
                        {m.legacy && (
                          <span className="tag" title={m.endOfLife ? `AWS retires this model on ${retireDate(m.endOfLife)}` : 'AWS is retiring this model'}>
                            Legacy
                          </span>
                        )}
                        {m.profileScope && <span className="tag" title="Cross-region inference profile">{m.profileScope}</span>}
                      </span>
                      <span className="model-option-id">{m.id}</span>
                    </span>
                    <CapIcons m={m} />
                  </div>
                </li>
              );
            })}
            {!filtered.length && !error && <li className="model-empty">{loading ? 'Loading…' : 'No models match.'}</li>}
          </ul>
        </div>
      )}
    </div>
  );
}

const NO_SERVERS: DedicatedServer[] = [];

/** Dedicated mode: pick which of your servers new messages go to. */
function ServerPicker() {
  const servers = useStore((s) => s.settings?.dedicated.servers ?? NO_SERVERS);
  const current = useStore((s) => currentServer(s));
  const statuses = useStore((s) => s.dedicated);
  const models = useStore((s) => s.models.dedicated);
  const select = useStore((s) => s.selectModel);
  const streaming = useStore((s) => !!s.streaming);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    if (!open) return;
    setActive(Math.max(0, servers.findIndex((s) => s.id === current?.id)));
    listRef.current?.focus();
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open, servers, current?.id]);

  if (!current) {
    return (
      <div className="model-picker static">
        <a className="model-name" href="#/settings/dedicated">
          Add a server
        </a>
      </div>
    );
  }

  /** The model the server runs, once a check has found it. */
  const modelOf = (srv: DedicatedServer) => models.find((m) => m.id === srv.id)?.baseId || srv.model;
  const stateOf = (srv: DedicatedServer) => {
    const st = statuses[srv.id];
    return !st ? 'checking' : st.ok ? 'up' : 'down';
  };
  const choose = (srv: DedicatedServer) => {
    select(srv.id);
    setOpen(false);
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(servers.length - 1, a + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (servers[active]) choose(servers[active]);
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  };

  const currentModelName = modelOf(current);
  return (
    <div className="model-picker" ref={rootRef}>
      <button className="model-button" aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen((o) => !o)} disabled={streaming} title={serverAddress(current)}>
        <span className="model-name">{current.name}</span>
        <span className="model-provider">{currentModelName || serverAddress(current)}</span>
        <ChevronDown size={15} aria-hidden="true" />
      </button>
      {open && (
        <div className="popover model-pop">
          <ul
            className="model-list"
            role="listbox"
            aria-label="Dedicated servers"
            tabIndex={-1}
            ref={listRef}
            onKeyDown={onKey}
            aria-activedescendant={servers[active] ? `server-option-${servers[active].id}` : undefined}
          >
            {servers.map((srv, i) => {
              const state = stateOf(srv);
              const modelName = modelOf(srv);
              return (
                <li
                  key={srv.id}
                  id={`server-option-${srv.id}`}
                  role="option"
                  aria-selected={srv.id === current.id}
                  data-active={i === active || undefined}
                  className="model-option"
                  onMouseEnter={() => setActive(i)}
                  onClick={() => choose(srv)}
                >
                  <span className={`dot dot-${state}`} aria-hidden="true" />
                  <span className="model-option-main">
                    <span className="model-option-name">
                      {srv.name}
                      <span className="sr-only">{state === 'up' ? ', online' : state === 'down' ? ', offline' : ', checking'}</span>
                    </span>
                    <span className="model-option-id">
                      {serverAddress(srv)}
                      {modelName ? ` · ${modelName}` : ''}
                    </span>
                  </span>
                </li>
              );
            })}
          </ul>
          <a className="pop-foot" href="#/settings/dedicated" onClick={() => setOpen(false)}>
            <Settings size={14} aria-hidden="true" />
            Add or change servers
          </a>
        </div>
      )}
    </div>
  );
}
