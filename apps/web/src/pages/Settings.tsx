import { useEffect, useState } from 'react';
import { api } from '../api';
import { ErrorNote, Panel, Toggle } from '../components/ui';
import { useT } from '../i18n';
import { useApp } from '../store';

export function SettingsPage() {
  const { t } = useT();
  const { me, updatePrefs, setLang } = useApp();
  const [name, setName] = useState(me?.displayName ?? '');
  const [error, setError] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);
  if (!me) return null;
  const p = me.preferences;
  const save = async (patch: Parameters<typeof updatePrefs>[0]) => {
    setError(null);
    try {
      await updatePrefs(patch);
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    } catch (e) {
      setError(e);
    }
  };
  const row = (label: string, control: React.ReactNode, help?: string) => (
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-ink-800 py-3 last:border-0">
      <div><div className="text-sm font-medium">{label}</div>{help && <div className="text-xs text-ink-400">{help}</div>}</div>
      {control}
    </div>
  );
  return (
    <div className="max-w-2xl space-y-4">
      <h1 className="text-xl font-bold">{t('nav.settings')} {saved && <span className="text-sm font-normal text-emerald-400">✓ {t('settings.saved')}</span>}</h1>
      <ErrorNote error={error} />
      <Panel title={t('settings.account')}>
        {row(t('auth.email'), <span className="text-sm text-ink-300">{me.email}</span>)}
        {row(
          t('auth.name'),
          <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); void save({ displayName: name } as never); }}>
            <input value={name} onChange={(e) => setName(e.target.value)} className="rounded-md border border-ink-600 bg-ink-850 px-2 py-1 text-sm" maxLength={60} />
            <button className="rounded-md border border-ink-600 px-2 text-sm">{t('settings.save')}</button>
          </form>,
        )}
      </Panel>
      {me?.isOwner && <InvitesPanel />}
      <Panel title={t('settings.training')}>
        {row(t('settings.language'), <Toggle label={t('settings.language')} value={p.language} onChange={(v) => void setLang(v)} options={[{ value: 'en', label: 'English' }, { value: 'vi', label: 'Tiếng Việt' }]} />)}
        {row(t('settings.defaultMode'), <Toggle label={t('settings.defaultMode')} value={p.defaultMode} onChange={(v) => void save({ defaultMode: v })} options={[{ value: 'practice', label: t('mode.practice') }, { value: 'rated', label: t('mode.rated') }]} />, t('mode.help'))}
        {row(t('settings.explanation'), <Toggle label={t('settings.explanation')} value={p.explanationView} onChange={(v) => void save({ explanationView: v })} options={[{ value: 'quick', label: t('fb.quick') }, { value: 'deep', label: t('fb.deep') }]} />)}
        {row(t('settings.strategy'), <Toggle label={t('settings.strategy')} value={p.strategyView} onChange={(v) => void save({ strategyView: v })} options={[{ value: 'gto', label: t('fb.gto') }, { value: 'exploit', label: t('fb.exploit') }]} />)}
        {row(t('settings.units'), <Toggle label={t('settings.units')} value={p.showBB ? 'bb' : 'chips'} onChange={(v) => void save({ showBB: v === 'bb' })} options={[{ value: 'bb', label: 'BB' }, { value: 'chips', label: t('settings.chips') }]} />)}
      </Panel>
      <Panel title={t('export.title')}>
        <div className="flex flex-wrap gap-2 text-sm">
          <a href="/api/export" download className="rounded-lg border border-ink-600 px-3 py-1.5 hover:border-accent" data-testid="export">{t('export.json')}</a>
          <a href="/api/export?raw=1" download className="rounded-lg border border-ink-600 px-3 py-1.5 hover:border-accent">{t('export.json')} + {t('export.raw')}</a>
        </div>
      </Panel>
      <Panel title={t('settings.about')}>
        <p className="text-sm text-ink-300">{t('settings.aboutText')}</p>
      </Panel>
    </div>
  );
}

/** Owner only: single-use invite codes for the private lab. */
function InvitesPanel() {
  const { t, lang } = useT();
  const [list, setList] = useState<{ id: string; note: string | null; expiresAt: string; usedBy: string | null; status: 'open' | 'used' | 'expired' }[]>([]);
  const [note, setNote] = useState('');
  const [fresh, setFresh] = useState<{ code: string; link: string } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const load = () => void api.get<typeof list>('/invites').then(setList).catch(setError);
  useEffect(load, []);
  const create = async () => {
    try {
      const r = await api.post<{ code: string }>('/invites', { note: note.trim() || undefined });
      setFresh({ code: r.code, link: `${window.location.origin}/login?invite=${r.code}` });
      setNote('');
      load();
    } catch (e) {
      setError(e);
    }
  };
  return (
    <Panel title={t('invite.title')}>
      <p className="mb-2 text-xs text-ink-400">{t('invite.help')}</p>
      <div className="flex gap-2">
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder={t('invite.note')} maxLength={80} className="flex-1 rounded-md border border-ink-600 bg-ink-850 px-2 py-1.5 text-sm" />
        <button type="button" onClick={() => void create()} className="rounded-md bg-felt-500 px-3 py-1.5 text-sm font-semibold" data-testid="invite-create">{t('invite.create')}</button>
      </div>
      {fresh && (
        <div className="mt-2 rounded border border-emerald-500/40 bg-emerald-500/5 p-2 text-sm" data-testid="invite-fresh">
          <div className="font-mono text-lg tracking-widest">{fresh.code}</div>
          <div className="break-all text-xs text-ink-300">{fresh.link}</div>
          <div className="text-[11px] text-ink-400">{t('invite.once')}</div>
        </div>
      )}
      <ErrorNote error={error} />
      <ul className="mt-2 divide-y divide-ink-800 text-xs">
        {list.map((i) => (
          <li key={i.id} className="flex justify-between py-1.5">
            <span>{i.note ?? '—'}</span>
            <span className="text-ink-400">{t(`invite.status.${i.status}`)}{i.usedBy ? ` · ${i.usedBy}` : ` · ${new Date(i.expiresAt).toLocaleDateString(lang)}`}</span>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
