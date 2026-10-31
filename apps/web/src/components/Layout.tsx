import { useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useT } from '../i18n';
import { useApp } from '../store';

export const NAV = [
  { to: '/', key: 'dashboard', icon: '▦' },
  { to: '/train', key: 'train', icon: '◎' },
  { to: '/hero', key: 'hero', icon: '♠' },
  { to: '/villain', key: 'villain', icon: '◐' },
  { to: '/math', key: 'math', icon: '∑' },
  { to: '/hands', key: 'hands', icon: '⇪' },
  { to: '/leaks', key: 'leaks', icon: '⚠' },
  { to: '/progress', key: 'progress', icon: '↗' },
  { to: '/curriculum', key: 'curriculum', icon: '☰' },
  { to: '/settings', key: 'settings', icon: '⚙' },
];

export function LangSwitch() {
  const { lang, setLang } = useApp();
  return (
    <div className="inline-flex rounded-md border border-ink-600 text-xs" role="group" aria-label="Language">
      {(['en', 'vi'] as const).map((l) => (
        <button key={l} type="button" onClick={() => void setLang(l)} aria-pressed={lang === l} data-testid={`lang-${l}`} className={`px-2 py-1 font-semibold uppercase ${lang === l ? 'bg-ink-600 text-ink-100' : 'text-ink-400'}`}>
          {l}
        </button>
      ))}
    </div>
  );
}

export function Layout() {
  const { t } = useT();
  const { me, logout } = useApp();
  const [open, setOpen] = useState(false);
  const nav = useNavigate();
  const links = (
    <nav className="flex flex-col gap-0.5 p-2">
      {NAV.map((n) => (
        <NavLink
          key={n.to}
          to={n.to}
          end={n.to === '/'}
          onClick={() => setOpen(false)}
          className={({ isActive }) => `flex items-center gap-3 rounded-lg px-3 py-2 text-sm ${isActive ? 'bg-ink-800 font-semibold text-accent' : 'text-ink-300 hover:bg-ink-850 hover:text-ink-100'}`}
        >
          <span className="w-4 text-center" aria-hidden>{n.icon}</span>
          {t(`nav.${n.key}`)}
        </NavLink>
      ))}
    </nav>
  );
  return (
    <div className="flex min-h-full">
      <aside className="sticky top-0 hidden h-screen w-56 shrink-0 flex-col border-r border-ink-800 bg-ink-900 lg:flex">
        <div className="px-5 py-4 text-base font-bold tracking-tight"><span className="text-accent">♠</span> Poker Decision Lab</div>
        {links}
      </aside>
      {open && (
        <div className="fixed inset-0 z-40 bg-black/60 lg:hidden" onClick={() => setOpen(false)}>
          <aside className="h-full w-64 bg-ink-900" onClick={(e) => e.stopPropagation()}>
            <div className="px-5 py-4 font-bold"><span className="text-accent">♠</span> Poker Decision Lab</div>
            {links}
          </aside>
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex items-center gap-3 border-b border-ink-800 bg-ink-950/90 px-4 py-2.5 backdrop-blur">
          <button type="button" className="rounded-md border border-ink-700 px-2 py-1 lg:hidden" onClick={() => setOpen(true)} aria-label={t('nav.menu')} data-testid="menu-button">☰</button>
          <div className="font-semibold lg:hidden"><span className="text-accent">♠</span> PDL</div>
          <div className="ml-auto flex items-center gap-3">
            <LangSwitch />
            <span className="hidden text-sm text-ink-300 sm:inline" data-testid="user-name">{me?.displayName}</span>
            <button
              type="button"
              className="rounded-md border border-ink-700 px-2 py-1 text-xs text-ink-300 hover:text-ink-100"
              onClick={async () => {
                await logout();
                nav('/login');
              }}
              data-testid="logout"
            >
              {t('auth.logout')}
            </button>
          </div>
        </header>
        <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-5">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
