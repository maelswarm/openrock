import { useEffect, useMemo, useState } from 'react';
import { CircleAlert, LoaderCircle, Menu, Plus, RefreshCw, Trash2 } from 'lucide-react';
import {
  DEFAULT_DEDICATED_MODEL,
  DEFAULT_SETTINGS,
  bedrockModelParams,
  thinkingOn,
  parseServerAddress,
  serverAddress,
  type BedrockReplySettings,
  type BedrockSettings,
  type CustomBedrockModel,
  type DedicatedModelSettings,
  type DedicatedServer,
  type DedicatedSettings,
  type Effort,
  type ModelInfo,
  type ModelParams,
  type ModelPrice,
  type Settings,
  type TestResult,
} from '@open-rock/shared';
import { currentServer, useStore } from '../lib/store';
import { api } from '../lib/api';
import type { SettingsTab } from '../lib/route';
import { Field, NumberField, Section, Segmented, Select, TagInput, TextArea, TextField, Toggle } from '../components/fields';
import { compact } from '../lib/format';
import { EFFORT_LABELS, gemmaHint, retireDate } from '../lib/models';

const TABS: { id: SettingsTab; label: string }[] = [
  { id: 'variable', label: 'Variable' },
  { id: 'dedicated', label: 'Dedicated' },
  { id: 'appearance', label: 'Appearance' },
];

export function SettingsPage({ tab }: { tab: SettingsTab }) {
  const settings = useStore((s) => s.settings);
  const setSidebar = useStore((s) => s.setSidebar);
  return (
    <div className="page settings-page">
      <header className="page-head">
        <button className="icon-btn menu-btn" onClick={() => setSidebar(true)} aria-label="Open chats">
          <Menu size={18} />
        </button>
        <h1>Settings</h1>
      </header>
      <nav className="tabs" aria-label="Settings sections">
        {TABS.map((t) => (
          <a key={t.id} href={`#/settings/${t.id}`} aria-current={t.id === tab ? 'page' : undefined} className="tab" data-tab={t.id}>
            {t.label}
          </a>
        ))}
      </nav>
      <div className="page-body">
        {!settings ? null : tab === 'variable' ? <VariableSettings key="v" settings={settings} /> : tab === 'dedicated' ? <DedicatedSettingsView key="d" settings={settings} /> : <Appearance />}
      </div>
    </div>
  );
}

function useDraft<T>(source: T) {
  const [draft, setDraft] = useState<T>(() => structuredClone(source));
  const [base, setBase] = useState<T>(() => structuredClone(source));
  useEffect(() => {
    setBase(structuredClone(source));
    setDraft(structuredClone(source));
  }, [source]);
  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(base), [draft, base]);
  return { draft, setDraft, dirty, reset: () => setDraft(structuredClone(base)) };
}

function SaveBar({ dirty, onSave, onReset, error }: { dirty: boolean; onSave: () => Promise<void>; onReset: () => void; error?: string | null }) {
  const [saving, setSaving] = useState(false);
  if (!dirty && !error) return null;
  return (
    <div className="save-bar" role="region" aria-label="Unsaved changes">
      <span>{error ? <span className="error-text">{error}</span> : 'You have unsaved changes.'}</span>
      <div className="save-actions">
        <button className="btn btn-quiet" onClick={onReset} disabled={saving}>
          Discard
        </button>
        <button
          className="btn btn-primary"
          disabled={saving || !dirty}
          onClick={async () => {
            setSaving(true);
            try {
              await onSave();
            } finally {
              setSaving(false);
            }
          }}
        >
          {saving && <LoaderCircle size={14} className="spin" aria-hidden="true" />}
          Save changes
        </button>
      </div>
    </div>
  );
}

const REGIONS = [
  'us-east-1', 'us-east-2', 'us-west-2', 'us-west-1', 'ca-central-1', 'sa-east-1', 'eu-central-1', 'eu-central-2', 'eu-west-1', 'eu-west-2', 'eu-west-3',
  'eu-north-1', 'eu-south-1', 'eu-south-2', 'ap-northeast-1', 'ap-northeast-2', 'ap-northeast-3', 'ap-south-1', 'ap-south-2', 'ap-southeast-1',
  'ap-southeast-2', 'ap-southeast-3', 'ap-southeast-4', 'ap-southeast-5', 'ap-southeast-7', 'me-central-1', 'il-central-1', 'us-gov-west-1', 'us-gov-east-1',
];

// ---------------- Variable (Bedrock) ----------------

function VariableSettings({ settings }: { settings: Settings }) {
  const source = useMemo(() => ({ aws: settings.aws, bedrock: settings.bedrock }), [settings]);
  const { draft, setDraft, dirty, reset } = useDraft(source);
  const save = useStore((s) => s.saveSettings);
  const toast = useStore((s) => s.toast);
  const info = useStore((s) => s.info);
  const models = useStore((s) => s.models.bedrock);
  const [test, setTest] = useState<TestResult | null>(null);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resets, setResets] = useState(0);

  const b = draft.bedrock;
  const setB = (patch: Partial<BedrockSettings>) => setDraft((d) => ({ ...d, bedrock: { ...d.bedrock, ...patch } }));
  const setAws = (patch: Partial<Settings['aws']>) => setDraft((d) => ({ ...d, aws: { ...d.aws, ...patch } }));
  const regions = REGIONS.includes(draft.aws.region) ? REGIONS : [draft.aws.region, ...REGIONS];

  const doSave = async () => {
    setError(null);
    try {
      await save(draft);
      toast('Saved.');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <>
      <Section
        title="Sign in to Bedrock"
        description="Variable mode calls Amazon Bedrock with an API key and is billed per token by AWS."
        aside={
          <button
            className="btn btn-quiet"
            disabled={testing || dirty}
            title={dirty ? 'Save first' : undefined}
            onClick={async () => {
              setTesting(true);
              try {
                setTest(await api.testBedrock());
              } catch (err) {
                setTest({ ok: false, message: err instanceof Error ? err.message : String(err) });
              } finally {
                setTesting(false);
              }
            }}
          >
            {testing ? <LoaderCircle size={14} className="spin" aria-hidden="true" /> : <RefreshCw size={14} aria-hidden="true" />}
            Test connection
          </button>
        }
      >
        {test && <p className={`test-result ${test.ok ? 'ok' : 'bad'}`}>{test.message}</p>}
        <TextField
          label="Bedrock API key"
          secret
          mono
          wide
          value={draft.aws.bedrockApiKey}
          onChange={(v) => setAws({ bedrockApiKey: v })}
          placeholder={info?.bedrockKeyFromEnv ? 'Using AWS_BEARER_TOKEN_BEDROCK from the server environment' : 'Paste your key'}
          savedLabel="Key saved. Paste a new one to replace it."
          removeLabel="Remove saved key"
          help={
            <>
              Create one in the Bedrock console under API keys. Long-term keys work in every region; short-term keys expire within 12 hours. The key stays on the
              Open Rock server and is never shown again here.
            </>
          }
        />
        <Select label="Region" value={draft.aws.region} options={regions.map((r) => ({ value: r, label: r }))} onChange={(v) => setAws({ region: v })} help="Models and prices differ by region." />
      </Section>

      <Section
        title="Models"
        description="The model list comes straight from Bedrock for your region: every chat model, legacy ones until AWS retires them, and any provisioned, custom, imported or Marketplace models you've set up."
      >
        <Select
          label="Default model for new chats"
          value={b.defaultModelId}
          options={[
            { value: '', label: 'The last model I picked' },
            ...models.map((m) => ({ value: m.id, label: `${m.name}${m.legacy ? ' (legacy)' : ''}`, group: m.provider })),
          ]}
          onChange={(v) => setB({ defaultModelId: v })}
        />
        <Select
          label="Cross-region inference"
          value={b.crossRegion}
          options={[
            { value: 'auto', label: 'Only when a model requires it' },
            { value: 'geo', label: 'Prefer geographic profiles (us., eu., apac.)' },
            { value: 'global', label: 'Prefer global profiles' },
            { value: 'off', label: 'Never (in-region only)' },
          ]}
          onChange={(v) => setB({ crossRegion: v })}
          help="Newer models such as Claude 4 only run through inference profiles, which route requests across regions."
        />
      </Section>

      <Section title="Instructions" description="Sent to every Bedrock model before each conversation. Models without a system role get it at the start of your first message.">
        <TextArea label="System prompt" value={b.systemPrompt} onChange={(v) => setB({ systemPrompt: v })} placeholder="Instructions sent before every conversation" />
      </Section>

      <BedrockModelSettings models={models} replies={b.replies} modelReplies={b.modelReplies} onChange={(patch) => setB(patch)} />

      <CustomModels models={b.customModels} onChange={(customModels) => setB({ customModels })} />
      <Prices key={resets} pricing={b.pricing} onChange={(pricing) => setB({ pricing })} />

      <SaveBar
        dirty={dirty}
        onSave={doSave}
        onReset={() => {
          reset();
          setResets((n) => n + 1);
        }}
        error={error}
      />
    </>
  );
}

const ALL_EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/** Reply settings for all models, or for one: only the controls that model takes, within its limits. */
function BedrockModelSettings({
  models,
  replies,
  modelReplies,
  onChange,
}: {
  models: ModelInfo[];
  replies: BedrockReplySettings;
  modelReplies: Record<string, BedrockReplySettings>;
  onChange: (patch: Pick<BedrockSettings, 'replies' | 'modelReplies'>) => void;
}) {
  // Start on the model the chat is using, so its settings are what you see first.
  const chatModel = useStore((s) => s.models.bedrock.find((m) => m.id === s.selected.bedrock)?.baseId ?? '');
  const [target, setTarget] = useState<string | null>(null);
  const baseId = target ?? chatModel;

  // One entry per base model: the in-region model and its inference profiles share settings.
  const byBase = new Map<string, ModelInfo>();
  for (const m of models) if (!byBase.has(m.baseId)) byBase.set(m.baseId, m);
  const options = [{ value: '', label: 'All models', group: undefined as string | undefined }];
  for (const m of byBase.values()) options.push({ value: m.baseId, label: `${m.name}${m.legacy ? ' (legacy)' : ''}${modelReplies[m.baseId] ? ' · own settings' : ''}`, group: m.provider });
  for (const id of Object.keys(modelReplies)) {
    if (!byBase.has(id)) options.push({ value: id, label: `${id} · own settings`, group: 'Not in the current list' });
  }
  if (baseId && !options.some((o) => o.value === baseId)) options.push({ value: baseId, label: baseId, group: 'Not in the current list' });

  const model = baseId ? byBase.get(baseId) : undefined;
  const own = baseId ? modelReplies[baseId] : undefined;
  const r = own ?? replies;
  const p: ModelParams = baseId
    ? bedrockModelParams(baseId)
    : // Every control, for the settings all models share.
      {
        maxOutputTokens: null,
        temperature: true,
        topP: true,
        topK: true,
        stopSequences: true,
        thinking: null,
        thinkingOnByDefault: false,
        effortLevels: ALL_EFFORTS,
        maxEffortWithoutThinking: null,
        temperatureOrTopP: false,
        noSamplingWhileThinking: false,
      };
  const set = (patch: Partial<BedrockReplySettings>) => {
    if (!baseId) onChange({ replies: { ...replies, ...patch }, modelReplies });
    else onChange({ replies, modelReplies: { ...modelReplies, [baseId]: { ...r, ...patch } } });
  };
  const useShared = () => {
    const next = { ...modelReplies };
    delete next[baseId];
    onChange({ replies, modelReplies: next });
  };
  const effortOptions = [{ value: '', label: "Model's default" }, ...p.effortLevels.map((e) => ({ value: e, label: EFFORT_LABELS[e] }))];
  const effortField = (label: string, help?: string) => (
    <Select label={label} value={r.effort && p.effortLevels.includes(r.effort) ? r.effort : ''} options={effortOptions} onChange={(v) => set({ effort: (v || null) as Effort | null })} help={help} />
  );
  // What this model will actually do, including when the choice is left to the model.
  const thinks = thinkingOn(p, r.thinking);
  const facts: string[] = [];
  if (model) {
    if (p.maxOutputTokens) facts.push(`Up to ${p.maxOutputTokens.toLocaleString()} output tokens`);
    if (model.capabilities.images) facts.push('reads images');
    if (model.capabilities.documents) facts.push('reads PDFs and Office files');
    if (model.capabilities.video) facts.push('watches video');
    if (p.thinking && p.thinking !== 'budget' && p.thinking !== 'adaptive') facts.push('always thinks before answering');
    if (model.legacy) facts.push(model.endOfLife ? `legacy, retired by AWS on ${retireDate(model.endOfLife)}` : 'legacy');
  }

  return (
    <Section
      title="Model settings"
      description="Each model can have its own settings. Models without their own use the settings for all models, and only get the ones they take. Leave a number blank to use the model's default."
    >
      <Select label="Settings for" value={baseId} options={options} onChange={(v) => setTarget(v)} wide />
      {baseId && (
        <div className="model-summary">
          <p>
            <strong>{model?.name ?? baseId}</strong>
            {model && <span className="muted"> · {model.provider}</span>}
            {facts.length > 0 && <span className="muted"> · {facts.join(', ')}</span>}
          </p>
          <p className="small">
            {own ? (
              <>
                Has its own settings.{' '}
                <button type="button" className="link-btn" onClick={useShared}>
                  Use the settings for all models
                </button>
              </>
            ) : (
              'Uses the settings for all models. Change anything here to give it its own.'
            )}
          </p>
        </div>
      )}

      <div className="grid-3">
        <NumberField
          key={`max-${baseId}`}
          label="Max output tokens"
          value={r.maxTokens}
          onChange={(v) => set({ maxTokens: v === null ? null : Math.round(v) })}
          min={1}
          max={p.maxOutputTokens ?? 1_000_000}
          step={256}
          placeholder="Model's maximum"
          help={
            !baseId
              ? 'Capped at each model’s own limit.'
              : p.maxOutputTokens
                ? `Up to ${p.maxOutputTokens.toLocaleString()} for this model.`
                : "Bedrock doesn't publish this model's limit; a value above it falls back to the model's default."
          }
        />
        {p.temperature && <NumberField key={`t-${baseId}`} label="Temperature" value={r.temperature} onChange={(v) => set({ temperature: v })} min={0} max={1} step={0.05} />}
        {p.topP && (
          <NumberField
            key={`p-${baseId}`}
            label="Top P"
            value={r.topP}
            onChange={(v) => set({ topP: v })}
            min={0}
            max={1}
            step={0.05}
            help={p.temperatureOrTopP ? 'This model uses temperature when both are set.' : !baseId ? 'Claude models use temperature when both are set.' : undefined}
          />
        )}
        {p.topK && (
          <NumberField
            key={`k-${baseId}`}
            label="Top K"
            value={r.topK}
            onChange={(v) => set({ topK: v === null ? null : Math.round(v) })}
            min={0}
            max={500}
            help={!baseId ? 'For Claude 4.6 and older, and Amazon Nova.' : undefined}
          />
        )}
      </div>
      {baseId && !p.temperature && !p.topP && <p className="muted small">This model doesn't take temperature, Top P or Top K; effort is how you steer it.</p>}
      {p.stopSequences && <TagInput key={`stop-${baseId}`} label="Stop sequences" values={r.stopSequences} onChange={(v) => set({ stopSequences: v })} max={4} help="Up to four." />}

      {!baseId && (
        <>
          <Select
            label="Thinking"
            value={r.thinking}
            options={[
              { value: 'default', label: "Model's default" },
              { value: 'on', label: 'On' },
              { value: 'off', label: 'Off' },
            ]}
            onChange={(v) => set({ thinking: v })}
            help="For models where thinking is optional. By default Claude Sonnet 5, Opus 5 and Haiku 5.5 think and older Claude models don't; models that always think do so either way. Thinking tokens are billed as output tokens."
          />
          {r.thinking === 'on' && (
            <NumberField
              label="Thinking budget"
              value={r.budgetTokens}
              nullable={false}
              onChange={(v) => set({ budgetTokens: Math.round(v ?? 4096) })}
              min={1024}
              max={128000}
              suffix="tokens"
              help="For Claude 3.7 to 4.5. Newer models set their own depth from the effort level."
            />
          )}
          {effortField('Effort', 'Sent to models that take this level: newer Claude models and OpenAI gpt-oss (low to high).')}
        </>
      )}
      {baseId && p.thinking === 'budget' && (
        <>
          <Toggle
            label="Extended thinking"
            checked={thinks}
            onChange={(v) => set({ thinking: v ? 'on' : 'off' })}
            help={`Off by default for this model. Thinking tokens are billed as output tokens.${p.noSamplingWhileThinking ? ' While it is on, temperature, Top P and Top K are not sent.' : ''}`}
          />
          {thinks && (
            <NumberField
              key={`budget-${baseId}`}
              label="Thinking budget"
              value={r.budgetTokens}
              nullable={false}
              onChange={(v) => set({ budgetTokens: Math.round(v ?? 4096) })}
              min={1024}
              max={(p.maxOutputTokens ?? 129_024) - 1024}
              suffix="tokens"
            />
          )}
        </>
      )}
      {baseId && p.thinking === 'adaptive' && (
        <div className="grid-2">
          <Toggle
            label="Thinking"
            checked={thinks}
            onChange={(v) => set({ thinking: v ? 'on' : 'off' })}
            help={`${p.thinkingOnByDefault ? 'On' : 'Off'} by default for this model. The model decides how much to think, guided by effort.${
              p.noSamplingWhileThinking ? ' While it is on, temperature, Top P and Top K are not sent.' : ''
            }`}
          />
          {effortField(
            'Effort',
            !thinks && p.maxEffortWithoutThinking ? `With thinking off this model takes at most ${EFFORT_LABELS[p.maxEffortWithoutThinking].toLowerCase()}; higher levels are sent as that.` : 'How thoroughly it works. Higher uses more tokens.',
          )}
        </div>
      )}
      {baseId && p.thinking === 'always' && effortField('Effort', 'This model always thinks before answering; effort sets how much. Higher uses more tokens.')}
      {baseId && p.thinking === 'effort' && effortField('Reasoning effort', 'How much the model reasons before answering.')}
      {baseId && p.thinking === 'builtin' && <p className="muted small">This model reasons before every answer; there's nothing to set.</p>}
    </Section>
  );
}

function CustomModels({ models, onChange }: { models: CustomBedrockModel[]; onChange: (m: CustomBedrockModel[]) => void }) {
  const set = (i: number, patch: Partial<CustomBedrockModel>) => onChange(models.map((m, j) => (j === i ? { ...m, ...patch } : m)));
  return (
    <Section
      title="Your own model IDs"
      description="For models the list above can't show, such as when your API key can't read Bedrock's model list, or an ARN from another account. Provisioned throughput, custom, imported and Marketplace models you can see are listed already."
      aside={
        <button className="btn btn-quiet" onClick={() => onChange([...models, { id: '', name: '', images: false, documents: false, video: false }])}>
          <Plus size={14} aria-hidden="true" />
          Add model
        </button>
      }
    >
      {models.length === 0 && <p className="muted small">None yet.</p>}
      {models.map((m, i) => (
        <div className="custom-row" key={i}>
          <input className="input mono" placeholder="Model ID or ARN" value={m.id} onChange={(e) => set(i, { id: e.target.value })} aria-label="Model ID or ARN" />
          <input className="input" placeholder="Name" value={m.name} onChange={(e) => set(i, { name: e.target.value })} aria-label="Name" />
          <label className="check">
            <input type="checkbox" checked={m.images} onChange={(e) => set(i, { images: e.target.checked })} /> Images
          </label>
          <label className="check">
            <input type="checkbox" checked={m.documents} onChange={(e) => set(i, { documents: e.target.checked })} /> Files
          </label>
          <label className="check">
            <input type="checkbox" checked={m.video} onChange={(e) => set(i, { video: e.target.checked })} /> Video
          </label>
          <button className="icon-btn" aria-label="Remove model" onClick={() => onChange(models.filter((_, j) => j !== i))}>
            <Trash2 size={14} />
          </button>
        </div>
      ))}
    </Section>
  );
}

function Prices({ pricing, onChange }: { pricing: Record<string, ModelPrice>; onChange: (p: Record<string, ModelPrice>) => void }) {
  const rows = Object.entries(pricing);
  // Bumped when rows are replaced wholesale, so uncommitted inputs re-mount with the new values.
  const [version, setVersion] = useState(0);
  const replaceRow = (index: number, key: string, price: ModelPrice | null) => {
    const next: Record<string, ModelPrice> = {};
    rows.forEach(([k, v], i) => {
      if (i === index) {
        if (price && key.trim()) next[key.trim()] = price;
      } else next[k] = v;
    });
    onChange(next);
  };
  return (
    <Section
      title="Prices for cost estimates"
      description="US dollars per million tokens. Matched against the model ID, longest match wins. These are starter list prices; check the Bedrock pricing page for your region."
      aside={
        <div className="row-gap">
          <button
            className="btn btn-quiet"
            onClick={() => {
              onChange(structuredClone(DEFAULT_SETTINGS.bedrock.pricing));
              setVersion((v) => v + 1);
            }}
          >
            Reset
          </button>
          <button className="btn btn-quiet" onClick={() => onChange({ ...pricing, [`model-id-${rows.length + 1}`]: { input: 0, output: 0 } })}>
            <Plus size={14} aria-hidden="true" />
            Add price
          </button>
        </div>
      }
    >
      <div className="price-table" role="table" aria-label="Prices">
        <div className="price-row price-headrow" role="row">
          <span role="columnheader">Model ID contains</span>
          <span role="columnheader">Input</span>
          <span role="columnheader">Output</span>
          <span role="columnheader">Cache read</span>
          <span role="columnheader">Cache write</span>
          <span />
        </div>
        {rows.map(([key, p], i) => (
          <PriceRow key={`${version}-${i}`} k={key} p={p} onCommit={(k, price) => replaceRow(i, k, price)} onRemove={() => replaceRow(i, key, null)} />
        ))}
      </div>
    </Section>
  );
}

function PriceRow({ k, p, onCommit, onRemove }: { k: string; p: ModelPrice; onCommit: (key: string, p: ModelPrice) => void; onRemove: () => void }) {
  const [key, setKey] = useState(k);
  const [vals, setVals] = useState({
    input: String(p.input),
    output: String(p.output),
    cacheRead: p.cacheRead === undefined ? '' : String(p.cacheRead),
    cacheWrite: p.cacheWrite === undefined ? '' : String(p.cacheWrite),
  });
  const num = (v: string) => (v.trim() === '' || Number.isNaN(Number(v)) ? undefined : Number(v));
  const commit = () =>
    onCommit(key, { input: num(vals.input) ?? 0, output: num(vals.output) ?? 0, cacheRead: num(vals.cacheRead), cacheWrite: num(vals.cacheWrite) });
  const cell = (name: keyof typeof vals, label: string, placeholder?: string) => (
    <input
      className="input"
      inputMode="decimal"
      value={vals[name]}
      placeholder={placeholder}
      onChange={(e) => setVals((v) => ({ ...v, [name]: e.target.value }))}
      onBlur={commit}
      aria-label={label}
    />
  );
  return (
    <div className="price-row" role="row">
      <input className="input mono" value={key} onChange={(e) => setKey(e.target.value)} onBlur={commit} aria-label="Model ID fragment" />
      {cell('input', 'Input price')}
      {cell('output', 'Output price')}
      {cell('cacheRead', 'Cache read price', '= input')}
      {cell('cacheWrite', 'Cache write price', '= input')}
      <button className="icon-btn" aria-label={`Remove price for ${k}`} onClick={onRemove}>
        <Trash2 size={14} />
      </button>
    </div>
  );
}

// ---------------- Dedicated (Gemma) ----------------

const AUTH_LABELS: Record<string, string> = {
  bearer: 'Authorization: Bearer',
  'x-api-key': 'X-API-Key',
  'api-key': 'api-key',
  raw: 'Authorization',
};

const CTX_PRESETS = [4096, 8192, 16384, 32768, 65536, 131072];

function newServer(): DedicatedServer {
  return {
    ...structuredClone(DEFAULT_DEDICATED_MODEL),
    id: `srv_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    name: '',
    host: '',
    port: 443,
    apiKey: '',
    authHeader: 'auto',
    apiStyle: 'auto',
    model: '',
  };
}

function extraBodyError(text: string): string | null {
  if (!text.trim()) return null;
  try {
    const v = JSON.parse(text);
    return !v || typeof v !== 'object' || Array.isArray(v) ? 'Use a JSON object, like {"key": "value"}.' : null;
  } catch {
    return "This isn't valid JSON yet.";
  }
}

function DedicatedSettingsView({ settings }: { settings: Settings }) {
  const { draft: d, setDraft, dirty, reset } = useDraft<DedicatedSettings>(settings.dedicated);
  const save = useStore((s) => s.saveSettings);
  const toast = useStore((s) => s.toast);
  // Start on the server the chat is using, so its settings are what you see first.
  const chatServer = useStore((s) => currentServer(s)?.id ?? '');
  const [target, setTarget] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const setServer = (id: string, patch: Partial<DedicatedServer>) => setDraft((x) => ({ ...x, servers: x.servers.map((s) => (s.id === id ? { ...s, ...patch } : s)) }));
  const selected = d.servers.find((s) => s.id === (target ?? chatServer)) ?? d.servers[0];

  const doSave = async () => {
    const badJson = d.servers.find((s) => extraBodyError(s.extraBody));
    if (badJson) {
      setError(`Fix the extra request JSON for ${badJson.name || badJson.host || 'the new server'} before saving.`);
      return;
    }
    const i = d.servers.findIndex((s) => !parseServerAddress(s.host));
    if (i >= 0) {
      setError(`Enter a hostname or IP address for ${d.servers[i].name || `server ${i + 1}`}.`);
      return;
    }
    setError(null);
    try {
      await save({ dedicated: d });
      toast('Saved.');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const addServer = () => {
    const srv = newServer();
    setDraft((x) => ({ ...x, servers: [...x.servers, srv] }));
    setTarget(srv.id);
  };

  return (
    <>
      <Section
        title="Servers"
        description="Dedicated mode talks to these over HTTPS and accepts any certificate: self-signed, expired, or issued for another name or by a private CA. Each server runs one model; to use two models from one server, add it twice. Pick the server for a chat from the menu at the top of the chat."
        aside={
          <button className="btn btn-quiet" onClick={addServer}>
            <Plus size={14} aria-hidden="true" />
            Add server
          </button>
        }
      >
        {d.servers.length === 0 && <p className="muted small">No servers yet. Add one with its hostname or IP address and HTTPS port.</p>}
        <div className="server-list">
          {d.servers.map((srv, i) => (
            <ServerCard
              key={srv.id}
              server={srv}
              saved={settings.dedicated.servers.find((s) => s.id === srv.id)}
              autoFocus={i === d.servers.length - 1 && !settings.dedicated.servers.some((s) => s.id === srv.id)}
              onChange={(patch) => setServer(srv.id, patch)}
              onRemove={() => setDraft((x) => ({ ...x, servers: x.servers.filter((s) => s.id !== srv.id) }))}
            />
          ))}
        </div>
      </Section>

      <Section title="Instructions" description="Sent to every dedicated server before each conversation.">
        <TextArea label="System prompt" value={d.systemPrompt} onChange={(v) => setDraft((x) => ({ ...x, systemPrompt: v }))} placeholder="Instructions sent before every conversation" />
      </Section>

      {selected && <DedicatedModelSettingsView key={selected.id} server={selected} servers={d.servers} onPick={setTarget} onChange={(patch) => setServer(selected.id, patch)} />}

      <SaveBar dirty={dirty} onSave={doSave} onReset={reset} error={error} />
    </>
  );
}

/** One server's model settings, showing only what its protocol uses, next to what the server reports about its model. */
function DedicatedModelSettingsView({
  server: m,
  servers,
  onPick,
  onChange: set,
}: {
  server: DedicatedServer;
  servers: DedicatedServer[];
  onPick: (id: string) => void;
  onChange: (patch: Partial<DedicatedModelSettings>) => void;
}) {
  const status = useStore((s) => s.dedicated[m.id]);
  const name = m.name || m.host || 'New server';
  const protocol = m.apiStyle !== 'auto' ? m.apiStyle : status?.ok ? status.apiStyle : undefined;
  const modelName = m.model || status?.models[0] || '';
  const hint = gemmaHint(modelName);
  const serverCtx = status?.contextSize;
  const overServer = !!serverCtx && m.contextSize > serverCtx;
  const maxCtx = serverCtx ?? hint?.contextSize;
  const maxCtxLabel = serverCtx ? 'Server max' : hint ? `${hint.family} max` : '';
  const serverVision = status?.ok ? status.vision : undefined;
  const extraError = extraBodyError(m.extraBody);

  const reply = Math.min(m.maxTokens, m.contextSize);
  const margin = Math.min(m.safetyMarginTokens, m.contextSize - reply);
  const input = Math.max(0, m.contextSize - reply - margin);

  const facts: string[] = [];
  if (protocol) facts.push(protocol === 'ollama' ? 'Ollama' : 'OpenAI-compatible');
  if (serverCtx) facts.push(`${serverCtx.toLocaleString()}-token context (from the server)`);
  else if (hint) facts.push(`${hint.contextSize.toLocaleString()}-token context (${hint.family})`);
  if (serverVision !== undefined) facts.push(serverVision ? 'reads images (from the server)' : "doesn't read images (from the server)");
  else if (hint?.vision !== undefined) facts.push(hint.vision ? `reads images (${hint.family})` : `doesn't read images (${hint.family})`);

  let imagesHelp = 'Gemma 3 at 4B and larger reads images. Turn off for text-only models.';
  if (serverVision !== undefined) imagesHelp = `The server says ${modelName || 'this model'} ${serverVision ? 'reads images' : "can't read images"}.`;
  else if (hint?.vision !== undefined) imagesHelp = `${hint.family} ${hint.vision ? 'reads images' : "doesn't read images"}.`;
  const imagesConflict = m.vision && (serverVision === false || (serverVision === undefined && hint?.vision === false));

  const ctxHelp =
    protocol === 'ollama'
      ? 'Sent to Ollama as num_ctx, which is also how much memory it sets aside.'
      : protocol === 'openai'
        ? 'vLLM and llama.cpp fix this when they start; match the server’s setting.'
        : 'Sent to Ollama as num_ctx. For vLLM and llama.cpp, match the server’s launch setting.';

  return (
    <>
      <Section title="Model settings" description="Each server runs one model and has its own settings for it. Leave a number blank to use the server's default.">
        <Select label="Settings for" value={m.id} options={servers.map((s) => ({ value: s.id, label: s.name || s.host || 'New server' }))} onChange={onPick} wide />
        <div className="model-summary">
          <p>
            <strong>{name}</strong>
            <span className="muted"> · {modelName ? `runs ${modelName}` : status?.ok === false ? "couldn't be reached" : 'model not known yet'}</span>
            {facts.length > 0 && <span className="muted"> · {facts.join(', ')}</span>}
          </p>
          {!status && <p className="small muted">Save, then check the server to see which model it runs.</p>}
        </div>
      </Section>

      <Section title="Context window" description="How much conversation the model sees. Open Rock trims history to fit before sending, so long chats keep working.">
        <Field label="Context size" help={overServer ? undefined : ctxHelp}>
          <div className="ctx-size">
            <input
              className="input"
              inputMode="numeric"
              value={m.contextSize}
              onChange={(e) => {
                const n = Number(e.target.value.replace(/[^\d]/g, ''));
                if (Number.isFinite(n)) set({ contextSize: n });
              }}
              aria-label="Context size in tokens"
            />
            <div className="chips" role="group" aria-label="Common sizes">
              {CTX_PRESETS.filter((n) => !maxCtx || n <= maxCtx).map((n) => (
                <button key={n} type="button" className={`chip${m.contextSize === n ? ' on' : ''}`} onClick={() => set({ contextSize: n })}>
                  {n / 1024}K
                </button>
              ))}
              {maxCtx && !CTX_PRESETS.includes(maxCtx) && (
                <button type="button" className={`chip${m.contextSize === maxCtx ? ' on' : ''}`} onClick={() => set({ contextSize: maxCtx })}>
                  {maxCtxLabel} ({compact(maxCtx)})
                </button>
              )}
            </div>
          </div>
          {overServer && (
            <p className="field-error">
              <CircleAlert size={13} aria-hidden="true" /> The server reports {serverCtx!.toLocaleString()} tokens. Requests beyond that will fail.
            </p>
          )}
        </Field>
        <div className="budget" aria-label="How the context window is split">
          <div className="budget-bar" aria-hidden="true">
            <span className="b-input" style={{ flexGrow: Math.max(0, input) }} />
            <span className="b-reply" style={{ flexGrow: reply }} />
            {margin > 0 && <span className="b-margin" style={{ flexGrow: margin }} />}
          </div>
          <ul className="budget-legend">
            <li>
              <span className="sw b-input" aria-hidden="true" />
              History and your message <strong>{input.toLocaleString()}</strong>
            </li>
            <li>
              <span className="sw b-reply" aria-hidden="true" />
              Reply <strong>{reply.toLocaleString()}</strong>
            </li>
            {margin > 0 && (
              <li>
                <span className="sw b-margin" aria-hidden="true" />
                Safety margin <strong>{margin.toLocaleString()}</strong>
              </li>
            )}
          </ul>
          {input <= 0 && <p className="field-error">The reply and margin take the whole window. Lower max output or raise the context size.</p>}
        </div>
        <div className="grid-3">
          <NumberField label="Max output tokens" value={m.maxTokens} nullable={false} onChange={(v) => set({ maxTokens: v ?? 1024 })} min={1} max={1_000_000} />
          <NumberField label="Safety margin" value={m.safetyMarginTokens} nullable={false} onChange={(v) => set({ safetyMarginTokens: v ?? 0 })} min={0} suffix="tokens" help="Covers the chat template and estimate error." />
          <Select
            label="When the context is full"
            value={m.contextStrategy}
            options={[
              { value: 'truncate', label: 'Leave out the oldest messages' },
              { value: 'error', label: 'Stop and tell me' },
              { value: 'none', label: 'Send everything anyway' },
            ]}
            onChange={(v) => set({ contextStrategy: v })}
          />
          <NumberField label="Characters per token" value={m.charsPerToken} nullable={false} onChange={(v) => set({ charsPerToken: v ?? 3.6 })} min={1} max={10} step={0.1} help="For estimating. English averages about 3.6–4 with Gemma." />
          {m.vision && <NumberField label="Tokens per image" value={m.imageTokens} nullable={false} onChange={(v) => set({ imageTokens: v ?? 256 })} min={0} help="Gemma 3 encodes each image as 256 tokens." />}
        </div>
      </Section>

      <Section
        title="Sampling"
        description="Leave blank to use the server's default."
        aside={
          <button className="btn btn-quiet" onClick={() => set({ temperature: 1, topK: 64, topP: 0.95, minP: 0 })}>
            Use Gemma 3's recommended values
          </button>
        }
      >
        <div className="grid-4">
          <NumberField label="Temperature" value={m.temperature} onChange={(v) => set({ temperature: v })} min={0} max={2} step={0.05} />
          <NumberField label="Top P" value={m.topP} onChange={(v) => set({ topP: v })} min={0} max={1} step={0.01} />
          <NumberField label="Top K" value={m.topK} onChange={(v) => set({ topK: v })} min={0} max={1000} step={1} />
          <NumberField label="Min P" value={m.minP} onChange={(v) => set({ minP: v })} min={0} max={1} step={0.01} />
          <NumberField label="Repetition penalty" value={m.repetitionPenalty} onChange={(v) => set({ repetitionPenalty: v })} min={0} max={3} step={0.05} help="1.0 means none." />
          <NumberField label="Presence penalty" value={m.presencePenalty} onChange={(v) => set({ presencePenalty: v })} min={-2} max={2} step={0.1} />
          <NumberField label="Frequency penalty" value={m.frequencyPenalty} onChange={(v) => set({ frequencyPenalty: v })} min={-2} max={2} step={0.1} />
          <NumberField label="Seed" value={m.seed} onChange={(v) => set({ seed: v === null ? null : Math.round(v) })} min={0} help="Same seed, same reply." />
        </div>
        <TagInput label="Stop sequences" values={m.stop} onChange={(v) => set({ stop: v })} placeholder="e.g. <end_of_turn>" />
      </Section>

      <Section title="Behavior">
        <div className="grid-2">
          <Select
            label="Send the system prompt"
            value={m.systemPromptMode}
            options={[
              { value: 'native', label: 'As a system message' },
              { value: 'merge', label: 'At the start of the first message' },
            ]}
            onChange={(v) => set({ systemPromptMode: v })}
            help="Gemma has no system role of its own; most servers fold it into the first turn. Pick the second option if yours rejects system messages."
          />
          <NumberField label="Timeout" value={m.timeoutSec} nullable={false} onChange={(v) => set({ timeoutSec: v ?? 300 })} min={10} max={3600} suffix="seconds" help="How long to wait for the server to start or continue replying." />
          {protocol !== 'openai' && (
            <>
              <TextField
                label="Keep model loaded"
                value={m.keepAlive}
                onChange={(v) => set({ keepAlive: v })}
                placeholder="Server default"
                help={`${protocol ? 'A' : 'Ollama only: a'} duration like "30m" or "24h", seconds like 300, or -1 to keep it loaded.`}
              />
              <NumberField label="GPU layers" value={m.numGpu} onChange={(v) => set({ numGpu: v })} min={0} help={protocol ? 'num_gpu' : 'Ollama only (num_gpu).'} />
              <NumberField label="CPU threads" value={m.numThread} onChange={(v) => set({ numThread: v })} min={1} help={protocol ? 'num_thread' : 'Ollama only (num_thread).'} />
            </>
          )}
        </div>
        <Toggle label="Stream replies" checked={m.stream} onChange={(v) => set({ stream: v })} help="Show text as it's generated." />
        {protocol !== 'ollama' && (
          <Toggle
            label="Ask for token counts"
            checked={m.includeUsage}
            onChange={(v) => set({ includeUsage: v })}
            help={`${protocol ? '' : 'OpenAI-compatible servers only. '}Sends stream_options.include_usage. Turn off if the server rejects it.`}
          />
        )}
        <TextArea
          label="Extra request JSON"
          mono
          rows={3}
          value={m.extraBody}
          onChange={(v) => set({ extraBody: v })}
          placeholder='{"chat_template_kwargs": {"enable_thinking": false}}'
          help={
            extraError ? (
              <span className="error-text">{extraError}</span>
            ) : protocol === 'ollama' ? (
              'Merged into every request body; an "options" object merges into the model options.'
            ) : (
              'Merged into every request body. For Ollama, an "options" object merges into the model options.'
            )
          }
        />
      </Section>

      <Section title="Files">
        <Toggle label="Images" checked={m.vision} onChange={(v) => set({ vision: v })} help={imagesHelp} />
        {imagesConflict && (
          <p className="field-error">
            <CircleAlert size={13} aria-hidden="true" /> Images sent to this model will fail or be ignored. Turn this off.
          </p>
        )}
        {m.vision && <NumberField label="Images per request" value={m.maxImages} nullable={false} onChange={(v) => set({ maxImages: v ?? 8 })} min={1} max={64} help="Older images are left out first." />}
        <Toggle label="Read documents as text" checked={m.documentsAsText} onChange={(v) => set({ documentsAsText: v })} help="PDF, Word, Excel and PowerPoint files are converted to text for the model." />
      </Section>
    </>
  );
}

function ServerCard({
  server,
  saved,
  autoFocus,
  onChange,
  onRemove,
}: {
  server: DedicatedServer;
  /** The saved version, or undefined for a server added since the last save. */
  saved: DedicatedServer | undefined;
  autoFocus: boolean;
  onChange: (patch: Partial<DedicatedServer>) => void;
  onRemove: () => void;
}) {
  const envTokenHost = useStore((s) => s.info?.dedicatedEnvTokenHost ?? '');
  const status = useStore((s) => s.dedicated[server.id]);
  const checking = useStore((s) => !!s.dedicatedChecking[server.id]);
  const check = useStore((s) => s.checkDedicated);

  const addr = parseServerAddress(server.host);
  const address = addr ? serverAddress({ host: addr.host, port: addr.port ?? server.port }) : '';
  const title = server.name.trim() || addr?.host || 'New server';
  const unsaved = !saved || JSON.stringify(saved) !== JSON.stringify(server);
  const envToken = !server.apiKey && !!envTokenHost && addr?.host.toLowerCase() === envTokenHost.toLowerCase();
  const state = !status ? 'checking' : status.ok ? 'up' : 'down';

  const modelOptions = [{ value: '', label: status?.models[0] ? `First model the server lists (${status.models[0]})` : 'First model the server lists' }];
  for (const m of status?.models ?? []) modelOptions.push({ value: m, label: m });
  if (server.model && !(status?.models ?? []).includes(server.model)) modelOptions.push({ value: server.model, label: server.model });

  return (
    <article className="server-card" aria-label={title}>
      <header className="server-card-head">
        <div className="server-card-title">
          <h3>{title}</h3>
          {address && <span className="mono">{address}</span>}
        </div>
        <div className="row-gap">
          <button className="btn btn-quiet" onClick={() => void check(server.id)} disabled={checking || unsaved} title={unsaved ? 'Save first' : undefined}>
            {checking ? <LoaderCircle size={14} className="spin" aria-hidden="true" /> : <RefreshCw size={14} aria-hidden="true" />}
            Check
          </button>
          <button className="icon-btn" aria-label={`Remove ${title}`} title="Remove server" onClick={onRemove}>
            <Trash2 size={15} />
          </button>
        </div>
      </header>

      {!saved ? (
        <p className="server-status muted">Save to connect to this server.</p>
      ) : (
        <p className="server-status">
          <span className={`dot dot-${state}`} aria-hidden="true" />
          <span>
            {status ? status.message : 'Checking…'}
            {unsaved && <span className="muted"> Save to check your changes.</span>}
          </span>
        </p>
      )}
      {saved && status?.ok && (
        <dl className="server-facts">
          <div>
            <dt>Protocol</dt>
            <dd>{status.apiStyle === 'ollama' ? 'Ollama' : 'OpenAI-compatible'}</dd>
          </div>
          {status.authHeader && (saved.apiKey || envToken) && (
            <div>
              <dt>Token sent as</dt>
              <dd className="mono">{AUTH_LABELS[status.authHeader]}</dd>
            </div>
          )}
          <div>
            <dt>Response time</dt>
            <dd>{status.latencyMs} ms</dd>
          </div>
          {status.contextSize && (
            <div>
              <dt>Server context</dt>
              <dd>{status.contextSize.toLocaleString()} tokens</dd>
            </div>
          )}
        </dl>
      )}
      {saved && status && !status.ok && status.details && status.details.length > 0 && (
        <details className="server-answer">
          <summary>What the server answered</summary>
          <ul>
            {status.details.map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
        </details>
      )}

      <div className="grid-2">
        <TextField
          label="Address"
          mono
          autoFocus={autoFocus}
          value={server.host}
          onChange={(v) => onChange({ host: v })}
          placeholder="203.0.113.10 or gemma.example.com"
          help={server.host.trim() && !addr ? <span className="error-text">Enter a hostname or IP address, without a path.</span> : 'Hostname or IP address.'}
        />
        <NumberField
          label="HTTPS port"
          value={server.port}
          nullable={false}
          onChange={(v) => onChange({ port: v === null ? 443 : Math.round(v) })}
          min={1}
          max={65535}
          placeholder="443"
          help={addr?.port !== undefined ? `The address includes port ${addr.port}, so that one is used.` : 'Usually 443, the HTTPS proxy in front of the server.'}
        />
      </div>
      <TextField
        label="Token"
        secret
        mono
        wide
        value={server.apiKey}
        onChange={(v) => onChange({ apiKey: v })}
        placeholder={envToken ? 'Using OPEN_ROCK_DEDICATED_TOKEN from the server’s .env' : 'Paste the API key for this server'}
        savedLabel="Token saved. Paste a new one to replace it."
        removeLabel="Remove saved token"
        help="Stays on the Open Rock server and isn't shown again here."
      />
      <div className="grid-2">
        <TextField label="Name" value={server.name} onChange={(v) => onChange({ name: v })} placeholder={addr?.host ?? 'Gemma'} help="Shown in the sidebar and the server menu." />
        <Select label="Model" value={server.model} options={modelOptions} onChange={(v) => onChange({ model: v })} help="The name sent with each request." />
        <Select
          label="Send the token as"
          value={server.authHeader}
          options={[
            { value: 'auto', label: 'Detect automatically' },
            { value: 'bearer', label: 'Authorization: Bearer <token>' },
            { value: 'x-api-key', label: 'X-API-Key: <token>' },
            { value: 'api-key', label: 'api-key: <token>' },
            { value: 'raw', label: 'Authorization: <token>' },
          ]}
          onChange={(v) => onChange({ authHeader: v })}
          help="Detect tries Bearer first, then the other common API-key headers."
        />
        <Select
          label="Protocol"
          value={server.apiStyle}
          options={[
            { value: 'auto', label: 'Detect automatically' },
            { value: 'openai', label: 'OpenAI-compatible (vLLM, llama.cpp, TGI)' },
            { value: 'ollama', label: 'Ollama' },
          ]}
          onChange={(v) => onChange({ apiStyle: v })}
        />
      </div>
    </article>
  );
}

// ---------------- Appearance ----------------

function Appearance() {
  const prefs = useStore((s) => s.prefs);
  const setPrefs = useStore((s) => s.setPrefs);
  return (
    <>
      <Section title="Appearance" description="Saved on this device only.">
        <Field label="Theme">
          <Segmented
            label="Theme"
            value={prefs.theme}
            options={[
              { value: 'system', label: 'Match system' },
              { value: 'light', label: 'Light' },
              { value: 'dark', label: 'Dark' },
            ]}
            onChange={(v) => setPrefs({ theme: v })}
          />
        </Field>
        <Toggle label="Enter sends the message" checked={prefs.enterToSend} onChange={(v) => setPrefs({ enterToSend: v })} help={prefs.enterToSend ? 'Shift+Enter adds a new line.' : 'Ctrl+Enter sends; Enter adds a new line.'} />
        <Toggle label="Show token counts and timing under replies" checked={prefs.showTokens} onChange={(v) => setPrefs({ showTokens: v })} />
        <Toggle label="Shrink large images before sending" checked={prefs.downscaleImages} onChange={(v) => setPrefs({ downscaleImages: v })} help="Resizes photos to 2048 px on the long edge. Keeps uploads under Bedrock's 3.75 MB image limit." />
      </Section>
    </>
  );
}
