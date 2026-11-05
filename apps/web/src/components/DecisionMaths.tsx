import { useT } from '../i18n';

/** Decision Maths as the server sends it (only when DQE_DECISION_MATHS is on). */
export interface DecisionMathFactView {
  id: string;
  formulaId: string;
  formula: string;
  inputs: { name: string; value: number; unit: string }[];
  value: number;
  unit: 'fraction' | 'ratio' | 'BB';
  class: 'ARITHMETIC_IDENTITY' | 'CONDITIONAL_MODEL_REFERENCE';
  assumptions: string[];
  applicability: string[];
  caveats: string[];
}
export interface DecisionMathView {
  version: string;
  status: 'ok' | 'unsupported';
  unsupportedReason: string | null;
  facts: DecisionMathFactView[];
  unsupported: { id: string; reason: string }[];
  strategicVerdict: 'NOT_ESTABLISHED';
  strategicVerdictReason: string;
  gradeable: false;
}

const fmt = (f: DecisionMathFactView) => {
  if (f.unit === 'fraction') return `${(f.value * 100).toFixed(1)}%`;
  if (f.unit === 'BB') return `${f.value % 1 === 0 ? f.value : f.value.toFixed(1)} BB`;
  if (f.id === 'potOdds') return `${f.value.toFixed(1)} : 1`;
  if (f.id === 'betFractionOfPot') return `${Math.round(f.value * 100)}% pot`;
  if (f.id === 'riskReward') return `${f.inputs[0]?.value ?? '?'} BB : ${f.inputs[1]?.value ?? '?'} BB`;
  return f.value.toFixed(1);
};

/**
 * Exact arithmetic about the decision, separated from what depends on assumptions and from what is unknown.
 * Never shows a grade: the strategic verdict is always "not established" here.
 */
export function DecisionMaths({ m }: { m: DecisionMathView }) {
  const { t } = useT();
  const label = (id: string) => t(`dm.f.${id}`);
  if (m.status === 'unsupported')
    return (
      <div className="mt-2 rounded-lg border border-ink-700 p-2 text-xs" data-testid="decision-maths">
        <p className="font-semibold">{t('dm.title')}</p>
        <p className="text-ink-300" data-testid="dm-unsupported">{t('dm.unsupported')}: {m.unsupportedReason}</p>
      </div>
    );
  const exact = m.facts.filter((f) => f.class === 'ARITHMETIC_IDENTITY');
  const conditional = m.facts.filter((f) => f.class === 'CONDITIONAL_MODEL_REFERENCE');
  return (
    <div className="mt-2 space-y-1.5 rounded-lg border border-ink-700 p-2 text-xs" data-testid="decision-maths">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="font-semibold">{t('dm.title')}</span>
        <span className="rounded border border-indigo-400/60 px-1.5 py-0.5 font-bold uppercase text-indigo-300" data-testid="dm-evidence">{t('dm.evidence.exact')}</span>
      </div>
      <ul className="tabular space-y-0.5" data-testid="dm-exact">
        {exact.map((f) => (
          <li key={f.id} data-testid={`dm-${f.id}`}>
            {label(f.id)}: <span className="font-semibold">{fmt(f)}</span>
            {f.caveats[0] && <span className="text-ink-400"> — {f.caveats[0]}</span>}
          </li>
        ))}
      </ul>
      {conditional.length > 0 && (
        <details className="rounded border border-amber-500/30 p-1.5" data-testid="dm-conditional">
          <summary className="cursor-pointer text-amber-300">{t('dm.conditional')}</summary>
          <ul className="mt-1 space-y-1">
            {conditional.map((f) => (
              <li key={f.id}>
                {label(f.id)}: <span className="font-semibold">{fmt(f)}</span>
                <span className="block text-ink-400">{t('dm.ifAssumptions')}: {f.assumptions.join(' ')}</span>
                {f.caveats.map((c, i) => <span key={i} className="block text-ink-500">{c}</span>)}
              </li>
            ))}
          </ul>
        </details>
      )}
      {m.unsupported.length > 0 && (
        <ul className="space-y-0.5 text-ink-400" data-testid="dm-not-available">
          {m.unsupported.map((u) => <li key={u.id}>{label(u.id)}: {t('dm.notAvailable')} — {u.reason}</li>)}
        </ul>
      )}
      <p className="border-t border-ink-700 pt-1 text-ink-300" data-testid="dm-verdict">
        <span className="font-semibold">{t('dm.verdict')}:</span> {t('dm.verdict.notEstablished')}. <span className="text-ink-400">{m.strategicVerdictReason}</span>
      </p>
    </div>
  );
}
