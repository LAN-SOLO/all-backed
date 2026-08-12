import { useRef, useState } from 'react';
import { BackupTask, EngineError, Progress } from '../engine/types';
import { runBackup } from '../engine/backup';
import { ensurePermission } from '../engine/fsx';
import { Lang, makeT } from '../i18n';

interface Props {
  task: BackupTask;
  lang: Lang;
  onChange: (task: BackupTask) => Promise<void>;
  onDelete: () => void;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

export default function TaskView({ task, lang, onChange, onDelete }: Props) {
  const t = makeT(lang);
  const [passphrase, setPassphrase] = useState('');
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const lastPaint = useRef(0);

  const pick = async (which: 'source' | 'dest') => {
    try {
      const handle = await window.showDirectoryPicker({
        id: `ab-${which}-${task.id}`,
        mode: which === 'dest' ? 'readwrite' : 'read',
      });
      await onChange({ ...task, [which]: handle });
    } catch {
      /* picker cancelled */
    }
  };

  const run = async () => {
    setError(null);
    if (!task.source || !task.dest) {
      setError(t('errPickBoth'));
      return;
    }
    if (task.encrypt && !passphrase) {
      setError(t('errPassphraseEmpty'));
      return;
    }
    setRunning(true);
    setProgress(null);
    try {
      await ensurePermission(task.source, 'read');
      await ensurePermission(task.dest, 'readwrite');
      const summary = await runBackup({
        source: task.source,
        dest: task.dest,
        taskName: task.name,
        passphrase: task.encrypt ? passphrase : undefined,
        onProgress: (p) => {
          const now = performance.now();
          if (p.phase !== 'backup' || now - lastPaint.current > 80) {
            lastPaint.current = now;
            setProgress(p);
          }
        },
      });
      await onChange({ ...task, lastRun: summary });
    } catch (err) {
      if (err instanceof EngineError && err.code === 'passphrase-required') {
        setError(t('errPassphraseRequired'));
      } else if (err instanceof EngineError && err.code === 'passphrase-wrong') {
        setError(t('errPassphraseWrong'));
      } else {
        setError(`${t('errGeneric')} ${err instanceof Error ? err.message : String(err)}`);
      }
    } finally {
      setRunning(false);
    }
  };

  const phaseLabel: Record<Progress['phase'], string> = {
    scan: t('phaseBackup'),
    backup: t('phaseBackup'),
    manifest: t('phaseManifest'),
    verify: t('phaseVerify'),
    restore: t('phaseRestore'),
    done: t('done'),
  };

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="flex items-center justify-between gap-4">
        <input
          className="input max-w-md text-lg font-bold"
          value={task.name}
          aria-label={t('taskName')}
          onChange={(e) => onChange({ ...task, name: e.target.value })}
        />
        <button onClick={onDelete} className="btn-ghost text-red-400 hover:text-red-300">
          {t('deleteTask')}
        </button>
      </div>

      {/* Source → Destination, CCC style */}
      <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-4">
        {(['source', 'dest'] as const).map((which, index) => {
          const handle = which === 'source' ? task.source : task.dest;
          return (
            <div key={which} className={index === 1 ? '' : ''} style={{ gridColumn: index === 0 ? 1 : 3 }}>
              <button
                onClick={() => pick(which)}
                disabled={running}
                className="card block w-full p-6 text-left transition-colors hover:border-primary-500/60"
              >
                <div className="mb-2 text-xs uppercase tracking-widest text-slate-500">
                  {which === 'source' ? t('source') : t('destination')}
                </div>
                <div className="truncate text-lg font-semibold text-slate-100">
                  {handle ? handle.name : '—'}
                </div>
                <div className="mt-1 text-xs text-primary-400">
                  {handle
                    ? which === 'source'
                      ? t('pickSource')
                      : t('pickDest')
                    : `${which === 'source' ? t('pickSource') : t('pickDest')} (${t('notSelected')})`}
                </div>
              </button>
            </div>
          );
        })}
        <div className="text-2xl text-primary-500" style={{ gridColumn: 2, gridRow: 1 }}>
          →
        </div>
      </div>

      {/* Encryption */}
      <div className="card space-y-3 p-5">
        <label className="flex items-start gap-3 text-sm text-slate-300">
          <input
            type="checkbox"
            checked={task.encrypt}
            disabled={running}
            onChange={(e) => onChange({ ...task, encrypt: e.target.checked })}
            className="mt-0.5 accent-primary-600"
          />
          {t('encrypt')}
        </label>
        {task.encrypt && (
          <div>
            <input
              type="password"
              className="input max-w-md"
              placeholder={t('passphrasePlaceholder')}
              aria-label={t('passphrase')}
              value={passphrase}
              disabled={running}
              onChange={(e) => setPassphrase(e.target.value)}
            />
            <p className="mt-1 text-xs text-slate-500">{t('passphraseHint')}</p>
          </div>
        )}
      </div>

      <button onClick={run} disabled={running} className="btn-primary w-full py-3 text-base">
        {running ? t('running') : t('run')}
      </button>

      {error && (
        <div className="card border-red-500/50 p-4 text-sm text-red-300" role="alert">
          {error}
        </div>
      )}

      {(progress || running) && (
        <div className="card p-5">
          <div className="mb-2 text-xs uppercase tracking-widest text-slate-500">{t('log')}</div>
          <div className="space-y-1 text-sm text-slate-300">
            <div>
              <span className="text-primary-400">$</span> {phaseLabel[progress?.phase ?? 'backup']}
              {progress?.path ? `: ${progress.path}` : '…'}
            </div>
            {progress && (
              <div className="text-xs text-slate-500">
                {progress.filesDone} {t('files')} · {formatBytes(progress.bytesDone)} ·{' '}
                {progress.newBlocks} {t('newBlocks')} · {progress.dedupBlocks} {t('dedup')}
              </div>
            )}
          </div>
        </div>
      )}

      {task.lastRun && !running && (
        <div className="card p-5">
          <div className="mb-2 text-xs uppercase tracking-widest text-slate-500">{t('lastRun')}</div>
          <div className="text-sm text-slate-300">
            {new Date(task.lastRun.finishedAt).toLocaleString(lang)} — {task.lastRun.fileCount}{' '}
            {t('files')}, {formatBytes(task.lastRun.totalBytes)}, {task.lastRun.newBlocks}{' '}
            {t('newBlocks')}, {task.lastRun.dedupBlocks} {t('dedup')} ·{' '}
            <span className={task.lastRun.verifiedOk ? 'text-emerald-400' : 'text-red-400'}>
              {task.lastRun.verifiedOk ? t('verified') : t('verifyFailed')}
            </span>
            {' · '}
            {(task.lastRun.durationMs / 1000).toFixed(1)}s
          </div>
        </div>
      )}
    </div>
  );
}
