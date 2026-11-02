import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { Empty, ErrorNote, GradeBadge, Panel, Spinner, Stat } from '../components/ui';
import { fmtNum } from '../format';
import { useT } from '../i18n';
import type { Grade } from '../types';

interface Group {
  spots: number;
  graded: number;
  outsideModel: number;
  verified: number;
  nearThreshold: number;
  inconclusiveBounty: number;
  evLossBB: number;
  tooTight: number;
  tooLoose: number;
  bands: { band: string; n: number; verified: number; evLossBB: number }[];
}
interface Spot { decisionId: string; externalHandId: string; playedAt: string | null; tournament: string | null; format: string | null; cls: 'verified' | 'nearThreshold' | 'inconclusiveBounty'; role: string; stackBB: number; exactStackBB?: number; exactDeadBB?: number; heroClass: string; heroAction: string; bestAction: string; frequency?: number; grade: Grade | null; evLossBB: number | null; evLossRangeBB?: [number, number] | null }
interface Audit { totalHands: number; sbShove: Group; bbCall: Group; worst: Spot[]; assumptions: { en: string[]; vi: string[] } }

const CLS_STYLE: Record<string, string> = { verified: 'border-red-500/50 text-red-300', nearThreshold: 'border-ink-500 text-ink-300', inconclusiveBounty: 'border-amber-500/50 text-amber-300' };

export function GtoAudit() {
  const { t, lang } = useT();
  const [a, setA] = useState<Audit | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    api.get<Audit>('/gto/audit').then(setA).catch(setError);
  }, []);
  if (error) return <ErrorNote error={error} />;
  if (!a) return <Spinner />;
  const group = (key: 'sbShove' | 'bbCall', g: Group) => (
    <Panel title={t(`gto.${key}`)}>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label={t('audit.spots')} value={g.graded} sub={`${g.outsideModel} ${t('audit.outside')}`} />
        <Stat label={t('audit.verified')} value={g.verified} sub={`${t('audit.tooTight')} ${g.tooTight} · ${t('audit.tooLoose')} ${g.tooLoose}`} />
        <Stat label={t('audit.evLossVerified')} value={`${fmtNum(g.evLossBB, 2)} BB`} sub={t('audit.sumNote')} />
        <Stat label={t('audit.notVerified')} value={g.nearThreshold + g.inconclusiveBounty} sub={`${t('audit.cls.nearThreshold')} ${g.nearThreshold} · ${t('audit.cls.inconclusiveBounty')} ${g.inconclusiveBounty}`} />
      </div>
      <table className="mt-3 w-full text-sm tabular">
        <thead className="text-xs text-ink-400"><tr><th className="text-left">{t('gto.effective')}</th><th className="text-right">n</th><th className="text-right">{t('audit.verified')}</th><th className="text-right">{t('audit.evLossVerified')}</th></tr></thead>
        <tbody>{g.bands.map((b) => <tr key={b.band} className="border-t border-ink-800"><td className="py-1">{b.band} BB</td><td className="text-right">{b.n}</td><td className="text-right">{b.verified}</td><td className="text-right">{fmtNum(b.evLossBB, 2)} BB</td></tr>)}</tbody>
      </table>
    </Panel>
  );
  const act = (x: string) => (x === 'shove' ? t('gto.shove') : x === 'call' ? t('act.call') : x === 'fold' ? t('act.fold') : x === 'mixed' ? t('gto.mixed') : t('audit.other'));
  return (
    <div className="space-y-4">
      <div>
        <Link to="/gto" className="text-xs text-accent">← {t('nav.gto')}</Link>
        <h1 className="text-xl font-bold">{t('nav.audit')}</h1>
        <p className="text-sm text-ink-300">{t('audit.intro', { n: a.totalHands.toLocaleString() })}</p>
      </div>
      {a.sbShove.spots + a.bbCall.spots === 0 ? (
        <Empty>{t('audit.none')} <Link className="text-accent" to="/hands">{t('nav.hands')}</Link></Empty>
      ) : (
        <>
          <div className="grid gap-4 xl:grid-cols-2" data-testid="audit-summary">
            {group('sbShove', a.sbShove)}
            {group('bbCall', a.bbCall)}
          </div>
          <Panel title={t('audit.worst')}>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-left text-sm" data-testid="audit-worst">
                <thead className="text-xs text-ink-400"><tr><th className="py-1.5">{t('hands.hand')}</th><th>{t('audit.class')}</th><th>{t('gto.spot')}</th><th>{t('fb.youChose')}</th><th>{t('gto.equilibrium')}</th><th>{t('audit.chipEvLoss')}</th></tr></thead>
                <tbody>
                  {a.worst.map((s) => (
                    <tr key={s.decisionId} className="border-t border-ink-800">
                      <td className="py-1.5"><Link to={`/replay?decision=${s.decisionId}`} className="font-mono text-xs text-accent">#{s.externalHandId}</Link><div className="text-[11px] text-ink-400">{s.playedAt ? new Date(s.playedAt).toLocaleDateString(lang) : ''} · {s.format}</div></td>
                      <td><span className={`rounded border px-1.5 text-[10px] uppercase ${CLS_STYLE[s.cls]}`}>{t(`audit.cls.${s.cls}`)}</span></td>
                      <td className="text-xs">{s.role === 'sbShove' ? 'SB' : 'BB'} · {s.heroClass} · {s.exactStackBB ?? s.stackBB} BB{s.exactDeadBB !== undefined ? ` · ${t('audit.dead')} ${s.exactDeadBB}` : ''}</td>
                      <td>{act(s.heroAction)}</td>
                      <td className="text-emerald-300">{act(s.bestAction)}{s.bestAction === 'mixed' && s.frequency !== undefined ? ` ${Math.round(s.frequency * 100)}%` : ''}</td>
                      <td className="tabular"><GradeBadge grade={s.grade} /> {fmtNum(s.evLossBB, 2)}{s.evLossRangeBB ? <span className="text-[11px] text-ink-400"> ({fmtNum(s.evLossRangeBB[0], 2)}–{fmtNum(s.evLossRangeBB[1], 2)})</span> : null}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>
          <Panel title={t('fb.assumptions')}>
            <ul className="list-disc space-y-1 pl-5 text-sm text-ink-300">
              {a.assumptions[lang].map((x, i) => <li key={i}>{x}</li>)}
              <li>{t('audit.rounding')}</li>
              <li>{t('audit.robust')}</li>
              <li>{t('audit.icm')}</li>
              <li>{t('audit.timeouts')}</li>
            </ul>
          </Panel>
        </>
      )}
    </div>
  );
}
