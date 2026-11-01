import { useEffect, useState } from 'react';
import { api } from '../api';
import { useT } from '../i18n';

interface Note { id: string; body: string; updatedAt: string }

/** Personal notes attached to a scenario, hand or attempt (stored server-side, private). */
export function NotesPanel({ targetType, targetRef }: { targetType: 'scenario' | 'hand' | 'attempt'; targetRef: string }) {
  const { t, lang } = useT();
  const [notes, setNotes] = useState<Note[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const load = () => void api.get<Note[]>(`/notes?targetType=${targetType}&targetRef=${encodeURIComponent(targetRef)}`).then(setNotes).catch(() => undefined);
  useEffect(load, [targetType, targetRef]);
  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!draft.trim()) return;
    setBusy(true);
    try {
      await api.post('/notes', { targetType, targetRef, body: draft.trim() });
      setDraft('');
      load();
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-2" data-testid="notes">
      {notes.map((n) => (
        <div key={n.id} className="group flex items-start gap-2 rounded-md bg-ink-850 px-2.5 py-1.5 text-sm">
          <p className="flex-1 whitespace-pre-wrap">{n.body}</p>
          <span className="text-[10px] text-ink-400">{new Date(n.updatedAt).toLocaleDateString(lang)}</span>
          <button type="button" aria-label={t('notes.delete')} onClick={async () => { await api.del(`/notes/${n.id}`); load(); }} className="text-xs text-ink-400 hover:text-red-400">✕</button>
        </div>
      ))}
      <form onSubmit={add} className="flex gap-2">
        <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={2} maxLength={5000} placeholder={t('notes.placeholder')} aria-label={t('notes.placeholder')} className="flex-1 resize-y rounded-md border border-ink-600 bg-ink-850 px-2 py-1.5 text-sm" data-testid="note-input" />
        <button disabled={busy || !draft.trim()} className="self-end rounded-md border border-ink-600 px-3 py-1.5 text-sm hover:border-accent disabled:opacity-40" data-testid="note-save">{t('notes.add')}</button>
      </form>
    </div>
  );
}
