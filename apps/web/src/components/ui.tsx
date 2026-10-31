import type { ReactNode } from 'react';
import { useT } from '../i18n';
import type { Grade } from '../types';

export function Panel({ title, children, className = '', actions }: { title?: ReactNode; children: ReactNode; className?: string; actions?: ReactNode }) {
  return (
    <section className={`rounded-xl border border-ink-700 bg-ink-900 p-4 ${className}`}>
      {(title || actions) && (
        <div className="mb-3 flex items-center justify-between gap-2">
          {title && <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-300">{title}</h2>}
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}

export function Stat({ label, value, sub, testId }: { label: string; value: ReactNode; sub?: ReactNode; testId?: string }) {
  return (
    <div className="rounded-xl border border-ink-700 bg-ink-900 p-4" data-testid={testId}>
      <div className="text-xs uppercase tracking-wide text-ink-400">{label}</div>
      <div className="mt-1 text-2xl font-bold tabular">{value}</div>
      {sub && <div className="mt-0.5 text-xs text-ink-400">{sub}</div>}
    </div>
  );
}

const GRADE_CLS: Record<Grade, string> = {
  excellent: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40',
  good: 'bg-green-500/15 text-green-300 border-green-500/30',
  acceptable: 'bg-sky-500/15 text-sky-300 border-sky-500/30',
  marginal: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
  mistake: 'bg-orange-600/20 text-orange-300 border-orange-500/40',
  major: 'bg-red-600/25 text-red-300 border-red-500/50',
};

export function GradeBadge({ grade, large = false }: { grade: Grade | null; large?: boolean }) {
  const { t } = useT();
  if (!grade) return <span className="rounded border border-ink-600 px-2 py-0.5 text-xs text-ink-400">{t('grade.ungraded')}</span>;
  return <span className={`rounded border font-semibold ${GRADE_CLS[grade]} ${large ? 'px-3 py-1 text-base' : 'px-2 py-0.5 text-xs'}`} data-testid="grade">{t(`grade.${grade}`)}</span>;
}

const SOURCE_CLS: Record<string, string> = {
  MATH_VERIFIED: 'border-emerald-500/40 text-emerald-300',
  SOLVER_VERIFIED: 'border-violet-500/40 text-violet-300',
  COACH_REVIEWED: 'border-sky-500/40 text-sky-300',
  HEURISTIC: 'border-amber-500/40 text-amber-300',
  EXPERIMENTAL: 'border-red-500/40 text-red-300',
};

export function SourceBadge({ cls }: { cls: string }) {
  const { t } = useT();
  return (
    <span className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${SOURCE_CLS[cls] ?? 'border-ink-600 text-ink-300'}`} title={t(`sourceHelp.${cls}`)}>
      {t(`source.${cls}`)}
    </span>
  );
}

export function Toggle<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-lg border border-ink-600 p-0.5 text-xs">
      {options.map((o) => (
        <button
          key={o.value}
          role="radio"
          aria-checked={value === o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={`rounded-md px-2.5 py-1 font-medium ${value === o.value ? 'bg-ink-600 text-ink-100' : 'text-ink-400 hover:text-ink-100'}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Difficulty({ n }: { n: number }) {
  return (
    <span className="text-xs text-gold" aria-label={`difficulty ${n} of 5`}>
      {'●'.repeat(n)}
      <span className="text-ink-600">{'●'.repeat(5 - n)}</span>
    </span>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="rounded-lg border border-dashed border-ink-700 p-6 text-center text-sm text-ink-400">{children}</div>;
}

export function Spinner() {
  return <div className="h-5 w-5 animate-spin rounded-full border-2 border-ink-600 border-t-accent" role="status" aria-label="loading" />;
}

export function ErrorNote({ error }: { error: unknown }) {
  if (!error) return null;
  return <div className="rounded-md border border-red-500/40 bg-red-900/20 px-3 py-2 text-sm text-red-200">{error instanceof Error ? error.message : String(error)}</div>;
}
