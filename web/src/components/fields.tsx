import { useEffect, useId, useState, type ReactNode } from 'react';
import { Eye, EyeOff, X } from 'lucide-react';
import { SECRET_MASK } from '@open-rock/shared';

export function Field({ label, help, children, wide, htmlFor }: { label: string; help?: ReactNode; children: ReactNode; wide?: boolean; htmlFor?: string }) {
  return (
    <div className={`field${wide ? ' field-wide' : ''}`}>
      <label className="field-label" htmlFor={htmlFor}>
        {label}
      </label>
      <div className="field-control">{children}</div>
      {help && <p className="field-help">{help}</p>}
    </div>
  );
}

export function Section({ title, description, children, aside }: { title: string; description?: ReactNode; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="set-section">
      <div className="set-head">
        <div>
          <h2>{title}</h2>
          {description && <p className="set-desc">{description}</p>}
        </div>
        {aside}
      </div>
      <div className="set-body">{children}</div>
    </section>
  );
}

/** A number that can be left blank to mean "use the default". */
export function NumberField({
  label,
  value,
  onChange,
  help,
  min,
  max,
  step,
  placeholder,
  nullable = true,
  suffix,
}: {
  label: string;
  value: number | null;
  onChange: (v: number | null) => void;
  help?: ReactNode;
  min?: number;
  max?: number;
  step?: number;
  placeholder?: string;
  nullable?: boolean;
  suffix?: string;
}) {
  const id = useId();
  const [raw, setRaw] = useState(value === null ? '' : String(value));
  useEffect(() => {
    setRaw((r) => (Number(r) === value && r !== '' ? r : value === null ? '' : String(value)));
  }, [value]);
  const invalid = raw !== '' && (Number.isNaN(Number(raw)) || (min !== undefined && Number(raw) < min) || (max !== undefined && Number(raw) > max));
  return (
    <Field label={label} help={help} htmlFor={id}>
      <div className={`num${invalid ? ' invalid' : ''}`}>
        <input
          id={id}
          className="input"
          inputMode="decimal"
          value={raw}
          placeholder={placeholder ?? (nullable ? 'Default' : '')}
          onChange={(e) => {
            const v = e.target.value.trim();
            setRaw(e.target.value);
            if (v === '') {
              if (nullable) onChange(null);
              return;
            }
            const n = Number(v);
            if (!Number.isNaN(n) && (min === undefined || n >= min) && (max === undefined || n <= max)) onChange(n);
          }}
          aria-invalid={invalid || undefined}
        />
        {suffix && <span className="num-suffix">{suffix}</span>}
      </div>
      {invalid && (
        <p className="field-error">
          Enter a number{min !== undefined && max !== undefined ? ` from ${min} to ${max}` : min !== undefined ? ` of at least ${min}` : ''}.
        </p>
      )}
    </Field>
  );
}

export function Toggle({ label, checked, onChange, help }: { label: string; checked: boolean; onChange: (v: boolean) => void; help?: ReactNode }) {
  const id = useId();
  return (
    <div className="field field-toggle">
      <div className="toggle-row">
        <label htmlFor={id} className="field-label">
          {label}
        </label>
        <button id={id} type="button" role="switch" aria-checked={checked} className="switch" onClick={() => onChange(!checked)}>
          <span />
        </button>
      </div>
      {help && <p className="field-help">{help}</p>}
    </div>
  );
}

export function Select<T extends string>({
  label,
  value,
  options,
  onChange,
  help,
  wide,
}: {
  label: string;
  value: T;
  /** Options with a `group` are shown under that heading, in the order the groups first appear. */
  options: { value: T; label: string; group?: string }[];
  onChange: (v: T) => void;
  help?: ReactNode;
  wide?: boolean;
}) {
  const id = useId();
  const groups: { name: string | undefined; options: typeof options }[] = [];
  for (const o of options) {
    const g = groups.find((x) => x.name === o.group);
    if (g) g.options.push(o);
    else groups.push({ name: o.group, options: [o] });
  }
  const render = (list: typeof options) =>
    list.map((o) => (
      <option key={o.value} value={o.value}>
        {o.label}
      </option>
    ));
  return (
    <Field label={label} help={help} htmlFor={id} wide={wide}>
      <select id={id} className="input" value={value} onChange={(e) => onChange(e.target.value as T)}>
        {groups.map((g) =>
          g.name ? (
            <optgroup key={g.name} label={g.name}>
              {render(g.options)}
            </optgroup>
          ) : (
            render(g.options)
          ),
        )}
      </select>
    </Field>
  );
}

export function TextField({
  label,
  value,
  onChange,
  help,
  placeholder,
  secret,
  wide,
  mono,
  autoFocus,
  savedLabel = 'Saved. Paste a new value to replace it.',
  removeLabel = 'Remove saved value',
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  help?: ReactNode;
  placeholder?: string;
  secret?: boolean;
  wide?: boolean;
  mono?: boolean;
  autoFocus?: boolean;
  /** Placeholder shown when a secret is already saved on the server. */
  savedLabel?: string;
  removeLabel?: string;
}) {
  const id = useId();
  const [show, setShow] = useState(false);
  // The server never sends a saved secret back, only a mask. Show an empty field with a note instead of fake dots.
  const saved = !!secret && value === SECRET_MASK;
  const [hadSaved, setHadSaved] = useState(saved);
  useEffect(() => {
    if (saved) setHadSaved(true);
  }, [saved]);
  const display = saved ? '' : value;
  return (
    <Field label={label} help={help} htmlFor={id} wide={wide}>
      <div className="text-wrap">
        <input
          id={id}
          className={`input${mono ? ' mono' : ''}${saved ? ' is-saved' : ''}`}
          type={secret && !show ? 'password' : 'text'}
          value={display}
          placeholder={saved ? savedLabel : placeholder}
          autoFocus={autoFocus}
          spellCheck={false}
          autoComplete={secret ? 'new-password' : 'off'}
          onChange={(e) => {
            const v = e.target.value;
            // Clearing what you typed goes back to the saved value; use the remove button to delete it.
            onChange(v === '' && hadSaved ? SECRET_MASK : v);
          }}
        />
        {secret && display !== '' && (
          <button type="button" className="icon-btn reveal" onClick={() => setShow((s) => !s)} aria-label={show ? 'Hide' : 'Show'} aria-pressed={show}>
            {show ? <EyeOff size={15} /> : <Eye size={15} />}
          </button>
        )}
      </div>
      {secret && hadSaved && (
        <button
          type="button"
          className="link-btn"
          onClick={() => {
            setHadSaved(false);
            setShow(false);
            onChange('');
          }}
          disabled={!saved && value === ''}
        >
          {removeLabel}
        </button>
      )}
    </Field>
  );
}

export function TextArea({ label, value, onChange, help, placeholder, rows = 4, mono }: { label: string; value: string; onChange: (v: string) => void; help?: ReactNode; placeholder?: string; rows?: number; mono?: boolean }) {
  const id = useId();
  return (
    <Field label={label} help={help} htmlFor={id} wide>
      <textarea id={id} className={`input${mono ? ' mono' : ''}`} rows={rows} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} spellCheck={!mono} />
    </Field>
  );
}

export function TagInput({ label, values, onChange, help, max, placeholder }: { label: string; values: string[]; onChange: (v: string[]) => void; help?: ReactNode; max?: number; placeholder?: string }) {
  const id = useId();
  const [draft, setDraft] = useState('');
  const add = () => {
    const v = draft;
    if (!v.trim() || values.includes(v) || (max !== undefined && values.length >= max)) return;
    onChange([...values, v]);
    setDraft('');
  };
  return (
    <Field label={label} help={help} htmlFor={id}>
      <div className="tags">
        {values.map((v) => (
          <span className="tag-chip" key={v}>
            <code>{JSON.stringify(v).slice(1, -1)}</code>
            <button type="button" className="icon-btn" aria-label={`Remove ${v}`} onClick={() => onChange(values.filter((x) => x !== v))}>
              <X size={12} />
            </button>
          </span>
        ))}
        {(max === undefined || values.length < max) && (
          <input
            id={id}
            className="tag-input"
            value={draft}
            placeholder={values.length ? '' : placeholder ?? 'Type and press Enter'}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                add();
              } else if (e.key === 'Backspace' && !draft && values.length) {
                onChange(values.slice(0, -1));
              }
            }}
            onBlur={add}
          />
        )}
      </div>
    </Field>
  );
}

export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={o.value === value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}
