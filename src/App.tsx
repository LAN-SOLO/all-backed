import { useEffect, useState } from 'react';
import { BackupTask } from './engine/types';
import { deleteTask, loadTasks, newTask, saveTask } from './engine/store';
import { Lang, detectLang, makeT } from './i18n';
import TaskView from './components/TaskView';
import RestoreView from './components/RestoreView';

type Selection = { kind: 'task'; id: string } | { kind: 'restore' } | { kind: 'none' };

export default function App() {
  const [lang, setLang] = useState<Lang>(detectLang);
  const [tasks, setTasks] = useState<BackupTask[]>([]);
  const [selection, setSelection] = useState<Selection>({ kind: 'none' });
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

  const addTask = async () => {
    const task = newTask(lang === 'de' ? 'Neue Aufgabe' : 'New task');
    await saveTask(task);
    setTasks((prev) => [...prev, task]);
    setSelection({ kind: 'task', id: task.id });
  };

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

  const selectedTask =
    selection.kind === 'task' ? tasks.find((task) => task.id === selection.id) ?? null : null;

  return (
    <div className="flex h-screen font-mono">
      {/* Sidebar */}
      <aside className="flex w-72 shrink-0 flex-col border-r border-slate-700/60 bg-slate-950/60">
        <div className="border-b border-slate-700/60 p-4">
          <div className="text-2xl font-bold tracking-tight text-primary-400">all backed.</div>
          <div className="mt-1 text-xs text-slate-500">{t('tagline')}</div>
        </div>
        <div className="flex-1 overflow-y-auto p-3">
          <div className="mb-2 text-xs uppercase tracking-widest text-slate-500">{t('tasks')}</div>
          {tasks.length === 0 && <p className="px-2 py-1 text-sm text-slate-500">{t('noTasks')}</p>}
          <ul className="space-y-1">
            {tasks.map((task) => (
              <li key={task.id}>
                <button
                  onClick={() => setSelection({ kind: 'task', id: task.id })}
                  className={`w-full rounded-lg px-3 py-2 text-left text-sm transition-colors ${
                    selection.kind === 'task' && selection.id === task.id
                      ? 'bg-primary-600 text-white'
                      : 'text-slate-300 hover:bg-slate-800'
                  }`}
                >
                  {task.name}
                  {task.lastRun && (
                    <span className="mt-0.5 block text-xs opacity-70">
                      {new Date(task.lastRun.finishedAt).toLocaleString(lang)}
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
          <button onClick={addTask} className="btn-ghost mt-3 w-full">
            {t('newTask')}
          </button>
          <button
            onClick={() => setSelection({ kind: 'restore' })}
            className={`mt-2 w-full rounded-lg px-3 py-2 text-left text-sm transition-colors ${
              selection.kind === 'restore'
                ? 'bg-primary-600 text-white'
                : 'text-slate-300 hover:bg-slate-800'
            }`}
          >
            ↻ {t('restoreNav')}
          </button>
        </div>
        <div className="border-t border-slate-700/60 p-4">
          <div className="mb-2 text-xs text-slate-500">{t('freeBadge')}</div>
          <div className="flex gap-2">
            {(['en', 'de'] as const).map((code) => (
              <button
                key={code}
                onClick={() => switchLang(code)}
                className={`rounded px-2 py-1 text-xs uppercase ${
                  lang === code ? 'bg-primary-600 text-white' : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {code}
              </button>
            ))}
          </div>
        </div>
      </aside>

      {/* Main */}
      <main className="flex-1 overflow-y-auto p-6">
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
          <div className="flex h-full items-center justify-center text-slate-500">
            <p>{t('noTasks')}</p>
          </div>
        )}
      </main>
    </div>
  );
}
