import { useCallback, useEffect, useState } from 'react';
import { BackupTask } from './engine/types';
import { deleteTask, loadTasks, newTask, saveTask } from './engine/store';
import { Lang, StringKey, detectLang, makeT } from './i18n';
import { supportsFsAccess } from './engine/caps';
import TaskView from './components/TaskView';
import RestoreView from './components/RestoreView';
import Help from './components/Help';
import { Theme, detectTheme, saveTheme } from './theme';

type Selection = { kind: 'task'; id: string } | { kind: 'restore' } | { kind: 'none' };

function TaskStatusIcon({ task }: { task: BackupTask }) {
  if (!task.lastRun) {
    return <span className="mt-1 h-3 w-3 shrink-0 rounded-full border-2 border-slate-500 light:border-slate-400" />;
  }
  const ok = task.lastRun.verifiedOk;
  return (
    <span
      className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full ${
        ok ? 'bg-emerald-500' : 'bg-red-500'
      }`}
    >
      <svg className="h-3 w-3 text-slate-950" fill="none" stroke="currentColor" strokeWidth={3} viewBox="0 0 24 24">
        {ok ? (
          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
        ) : (
          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
        )}
      </svg>
    </span>
  );
}

export default function App() {
  const [lang, setLang] = useState<Lang>(detectLang);
  const [tasks, setTasks] = useState<BackupTask[]>([]);
  const [selection, setSelection] = useState<Selection>({ kind: 'none' });
  const [helpOpen, setHelpOpen] = useState(false);
  const [theme, setTheme] = useState<Theme>(detectTheme);
  const t = makeT(lang);

  useEffect(() => {
    loadTasks().then((loaded) => {
      setTasks(loaded);
      if (loaded.length > 0) setSelection({ kind: 'task', id: loaded[0].id });
    });
  }, []);

  const switchLang = (next: Lang) => {
    localStorage.setItem('ab-lang', next);
    setLang(next);
  };

  const toggleTheme = () => {
    const next: Theme = theme === 'dark' ? 'light' : 'dark';
    saveTheme(next);
    setTheme(next);
  };

  const addTask = useCallback(async () => {
    const task = newTask(lang === 'de' ? 'Neue Aufgabe' : 'New task');
    await saveTask(task);
    setTasks((prev) => [...prev, task]);
    setSelection({ kind: 'task', id: task.id });
  }, [lang]);

  const updateTask = async (task: BackupTask) => {
    await saveTask(task);
    setTasks((prev) => prev.map((existing) => (existing.id === task.id ? task : existing)));
  };

  const removeTask = async (id: string) => {
    await deleteTask(id);
    setTasks((prev) => {
      const remaining = prev.filter((task) => task.id !== id);
      setSelection(remaining.length > 0 ? { kind: 'task', id: remaining[0].id } : { kind: 'none' });
      return remaining;
    });
  };

  // Norton-Commander-style function keys; TaskView listens for the events.
  // While the help overlay is open it owns the keyboard (Esc, F1, arrows).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (helpOpen) return;
      const actions: Record<string, () => void> = {
        F1: () => window.dispatchEvent(new CustomEvent('ab:help')),
        F2: () => void addTask(),
        F5: () => window.dispatchEvent(new CustomEvent('ab:run')),
        F6: () => setSelection({ kind: 'restore' }),
        F8: () => window.dispatchEvent(new CustomEvent('ab:delete')),
      };
      const action = actions[event.key];
      if (action) {
        event.preventDefault();
        action();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [addTask, helpOpen]);

  const selectedTask =
    selection.kind === 'task' ? tasks.find((task) => task.id === selection.id) ?? null : null;

  const taskSubtitle = (task: BackupTask): string => {
    const first = task.sources[0]?.name;
    const src = !supportsFsAccess
      ? '…'
      : first
        ? task.sources.length > 1
          ? `${first} +${task.sources.length - 1}`
          : first
        : '—';
    const dst = supportsFsAccess ? task.dest?.name ?? '—' : '.tar';
    return task.sources.length > 0 || task.dest || !supportsFsAccess
      ? `${t('manual')}: ${src} → ${dst}`
      : t('neverRun');
  };

  const fkeys: { key: string; label: StringKey; onClick: () => void }[] = [
    { key: 'F1', label: 'fHelp', onClick: () => window.dispatchEvent(new CustomEvent('ab:help')) },
    { key: 'F2', label: 'fNew', onClick: () => void addTask() },
    { key: 'F5', label: 'fBackup', onClick: () => window.dispatchEvent(new CustomEvent('ab:run')) },
    { key: 'F6', label: 'fRestore', onClick: () => setSelection({ kind: 'restore' }) },
    { key: 'F8', label: 'fDelete', onClick: () => window.dispatchEvent(new CustomEvent('ab:delete')) },
  ];

  return (
    <div className="flex h-screen font-mono">
      {/* Sidebar */}
      <aside className="flex w-80 shrink-0 flex-col border-r border-slate-700/60 light:border-slate-300 bg-slate-950/60 light:bg-white/70">
        <div className="border-b border-slate-700/60 light:border-slate-300 p-4">
          <div className="text-2xl font-bold tracking-tight">
            <span className="text-primary-400 light:text-primary-700">all/backed</span>
            <span className="text-slate-100 light:text-slate-900">.</span>
          </div>
          <div className="mt-1 text-xs text-slate-500 light:text-slate-600">{t('tagline')}</div>
        </div>
        <div className="flex-1 overflow-y-auto p-3">
          <div className="mb-2 text-xs uppercase tracking-widest text-slate-500 light:text-slate-600">{t('tasks')}</div>
          {tasks.length === 0 && <p className="px-2 py-1 text-sm text-slate-500 light:text-slate-600">{t('noTasks')}</p>}
          <ul className="space-y-1">
            {tasks.map((task) => (
              <li key={task.id}>
                <button
                  onClick={() => setSelection({ kind: 'task', id: task.id })}
                  className={`flex w-full items-start gap-2.5 rounded-lg px-3 py-2 text-left text-sm transition-colors ${
                    selection.kind === 'task' && selection.id === task.id
                      ? 'bg-primary-600 text-white'
                      : 'text-slate-300 light:text-slate-700 hover:bg-slate-800 light:hover:bg-slate-200'
                  }`}
                >
                  <TaskStatusIcon task={task} />
                  <span className="min-w-0">
                    <span className="block truncate font-semibold">{task.name}</span>
                    <span className="block truncate text-xs opacity-70">{taskSubtitle(task)}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <button onClick={() => void addTask()} className="btn-ghost mt-3 w-full">
            {t('newTask')}
          </button>
          <button
            onClick={() => setSelection({ kind: 'restore' })}
            className={`mt-2 w-full rounded-lg px-3 py-2 text-left text-sm transition-colors ${
              selection.kind === 'restore'
                ? 'bg-primary-600 text-white'
                : 'text-slate-300 light:text-slate-700 hover:bg-slate-800 light:hover:bg-slate-200'
            }`}
          >
            ↻ {t('restoreNav')}
          </button>
        </div>
        <div className="border-t border-slate-700/60 light:border-slate-300 p-4">
          <div className="mb-2 text-xs text-slate-500 light:text-slate-600">{t('freeBadge')}</div>
          {!supportsFsAccess && (
            <div className="mb-2 text-xs text-amber-400/80 light:text-amber-800">{t('fallbackBadge')}</div>
          )}
          <div className="flex items-center gap-2">
            {(['en', 'de'] as const).map((code) => (
              <button
                key={code}
                onClick={() => switchLang(code)}
                className={`rounded px-2 py-1 text-xs uppercase ${
                  lang === code ? 'bg-primary-600 text-white' : 'text-slate-400 light:text-slate-600 hover:text-slate-200 light:hover:text-slate-900'
                }`}
              >
                {code}
              </button>
            ))}
            <div className="flex-1" />
            <button
              onClick={toggleTheme}
              title={t(theme === 'dark' ? 'themeToLight' : 'themeToDark')}
              aria-label={t(theme === 'dark' ? 'themeToLight' : 'themeToDark')}
              className="rounded border border-slate-600/60 light:border-slate-400/60 px-2 py-1 text-xs text-slate-400 light:text-slate-600 transition-colors hover:bg-slate-700/60 light:hover:bg-slate-300/60 hover:text-slate-200 light:hover:text-slate-900"
            >
              {theme === 'dark' ? (
                // sun: switch to light
                <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24" aria-hidden="true">
                  <circle cx="12" cy="12" r="4" />
                  <path strokeLinecap="round" d="M12 2v2m0 16v2M4.93 4.93l1.41 1.41m11.32 11.32 1.41 1.41M2 12h2m16 0h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
                </svg>
              ) : (
                // moon: switch to dark
                <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24" aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
                </svg>
              )}
            </button>
            <button
              onClick={() => window.dispatchEvent(new CustomEvent('ab:help'))}
              title={t('helpTitle')}
              className="rounded border border-slate-600/60 light:border-slate-400/60 px-2 py-1 text-xs text-slate-400 light:text-slate-600 transition-colors hover:bg-slate-700/60 light:hover:bg-slate-300/60 hover:text-slate-200 light:hover:text-slate-900"
            >
              ?
            </button>
          </div>
        </div>
      </aside>

      {/* Main */}
      <main className="flex min-w-0 flex-1 flex-col">
        <div className="flex-1 overflow-y-auto p-6">
          {selectedTask && (
            <TaskView
              key={selectedTask.id}
              task={selectedTask}
              lang={lang}
              onChange={updateTask}
              onDelete={() => removeTask(selectedTask.id)}
            />
          )}
          {selection.kind === 'restore' && <RestoreView lang={lang} />}
          {selection.kind === 'none' && (
            <div className="flex h-full items-center justify-center text-slate-500 light:text-slate-600">
              <p>{t('noTasks')}</p>
            </div>
          )}
        </div>

        {/* Norton-Commander-style function key bar */}
        <footer className="flex items-center gap-1 border-t border-slate-700/60 light:border-slate-300 bg-slate-950/80 light:bg-white/80 px-3 py-2">
          {fkeys.map(({ key, label, onClick }) => (
            <button
              key={key}
              onClick={onClick}
              className="group flex items-center gap-1.5 rounded px-2 py-1 text-xs text-slate-400 light:text-slate-600 transition-colors hover:bg-slate-800 light:hover:bg-slate-200 hover:text-slate-200 light:hover:text-slate-900"
            >
              <span className="rounded-sm bg-primary-600/90 px-1.5 py-0.5 font-bold text-white group-hover:bg-primary-600">
                {key}
              </span>
              {t(label)}
            </button>
          ))}
          <div className="flex-1" />
          {selectedTask && (
            <button
              onClick={() => window.dispatchEvent(new CustomEvent('ab:run'))}
              className="btn-primary px-8 py-1.5"
            >
              {t('start')}
            </button>
          )}
        </footer>
      </main>

      <Help lang={lang} onOpenChange={setHelpOpen} />
    </div>
  );
}
