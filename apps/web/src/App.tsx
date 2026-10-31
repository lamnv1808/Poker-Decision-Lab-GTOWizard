import { useEffect } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { Layout } from './components/Layout';
import { Spinner } from './components/ui';
import { AuthPage } from './pages/AuthPage';
import { CurriculumPage } from './pages/Curriculum';
import { Dashboard } from './pages/Dashboard';
import { HandDetailPage, HandsPage } from './pages/Hands';
import { LeaksPage } from './pages/Leaks';
import { MathLab } from './pages/MathLab';
import { ProgressPage } from './pages/Progress';
import { RunPage } from './pages/RunPage';
import { ScenarioList } from './pages/ScenarioList';
import { SettingsPage } from './pages/Settings';
import { Train } from './pages/Train';
import { useApp } from './store';

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { me, loaded } = useApp();
  const location = useLocation();
  if (!loaded) return <div className="flex h-full items-center justify-center"><Spinner /></div>;
  if (!me) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return <>{children}</>;
}

export function App() {
  const { load, lang } = useApp();
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);
  return (
    <Routes>
      <Route path="/login" element={<AuthPage />} />
      <Route element={<RequireAuth><Layout /></RequireAuth>}>
        <Route index element={<Dashboard />} />
        <Route path="train" element={<Train />} />
        <Route path="hero" element={<ScenarioList mode="hero" />} />
        <Route path="villain" element={<ScenarioList mode="villain" />} />
        <Route path="run/:id" element={<RunPage />} />
        <Route path="math" element={<MathLab />} />
        <Route path="hands" element={<HandsPage />} />
        <Route path="hands/:id" element={<HandDetailPage />} />
        <Route path="leaks" element={<LeaksPage />} />
        <Route path="progress" element={<ProgressPage />} />
        <Route path="curriculum" element={<CurriculumPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
