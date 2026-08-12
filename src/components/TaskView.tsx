import { useRef, useState } from 'react';
import { BackupTask, EngineError, Progress, REPO_DIR, slugify } from '../engine/types';
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

export default function TaskView({ task, lang, onChange, onDelete }: Props) {
  const t = makeT(lang);
  const [passphrase, setPassphrase] = useState('');
  const [sourceFiles, setSourceFiles] = useState<SourceFile[] | null>(null);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
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
    setError(null);
    setNotice(null);
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
      if (!supportsFsAccess) {
        const repoRoot = await getDirByPath(dest, [REPO_DIR, slugify(task.name)], false);
        const archive = await tarDirectory(repoRoot);
        const stamp = new Date().toISOString().slice(0, 10);
        downloadBlob(archive, `allbacked-${slugify(task.name)}-${stamp}.tar`);
        setNotice(`${t('exportedTar')} (${formatBytes(archive.size)})`);
      }
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

  const sourceLabel = supportsFsAccess
    ? task.source?.name ?? '—'
    : sourceFiles
      ? `${sourceFiles.length} ${t('filesSelected')}`
      : '—';

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

      {!supportsFsAccess && (
        <div className="card border-primary-500/40 p-4 text-xs text-slate-400">{t('fallbackHint')}</div>
      )}

      {/* Source → Destination, CCC style */}
      <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-4">
        <button
          onClick={() => pick('source')}
          disabled={running}
          className="card block w-full p-6 text-left transition-colors hover:border-primary-500/60"
        >
          <div className="mb-2 text-xs uppercase tracking-widest text-slate-500">{t('source')}</div>
          <div className="truncate text-lg font-semibold text-slate-100">{sourceLabel}</div>
          <div className="mt-1 text-xs text-primary-400">{t('pickSource')}</div>
        </button>
        <div className="text-2xl text-primary-500">→</div>
        {supportsFsAccess ? (
          <button
            onClick={() => pick('dest')}
            disabled={running}
            className="card block w-full p-6 text-left transition-colors hover:border-primary-500/60"
          >
            <div className="mb-2 text-xs uppercase tracking-widest text-slate-500">
              {t('destination')}
            </div>
            <div className="truncate text-lg font-semibold text-slate-100">
              {task.dest?.name ?? '—'}
            </div>
            <div className="mt-1 text-xs text-primary-400">{t('pickDest')}</div>
          </button>
        ) : (
          <div className="card block w-full p-6 text-left">
            <div className="mb-2 text-xs uppercase tracking-widest text-slate-500">
              {t('destination')}
            </div>
            <div className="truncate text-lg font-semibold text-slate-100">.tar</div>
            <div className="mt-1 text-xs text-slate-400">{t('fallbackDest')}</div>
          </div>
        )}
      </div>

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

      <button onClick={run} disabled={running} className="btn-primary w-full py-3 text-base">
        {running ? t('running') : t('run')}
      </button>

      {error && (
        <div className="card border-red-500/50 p-4 text-sm text-red-300" role="alert">
          {error}
        </div>
      )}
      {notice && (
        <div className="card border-emerald-500/50 p-4 text-sm text-emerald-300">{notice}</div>
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
