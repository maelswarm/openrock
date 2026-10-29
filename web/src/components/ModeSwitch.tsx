import { serverAddress, type Mode } from '@open-rock/shared';
import { currentServer, useStore } from '../lib/store';

/** Two stacked layers, like a core sample: the active one is the source every new message goes to. */
export function ModeSwitch() {
  const mode = useStore((s) => s.mode);
  const setMode = useStore((s) => s.setMode);
  const streaming = useStore((s) => !!s.streaming);
  const server = useStore((s) => currentServer(s));
  const dedicated = useStore((s) => (server ? s.dedicated[server.id] : undefined));
  const bedrockCount = useStore((s) => s.models.bedrock.length);
  const region = useStore((s) => s.settings?.aws.region ?? '');

  const pick = (m: Mode) => {
    if (m !== mode && !streaming) setMode(m);
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = mode === 'bedrock' ? 'dedicated' : 'bedrock';
      pick(next);
      (e.currentTarget.querySelector(`[data-value="${next}"]`) as HTMLElement | null)?.focus();
    }
  };

  const dedicatedState = !dedicated ? 'checking' : dedicated.ok ? 'up' : 'down';
  const address = server ? serverAddress(server) : '';

  return (
    <div className="strata" role="radiogroup" aria-label="Where messages go" onKeyDown={onKey}>
      <button
        type="button"
        role="radio"
        aria-checked={mode === 'bedrock'}
        tabIndex={mode === 'bedrock' ? 0 : -1}
        data-value="bedrock"
        className="stratum"
        onClick={() => pick('bedrock')}
        disabled={streaming && mode !== 'bedrock'}
      >
        <span className="stratum-name">Variable</span>
        <span className="stratum-sub">Bedrock{region ? ` in ${region}` : ''}{bedrockCount ? `, ${bedrockCount} models` : ''}</span>
      </button>
      <button
        type="button"
        role="radio"
        aria-checked={mode === 'dedicated'}
        tabIndex={mode === 'dedicated' ? 0 : -1}
        data-value="dedicated"
        className="stratum"
        onClick={() => pick('dedicated')}
        disabled={streaming && mode !== 'dedicated'}
      >
        <span className="stratum-name">Dedicated</span>
        {server ? (
          <span className="stratum-sub">
            <span className={`dot dot-${dedicatedState}`} aria-hidden="true" />
            <span className="stratum-text">{server.name === server.host ? address : `${server.name} on ${address}`}</span>
            <span className="sr-only">{dedicatedState === 'up' ? ', online' : dedicatedState === 'down' ? ', offline' : ', checking'}</span>
          </span>
        ) : (
          <span className="stratum-sub">No servers yet</span>
        )}
      </button>
    </div>
  );
}
