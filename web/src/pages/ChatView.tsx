import { useCallback, useEffect, useRef, useState } from 'react';
import { LoaderCircle, Menu, RefreshCw, SlidersHorizontal } from 'lucide-react';
import { serverAddress } from '@open-rock/shared';
import { currentModel, currentServer, useStore } from '../lib/store';
import { ModelPicker } from '../components/ModelPicker';
import { Message } from '../components/Message';
import { Composer, type ComposerHandle } from '../components/Composer';
import { capabilitySummary } from '../lib/files';

export function ChatView() {
  const mode = useStore((s) => s.mode);
  const current = useStore((s) => s.current);
  const currentLoading = useStore((s) => s.currentLoading);
  const streaming = useStore((s) => s.streaming);
  const model = useStore((s) => currentModel(s));
  const settings = useStore((s) => s.settings);
  const info = useStore((s) => s.info);
  const modelsError = useStore((s) => s.modelsError.bedrock);
  const showTokens = useStore((s) => s.prefs.showTokens);
  const send = useStore((s) => s.send);
  const setSidebar = useStore((s) => s.setSidebar);
  const scrollRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<ComposerHandle>(null);
  const stick = useRef(true);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);

  const hasKey = !!settings?.aws.bedrockApiKey || !!info?.bedrockKeyFromEnv;
  const hasServer = !!settings?.dedicated.servers.length;
  const disabledReason =
    mode === 'bedrock' && !hasKey
      ? 'Add your Bedrock API key in Settings to start.'
      : mode === 'bedrock' && !model && modelsError
        ? modelsError
        : mode === 'dedicated' && !hasServer
          ? 'Add a dedicated server in Settings to start.'
          : null;

  // Keep the newest text in view while it streams, unless the reader scrolled up.
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [current?.messages]);
  useEffect(() => {
    stick.current = true;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    composerRef.current?.focus();
  }, [current?.id]);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    const files = Array.from(e.dataTransfer.files);
    if (files.length) composerRef.current?.addFiles(files);
  }, []);

  const messages = current?.messages ?? [];
  const busy = !!streaming;
  const lastIndex = messages.length - 1;

  return (
    <div
      className="chat"
      onDragEnter={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return;
        dragDepth.current++;
        setDragging(true);
      }}
      onDragLeave={() => {
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (!dragDepth.current) setDragging(false);
      }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={onDrop}
    >
      <header className="chat-head">
        <button className="icon-btn menu-btn" onClick={() => setSidebar(true)} aria-label="Open chats">
          <Menu size={18} />
        </button>
        <ModelPicker />
        <a
          className="icon-btn"
          href={`#/settings/${mode === 'bedrock' ? 'variable' : 'dedicated'}`}
          title={mode === 'bedrock' ? 'Settings for this model' : 'Settings for this server'}
          aria-label={mode === 'bedrock' ? 'Settings for this model' : 'Settings for this server'}
        >
          <SlidersHorizontal size={16} />
        </a>
        <div className="chat-title" title={current?.title}>
          {current && current.title !== 'New chat' ? current.title : ''}
        </div>
        {mode === 'dedicated' && hasServer && <DedicatedStatusPill />}
      </header>

      <div className="chat-scroll" ref={scrollRef} onScroll={onScroll}>
        {currentLoading && !current ? (
          <div className="chat-loading">
            <LoaderCircle className="spin" size={18} aria-label="Loading chat" />
          </div>
        ) : messages.length === 0 ? (
          <EmptyState hasKey={hasKey} />
        ) : (
          <div className="messages">
            {messages.map((m, i) => (
              <Message
                key={m.id}
                m={m}
                isLast={i === lastIndex}
                streaming={busy && i === lastIndex && m.role === 'assistant'}
                showTokens={showTokens}
                busy={busy}
                onEdit={m.role === 'user' ? (text) => void send(text, m.attachments ?? [], { editMessageId: m.id }) : undefined}
                onRegenerate={m.role === 'assistant' && i === lastIndex ? () => void send('', [], { regenerate: true }) : undefined}
              />
            ))}
          </div>
        )}
      </div>

      <Composer ref={composerRef} model={model} disabledReason={disabledReason} />

      {dragging && (
        <div className="drop-zone" aria-hidden="true">
          <p>Drop files to attach</p>
          <span>{capabilitySummary(model?.capabilities, mode)}</span>
        </div>
      )}
    </div>
  );
}

function EmptyState({ hasKey }: { hasKey: boolean }) {
  const mode = useStore((s) => s.mode);
  const model = useStore((s) => currentModel(s));
  const server = useStore((s) => currentServer(s));
  const dedicated = useStore((s) => (server ? s.dedicated[server.id] : undefined));
  const region = useStore((s) => s.settings?.aws.region);

  if (mode === 'bedrock' && !hasKey) {
    return (
      <div className="empty">
        <h1>Connect Bedrock</h1>
        <p>Paste an Amazon Bedrock API key and every chat model in your region shows up in the model list.</p>
        <a className="btn btn-primary" href="#/settings/variable">
          Add API key
        </a>
      </div>
    );
  }
  if (mode === 'bedrock') {
    return (
      <div className="empty">
        <h1>{model ? model.name : 'Pick a model'}</h1>
        <p>
          {model
            ? `${model.provider} on Bedrock in ${region}. You pay per token; the Usage page tracks it.`
            : 'Choose any Bedrock model from the list above.'}
        </p>
        {model && <p className="empty-caps">{capabilitySummary(model.capabilities, 'bedrock')}.</p>}
      </div>
    );
  }
  if (!server) {
    return (
      <div className="empty">
        <h1>Add a dedicated server</h1>
        <p>Enter the hostname or IP address of a server running Ollama, vLLM, llama.cpp or another OpenAI-compatible server, its HTTPS port and its token. You can add as many servers as you like and pick one per chat.</p>
        <a className="btn btn-primary" href="#/settings/dedicated">
          Add a server
        </a>
      </div>
    );
  }
  return (
    <div className="empty">
      <h1>{server.name}</h1>
      <p>
        Your dedicated server at {serverAddress(server)}.{' '}
        {dedicated ? (dedicated.ok ? `Online, answering in ${dedicated.latencyMs ?? '?'} ms.` : dedicated.message) : 'Checking the connection…'}
      </p>
      {model && <p className="empty-caps">{capabilitySummary(model.capabilities, 'dedicated')}.</p>}
    </div>
  );
}

function DedicatedStatusPill() {
  const server = useStore((s) => currentServer(s));
  const st = useStore((s) => (server ? s.dedicated[server.id] : undefined));
  const checking = useStore((s) => (server ? !!s.dedicatedChecking[server.id] : false));
  const check = useStore((s) => s.checkDedicated);
  const state = !st ? 'checking' : st.ok ? 'up' : 'down';
  return (
    <button className={`status-pill status-${state}`} onClick={() => void check(server?.id)} title={st?.message ?? 'Checking'} aria-label={`Server status: ${st?.message ?? 'checking'}. Check again.`}>
      {checking ? <LoaderCircle size={12} className="spin" aria-hidden="true" /> : <span className={`dot dot-${state}`} aria-hidden="true" />}
      <span>{state === 'up' ? 'Online' : state === 'down' ? 'Offline' : 'Checking'}</span>
      {state === 'down' && !checking && <RefreshCw size={12} aria-hidden="true" />}
    </button>
  );
}
