import { ReactNode, useEffect, useRef, useState } from 'react';
import { BackupTask, EngineError, Progress, REPO_DIR, RunSummary, slugify } from '../engine/types';
import { runBackup } from '../engine/backup';
import { ensurePermission, getDirByPath } from '../engine/fsx';
import { downloadBlob, opfsRepoContainer, supportsFsAccess } from '../engine/caps';
import { tarDirectory } from '../engine/tar';
import { Lang, makeT } from '../i18n';

interface Props {
  task: BackupTask;
  lang: Lang;
  onChange: (task: BackupTask) => Promise<void>;
  onDelete: () => void;
}

interface SourceFile {
  path: string;
  file: File;
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

function formatDuration(ms: number, lang: Lang): string {
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${(ms / 1000).toFixed(1)}s`;
  return lang === 'de' ? `${minutes}m ${seconds}s` : `${minutes}m ${seconds}s`;
}

const FolderIcon = (
  <svg className="h-12 w-12 text-primary-400" fill="currentColor" viewBox="0 0 24 24">
    <path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z" />
  </svg>
);

const DriveIcon = (
  <svg className="h-12 w-12 text-primary-400" fill="currentColor" viewBox="0 0 24 24">
    <path d="M4 5c0-1.1.9-2 2-2h12a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5zm2 0v9h12V5H6zm6 12.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z" />
  </svg>
);

const ArchiveIcon = (
  <svg className="h-12 w-12 text-primary-400" fill="currentColor" viewBox="0 0 24 24">
    <path d="M20.54 5.23 19.15 3.55A1.99 1.99 0 0 0 17.6 3H6.4c-.62 0-1.17.28-1.55.55L3.46 5.23C3.17 5.57 3 6.02 3 6.5V19a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6.5c0-.48-.17-.93-.46-1.27zM6.24 5h11.52l.81.97H5.44l.8-.97zM5 19V8h14v11H5zm8.45-9h-2.9v3H8l4 4 4-4h-2.55v-3z" />
  </svg>
);

const ScheduleIcon = (
  <svg className="h-12 w-12 text-slate-500" fill="currentColor" viewBox="0 0 24 24">
    <path d="M12 4a8 8 0 1 0 8 8h-2a6 6 0 1 1-6-6V4zm2-1.74V4.3A8.02 8.02 0 0 1 19.7 10h2.04A10.02 10.02 0 0 0 14 2.26zM11 8v5l4.25 2.52.75-1.23-3.5-2.04V8h-1.5z" />
  </svg>
);

function Card({
  label,
  icon,
  title,
  hint,
  onClick,
  disabled,
}: {
  label: string;
  icon: ReactNode;
  title: string;
  hint: string;
  onClick?: () => void;
  disabled?: boolean;
}) {
  const inner = (
    <>
      <div className="mb-3 text-xs uppercase tracking-widest text-slate-500">{label}</div>
      <div className="flex flex-col items-center gap-3 py-4">
        {icon}
        <div className="max-w-full truncate text-base font-semibold text-slate-100">{title}</div>
        <div className={`text-center text-xs ${onClick ? 'text-primary-400' : 'text-slate-500'}`}>
          {hint}
        </div>
      </div>
    </>
  );
  if (!onClick) {
    return <div className="card w-full p-5">{inner}</div>;
  }
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="card block w-full p-5 text-left transition-colors hover:border-primary-500/60"
    >
      {inner}
    </button>
  );
}

export default function TaskView({ task, lang, onChange, onDelete }: Props) {
  const t = makeT(lang);
  const [passphrase, setPassphrase] = useState('');
  const [sourceFiles, setSourceFiles] = useState<SourceFile[] | null>(null);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [banner, setBanner] = useState<{ ok: boolean; summary?: RunSummary; note?: string; message?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const lastPaint = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);

  const pick = async (which: 'source' | 'dest') => {
    if (!supportsFsAccess && which === 'source') {
      fileInput.current?.click();
      return;
    }
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

  const onFilesPicked = (list: FileList | null) => {
    if (!list || list.length === 0) return;
    setSourceFiles(
      Array.from(list).map((file) => ({
        path: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name,
        file,
      }))
    );
  };

  const run = async () => {
    if (running) return;
    setError(null);
    setBanner(null);
    if (supportsFsAccess && (!task.source || !task.dest)) {
      setError(t('errPickBoth'));
      return;
    }
    if (!supportsFsAccess && (!sourceFiles || sourceFiles.length === 0)) {
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
      let dest: FileSystemDirectoryHandle;
      let source: FileSystemDirectoryHandle | SourceFile[];
      if (supportsFsAccess) {
        await ensurePermission(task.source!, 'read');
        await ensurePermission(task.dest!, 'readwrite');
        source = task.source!;
        dest = task.dest!;
      } else {
        source = sourceFiles!;
        dest = await opfsRepoContainer(task.id);
      }
      const summary = await runBackup({
        source,
        dest,
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
      let note: string | undefined;
      if (!supportsFsAccess) {
        const repoRoot = await getDirByPath(dest, [REPO_DIR, slugify(task.name)], false);
        const archive = await tarDirectory(repoRoot);
        const stamp = new Date().toISOString().slice(0, 10);
        downloadBlob(archive, `allbacked-${slugify(task.name)}-${stamp}.tar`);
        note = `${t('exportedTar')} (${formatBytes(archive.size)})`;
      }
      setBanner({ ok: true, summary, note });
      await onChange({ ...task, lastRun: summary });
    } catch (err) {
      let message: string;
      if (err instanceof EngineError && err.code === 'passphrase-required') {
        message = t('errPassphraseRequired');
      } else if (err instanceof EngineError && err.code === 'passphrase-wrong') {
        message = t('errPassphraseWrong');
      } else {
        message = `${t('errGeneric')} ${err instanceof Error ? err.message : String(err)}`;
      }
      setBanner({ ok: false, message });
    } finally {
      setRunning(false);
      setProgress(null);
    }
  };

  // triggered by the function key bar (F5 backup / F8 delete) and Start button
  const runRef = useRef(run);
  runRef.current = run;
  const deleteRef = useRef(() => {});
  deleteRef.current = () => {
    if (confirmingDelete) {
      onDelete();
    } else {
      setConfirmingDelete(true);
      setTimeout(() => setConfirmingDelete(false), 3000);
    }
  };
  useEffect(() => {
    const onRun = () => void runRef.current();
    const onDel = () => deleteRef.current();
    window.addEventListener('ab:run', onRun);
    window.addEventListener('ab:delete', onDel);
    return () => {
      window.removeEventListener('ab:run', onRun);
      window.removeEventListener('ab:delete', onDel);
    };
  }, []);

  const phaseLabel: Record<Progress['phase'], string> = {
    scan: t('phaseBackup'),
    backup: t('phaseBackup'),
    manifest: t('phaseManifest'),
    verify: t('phaseVerify'),
    restore: t('phaseRestore'),
    done: t('done'),
  };

  const sourceTitle = supportsFsAccess
    ? task.source?.name ?? '—'
    : sourceFiles
      ? `${sourceFiles.length} ${t('filesSelected')}`
      : '—';

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div className="flex items-center justify-between gap-4">
        <input
          className="input max-w-md text-lg font-bold"
          value={task.name}
          aria-label={t('taskName')}
          onChange={(e) => onChange({ ...task, name: e.target.value })}
        />
        <button
          onClick={() => deleteRef.current()}
          className={`btn-ghost ${confirmingDelete ? 'border-red-500/60 text-red-300' : 'text-red-400 hover:text-red-300'}`}
        >
          {confirmingDelete ? t('confirmDelete') : t('deleteTask')}
        </button>
      </div>

      {/* CCC-style result banner */}
      {banner && (
        <div
          className={`card flex items-start gap-4 p-5 ${banner.ok ? 'border-emerald-500/50' : 'border-red-500/50'}`}
          role={banner.ok ? 'status' : 'alert'}
        >
          <span
            className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${
              banner.ok ? 'bg-emerald-500' : 'bg-red-500'
            }`}
          >
            <svg className="h-5 w-5 text-slate-950" fill="none" stroke="currentColor" strokeWidth={3} viewBox="0 0 24 24">
              {banner.ok ? (
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              ) : (
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              )}
            </svg>
          </span>
          <div className="min-w-0 flex-1 text-sm">
            <div className="mb-2 text-base font-bold text-slate-100">
              {banner.ok ? t('successTitle') : t('failTitle')}
            </div>
            {banner.ok && banner.summary && (
              <dl className="space-y-1 text-slate-300">
                <div>
                  <dt className="inline font-semibold">{t('completedOn')}: </dt>
                  <dd className="inline">{new Date(banner.summary.finishedAt).toLocaleString(lang)}</dd>
                </div>
                <div>
                  <dt className="inline font-semibold">{t('timeElapsed')}: </dt>
                  <dd className="inline">{formatDuration(banner.summary.durationMs, lang)}</dd>
                </div>
                <div>
                  <dt className="inline font-semibold">{t('filesCopied')}: </dt>
                  <dd className="inline">
                    {banner.summary.fileCount.toLocaleString(lang)} ({formatBytes(banner.summary.totalBytes)})
                  </dd>
                </div>
                <div>
                  <dt className="inline font-semibold">{t('blocks')}: </dt>
                  <dd className="inline">
                    {banner.summary.newBlocks} {t('newBlocks')} · {banner.summary.dedupBlocks} {t('dedup')} ·{' '}
                    <span className="text-emerald-400">{t('verified')}</span>
                  </dd>
                </div>
                {banner.note && <div className="text-emerald-300">{banner.note}</div>}
              </dl>
            )}
            {!banner.ok && <p className="text-red-300">{banner.message}</p>}
          </div>
          <button onClick={() => setBanner(null)} className="btn-ghost shrink-0 px-4 py-1">
            {t('ok')}
          </button>
        </div>
      )}

      {/* SOURCE / DESTINATION / AUTOMATION, CCC style */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Card
          label={t('source')}
          icon={FolderIcon}
          title={sourceTitle}
          hint={t('pickSource')}
          onClick={() => void pick('source')}
          disabled={running}
        />
        {supportsFsAccess ? (
          <Card
            label={t('destination')}
            icon={DriveIcon}
            title={task.dest?.name ?? '—'}
            hint={t('pickDest')}
            onClick={() => void pick('dest')}
            disabled={running}
          />
        ) : (
          <Card label={t('destination')} icon={ArchiveIcon} title=".tar" hint={t('fallbackDest')} />
        )}
        <Card
          label={t('automation')}
          icon={ScheduleIcon}
          title={t('noSchedule')}
          hint={t('scheduleProTeaser')}
        />
      </div>

      {!supportsFsAccess && (
        <p className="text-xs text-slate-500">{t('uploadNote')}</p>
      )}

      <input
        ref={fileInput}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => onFilesPicked(e.target.files)}
        {...({ webkitdirectory: '' } as Record<string, string>)}
      />

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

      {error && (
        <div className="card border-red-500/50 p-4 text-sm text-red-300" role="alert">
          {error}
        </div>
      )}

      {running && (
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

      {task.lastRun && !running && !banner && (
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
            {formatDuration(task.lastRun.durationMs, lang)}
          </div>
        </div>
      )}
    </div>
  );
}
