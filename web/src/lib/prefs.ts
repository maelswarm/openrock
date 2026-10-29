// Per-device conveniences kept in localStorage. Everything else lives on the server.

export interface Prefs {
  theme: 'system' | 'light' | 'dark';
  enterToSend: boolean;
  showTokens: boolean;
  downscaleImages: boolean;
  lastModel: { bedrock: string; dedicated: string };
  mode: 'bedrock' | 'dedicated' | null;
  /** Chart color slot per model id, so a model keeps its color across ranges. */
  colorSlots: Record<string, number>;
}

const KEY = 'open-rock.prefs';

const DEFAULTS: Prefs = {
  theme: 'system',
  enterToSend: true,
  showTokens: true,
  downscaleImages: true,
  lastModel: { bedrock: '', dedicated: '' },
  mode: null,
  colorSlots: {},
};

export function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return structuredClone(DEFAULTS);
    const p = JSON.parse(raw) as Partial<Prefs>;
    return { ...structuredClone(DEFAULTS), ...p, lastModel: { ...DEFAULTS.lastModel, ...(p.lastModel ?? {}) } };
  } catch {
    return structuredClone(DEFAULTS);
  }
}

export function savePrefs(p: Prefs) {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    // storage unavailable; prefs last for this session only
  }
}

export function applyTheme(theme: Prefs['theme']) {
  const root = document.documentElement;
  if (theme === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', theme);
}
