export type SettingsTab = 'variable' | 'dedicated' | 'appearance';

export type Route = { name: 'chat'; id?: string } | { name: 'usage' } | { name: 'settings'; tab: SettingsTab };

export function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  if (parts[0] === 'c' && parts[1]) return { name: 'chat', id: decodeURIComponent(parts[1]) };
  if (parts[0] === 'usage') return { name: 'usage' };
  if (parts[0] === 'settings') {
    const tab = parts[1] === 'dedicated' || parts[1] === 'appearance' ? parts[1] : 'variable';
    return { name: 'settings', tab };
  }
  return { name: 'chat' };
}

export function routeHash(r: Route): string {
  if (r.name === 'chat') return r.id ? `#/c/${encodeURIComponent(r.id)}` : '#/';
  if (r.name === 'usage') return '#/usage';
  return `#/settings/${r.tab}`;
}

export function navigate(r: Route, replace = false) {
  const h = routeHash(r);
  if (location.hash === h) return;
  if (replace) history.replaceState(null, '', h);
  else location.hash = h;
  if (replace) window.dispatchEvent(new HashChangeEvent('hashchange'));
}
