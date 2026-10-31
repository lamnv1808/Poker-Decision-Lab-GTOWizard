import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { ErrorNote, Spinner } from '../components/ui';
import { loc } from '../format';
import { useT } from '../i18n';
import type { Localized } from '../types';

interface Mod { id: string; title: Localized; objectives: Localized[]; skills: string[]; levels: [number, number]; scenarioCount: number; ratedScenarioCount: number; attempted: number; masteryPct: number | null; reviewDue: number; skillRatings: { skill: string; rating: number | null }[]; quizKinds: string[] }

export function CurriculumPage() {
  const { t, lang } = useT();
  const [mods, setMods] = useState<Mod[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    api.get<Mod[]>('/curriculum').then(setMods).catch(setError);
  }, []);
  if (error) return <ErrorNote error={error} />;
  if (!mods) return <Spinner />;
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-bold">{t('nav.curriculum')}</h1>
      <div className="grid gap-3 md:grid-cols-2" data-testid="curriculum">
        {mods.map((m) => (
          <article key={m.id} className="rounded-xl border border-ink-700 bg-ink-900 p-4">
            <div className="flex items-baseline justify-between gap-2">
              <h3 className="font-semibold"><span className="mr-2 text-ink-400 tabular">{m.id}</span>{loc(m.title, lang)}</h3>
              <span className="text-xs text-ink-400">{t('curr.levels')} {m.levels[0]}–{m.levels[1]}</span>
            </div>
            <ul className="mt-2 list-disc pl-5 text-sm text-ink-300">{m.objectives.map((o, i) => <li key={i}>{loc(o, lang)}</li>)}</ul>
            <div className="mt-3">
              <div className="mb-1 flex justify-between text-xs text-ink-400"><span>{t('curr.mastery')}</span><span>{m.masteryPct === null ? '—' : `${m.masteryPct}%`}</span></div>
              <div className="h-1.5 rounded-full bg-ink-800"><div className="h-1.5 rounded-full bg-accent" style={{ width: `${m.masteryPct ?? 0}%` }} /></div>
            </div>
            <div className="mt-2 flex flex-wrap gap-x-3 text-xs text-ink-400">
              <span>{m.attempted}/{m.scenarioCount} {t('curr.scenarios')}</span>
              <span>{m.ratedScenarioCount} {t('curr.rated')}</span>
              {m.reviewDue > 0 && <span className="text-gold">{m.reviewDue} {t('curr.due')}</span>}
              <span>{t('curr.elo')}: {m.skillRatings.map((s) => `${t(`skill.${s.skill}`)} ${s.rating ?? '—'}`).join(' · ')}</span>
            </div>
            <div className="mt-3 flex gap-2 text-xs">
              {m.scenarioCount > 0 && <Link to={`/hero?module=${m.id}`} className="rounded-md border border-ink-600 px-2 py-1 hover:border-accent">{t('curr.practice')}</Link>}
              {m.quizKinds.slice(0, 2).map((k) => <Link key={k} to={`/math?kind=${k}`} className="rounded-md border border-ink-600 px-2 py-1 hover:border-accent">∑ {t(`quiz.${k}`)}</Link>)}
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}
