import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { LangSwitch } from '../components/Layout';
import { ErrorNote } from '../components/ui';
import { useT } from '../i18n';
import { useApp } from '../store';
import type { Me } from '../types';

export function AuthPage() {
  const { t } = useT();
  const { setMe, lang } = useApp();
  const nav = useNavigate();
  const [tab, setTab] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [invite, setInvite] = useState(() => new URLSearchParams(window.location.search).get('invite') ?? '');
  const [needsInvite, setNeedsInvite] = useState(false);
  useEffect(() => {
    api.get<{ registration: 'invite' | 'open' }>('/auth/config').then((c) => setNeedsInvite(c.registration === 'invite')).catch(() => {});
    if (new URLSearchParams(window.location.search).get('invite')) setTab('register');
  }, []);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const me = tab === 'login' ? await api.post<Me>('/auth/login', { email, password }) : await api.post<Me>('/auth/register', { email, password, displayName: name, language: lang, inviteCode: invite.trim() || undefined });
      setMe(me);
      nav('/');
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  const input = 'w-full rounded-lg border border-ink-600 bg-ink-850 px-3 py-2 text-sm focus:border-accent';
  return (
    <div className="flex min-h-full items-center justify-center p-4">
      <div className="w-full max-w-sm space-y-5">
        <div className="flex items-center justify-between">
          <div className="text-lg font-bold"><span className="text-accent">♠</span> Poker Decision Lab</div>
          <LangSwitch />
        </div>
        <p className="text-sm text-ink-300">{t('auth.tagline')}</p>
        <div className="rounded-xl border border-ink-700 bg-ink-900 p-5">
          <div className="mb-4 grid grid-cols-2 rounded-lg border border-ink-700 p-0.5 text-sm">
            {(['login', 'register'] as const).map((k) => (
              <button key={k} type="button" onClick={() => setTab(k)} className={`rounded-md py-1.5 font-medium ${tab === k ? 'bg-ink-700' : 'text-ink-400'}`} data-testid={`tab-${k}`}>
                {t(`auth.${k}`)}
              </button>
            ))}
          </div>
          <form onSubmit={submit} className="space-y-3">
            {tab === 'register' && needsInvite && (
              <label className="block text-xs text-ink-300">
                {t('auth.invite')}
                <input className={`${input} uppercase tracking-widest`} value={invite} onChange={(e) => setInvite(e.target.value)} maxLength={20} name="invite" data-testid="auth-invite" />
                <span className="mt-1 block text-[11px] text-ink-500">{t('auth.inviteHelp')}</span>
              </label>
            )}
            {tab === 'register' && (
              <label className="block text-xs text-ink-300">
                {t('auth.name')}
                <input className={input} value={name} onChange={(e) => setName(e.target.value)} required maxLength={60} name="name" autoComplete="nickname" />
              </label>
            )}
            <label className="block text-xs text-ink-300">
              {t('auth.email')}
              <input className={input} type="email" value={email} onChange={(e) => setEmail(e.target.value)} required name="email" autoComplete="email" />
            </label>
            <label className="block text-xs text-ink-300">
              {t('auth.password')}
              <input className={input} type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={tab === 'register' ? 8 : 1} name="password" autoComplete={tab === 'login' ? 'current-password' : 'new-password'} />
            </label>
            <ErrorNote error={error} />
            <button disabled={busy} className="w-full rounded-lg bg-felt-500 py-2.5 text-sm font-bold hover:bg-felt-600 disabled:opacity-50" data-testid="auth-submit">
              {t(`auth.${tab}`)}
            </button>
          </form>
        </div>
        <p className="text-xs text-ink-400">{t('auth.disclaimer')}</p>
      </div>
    </div>
  );
}
