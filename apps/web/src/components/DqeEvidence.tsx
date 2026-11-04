import { useT } from '../i18n';

/** The Decision Quality Engine verdict as the server sends it (only when the DQE_FEEDBACK flag is on). */
export interface DqeVerdictView {
  category: 'VERIFIED_SOLVER_EV' | 'VERIFIED_REFERENCE_FREQUENCY' | 'EXACT_MATHEMATICAL_RESULT' | 'MODEL_ESTIMATE' | 'HEURISTIC_GUIDANCE' | 'INSUFFICIENT_EVIDENCE';
  label: string;
  grade: string | null;
  evLossBB: number | null;
  modelEvLossBB: number | null;
  bestAction: string | null;
  frequencies: Record<string, number> | null;
  source: { id: string; version: string; referenceKey: string } | null;
  matchStatus: 'exact' | 'grid_rounded' | null;
  approximation: string | null;
  facts: Record<string, number | string | null>;
  missing: { reason: string; detail: string } | null;
  engineVersion: string;
}

const CLS: Record<DqeVerdictView['category'], string> = {
  VERIFIED_SOLVER_EV: 'border-emerald-500/60 text-emerald-300',
  VERIFIED_REFERENCE_FREQUENCY: 'border-sky-500/60 text-sky-300',
  EXACT_MATHEMATICAL_RESULT: 'border-indigo-400/60 text-indigo-300',
  MODEL_ESTIMATE: 'border-amber-500/60 text-amber-300',
  HEURISTIC_GUIDANCE: 'border-ink-500 text-ink-300',
  INSUFFICIENT_EVIDENCE: 'border-ink-600 text-ink-400',
};

/**
 * Evidence-labelled verdict. Never shows an EV loss unless the evidence is verified solver EV; a model
 * difference is labelled as a model estimate; an Unrated verdict names exactly what is missing.
 */
export function DqeEvidence({ v }: { v: DqeVerdictView }) {
  const { t } = useT();
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  return (
    <div className="mt-2 space-y-1.5 rounded-lg border border-ink-700 p-2 text-xs" data-testid="dqe-evidence">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className={`rounded border px-1.5 py-0.5 font-bold uppercase ${CLS[v.category]}`} data-testid="dqe-category">{t(`dqe.cat.${v.category}`)}</span>
        {v.matchStatus === 'grid_rounded' && <span className="text-ink-400">{t('dqe.gridRounded')}</span>}
      </div>
      {v.category === 'VERIFIED_SOLVER_EV' && v.evLossBB !== null && <p>{t('dqe.evLoss', { x: v.evLossBB })}</p>}
      {v.category === 'MODEL_ESTIMATE' && v.modelEvLossBB !== null && <p data-testid="dqe-model-diff">{t('dqe.modelDiff', { x: v.modelEvLossBB })}</p>}
      {v.frequencies && (
        <p data-testid="dqe-freq">
          {t('dqe.freq')}: {Object.entries(v.frequencies).map(([a, f]) => `${a} ${pct(f)}`).join(' · ')}
        </p>
      )}
      {v.approximation && <p className="text-amber-300/80">{t('dqe.approx')}: {v.approximation}</p>}
      {v.missing && <p className="text-ink-300" data-testid="dqe-missing">{t('dqe.missing')}: {v.missing.detail}</p>}
      {v.source && <p className="text-ink-500">{t('dqe.source')}: {v.source.id} · {v.source.version}</p>}
    </div>
  );
}
