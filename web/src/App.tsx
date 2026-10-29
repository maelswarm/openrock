import { useEffect, useState } from 'react';
import { LoaderCircle } from 'lucide-react';
import { useStore } from './lib/store';
import { parseRoute } from './lib/route';
import { setAccessToken } from './lib/api';
import { Sidebar } from './components/Sidebar';
import { ChatView } from './pages/ChatView';
import { SettingsPage } from './pages/SettingsPage';
import { UsagePage } from './pages/UsagePage';
import { Toasts } from './components/Toasts';

export function App() {
  const booted = useStore((s) => s.booted);
  const bootError = useStore((s) => s.bootError);
  const authRequired = useStore((s) => s.authRequired);
  const route = useStore((s) => s.route);
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  const setSidebar = useStore((s) => s.setSidebar);

  useEffect(() => {
    void useStore.getState().boot();
    const onHash = () => useStore.getState().setRoute(parseRoute(location.hash));
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  if (!booted) {
    return (
      <div className="splash" aria-busy="true">
        <img src="/icon.svg" alt="" width={56} height={56} />
        <LoaderCircle className="spin" size={18} aria-label="Starting" />
      </div>
    );
  }
  if (bootError) return <BootError message={bootError} />;
  if (authRequired) return <AccessGate />;

  return (
    <div className="app">
      <Sidebar />
      {sidebarOpen && <div className="scrim" onClick={() => setSidebar(false)} aria-hidden="true" />}
      <main className="main">
        {route.name === 'chat' && <ChatView />}
        {route.name === 'usage' && <UsagePage />}
        {route.name === 'settings' && <SettingsPage tab={route.tab} />}
      </main>
      <Toasts />
    </div>
  );
}

function BootError({ message }: { message: string }) {
  return (
    <div className="gate">
      <img src="/icon.svg" alt="" width={48} height={48} />
      <h1>Open Rock can't reach its server</h1>
      <p>{message}</p>
      <p className="muted">On the web, start it with <code>npm run dev</code> or <code>npm start</code>. In the desktop app, restart the app.</p>
      <button className="btn btn-primary" onClick={() => location.reload()}>
        Try again
      </button>
    </div>
  );
}

function AccessGate() {
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  return (
    <form
      className="gate"
      onSubmit={async (e) => {
        e.preventDefault();
        setAccessToken(value.trim());
        useStore.setState({ booted: false });
        await useStore.getState().boot();
        if (useStore.getState().authRequired) setError('That access token was not accepted.');
      }}
    >
      <img src="/icon.svg" alt="" width={48} height={48} />
      <h1>Enter your access token</h1>
      <p>This Open Rock server is protected. Use the value of <code>OPEN_ROCK_AUTH_TOKEN</code> from the server's .env file.</p>
      <input className="input" type="password" autoFocus value={value} onChange={(e) => setValue(e.target.value)} aria-label="Access token" />
      {error && <p className="error-text">{error}</p>}
      <button className="btn btn-primary" type="submit" disabled={!value.trim()}>
        Unlock
      </button>
    </form>
  );
}
