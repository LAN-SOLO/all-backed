import { ReactNode, useEffect, useRef, useState } from 'react';
import { BackupTask, EngineError, Progress, REPO_DIR, RunSummary, slugify } from '../engine/types';
import { SourceDir, runBackup } from '../engine/backup';
import { ensurePermission, getDirByPath, walkFiles } from '../engine/fsx';
import { downloadBlob, opfsRepoContainer, supportsFsAccess } from '../engine/caps';
import { tarDirectory } from '../engine/tar';
import { Lang, makeT } from '../i18n';

interface Props {
  task: BackupTask;
  lang: Lang;
  onChange: (task: BackupTask) => Promise<void>;
  onDelete: () => void;
}

interface FallbackSource {
  name: string;
  files: { path: string; file: File }[];
}

interface FolderStats {
  files: number;
  bytes: number;
}

export function formatBytes(bytes: number): string {
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

function formatDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${(ms / 1000).toFixed(1)}s`;
  return `${minutes}m ${seconds}s`;
}

// --- drag & drop folder traversal (works without the File System Access API) ---

function entryFile(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

async function readAllEntries(dir: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> {
  const reader = dir.createReader();
  const all: FileSystemEntry[] = [];
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) =>
      reader.readEntries(resolve, reject)
    );
    if (batch.length === 0) return all;
    all.push(...batch);
  }
}

async function collectEntryFiles(
  entry: FileSystemEntry,
  prefix: string,
  out: { path: string; file: File }[]
): Promise<void> {
  if (entry.isFile) {
    out.push({ path: prefix, file: await entryFile(entry as FileSystemFileEntry) });
  } else if (entry.isDirectory) {
    for (const child of await readAllEntries(entry as FileSystemDirectoryEntry)) {
      await collectEntryFiles(child, `${prefix}/${child.name}`, out);
    }
  }
}

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
  const [fallbackSources, setFallbackSources] = useState<FallbackSource[]>([]);
  const [handleStats, setHandleStats] = useState<Record<string, FolderStats>>({});
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [banner, setBanner] = useState<{ ok: boolean; summary?: RunSummary; note?: string; message?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const lastPaint = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);

  // folder stats for picked directory handles (async walk, cached per name+index)
  useEffect(() => {
    if (!supportsFsAccess) return;
    let cancelled = false;
    (async () => {
      for (const [index, handle] of task.sources.entries()) {
        const key = `${index}:${handle.name}`;
        if (handleStats[key]) continue;
        let files = 0;
        let bytes = 0;
        try {
          for await (const item of walkFiles(handle)) {
            files += 1;
            bytes += (await item.handle.getFile()).size;
          }
        } catch {
          /* permission not granted yet — stats stay unknown */
          continue;
        }
        if (cancelled) return;
        setHandleStats((prev) => ({ ...prev, [key]: { files, bytes } }));
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task.sources]);

  const addSource = async () => {
    if (!supportsFsAccess) {
      fileInput.current?.click();
      return;
    }
    try {
      const handle = await window.showDirectoryPicker({ id: `ab-source-${task.id}`, mode: 'read' });
      await onChange({ ...task, sources: [...task.sources, handle] });
    } catch {
      /* picker cancelled */
    }
  };

  // combined source list: persisted directory handles first, then session
  // sources (webkitdirectory picks and drag & drop on non-Chromium browsers)
  const removeSource = async (index: number) => {
    if (index < task.sources.length) {
      await onChange({ ...task, sources: task.sources.filter((_, i) => i !== index) });
    } else {
      const fallbackIndex = index - task.sources.length;
      setFallbackSources((prev) => prev.filter((_, i) => i !== fallbackIndex));
    }
  };

  const onDrop = async (event: React.DragEvent) => {
    event.preventDefault();
    setIsDragOver(false);
    if (running) return;
    const items = Array.from(event.dataTransfer?.items ?? []);
    // both lookups must happen synchronously, before the first await
    const handlePromises = items.map((item) =>
      supportsFsAccess && item.getAsFileSystemHandle
        ? item.getAsFileSystemHandle()
        : Promise.resolve(null)
    );
    const entries = items.map((item) => item.webkitGetAsEntry?.() ?? null);
    const plainFiles = Array.from(event.dataTransfer?.files ?? []);
    try {
      const handles = await Promise.all(handlePromises);
      const newHandles: FileSystemDirectoryHandle[] = [];
      const newFallback: FallbackSource[] = [];
      for (let i = 0; i < items.length; i++) {
        const handle = handles[i];
        if (handle?.kind === 'directory') {
          newHandles.push(handle as FileSystemDirectoryHandle);
          continue;
        }
        const entry = entries[i];
        if (entry?.isDirectory) {
          const files: { path: string; file: File }[] = [];
          await collectEntryFiles(entry, entry.name, files);
          newFallback.push({ name: entry.name, files });
        } else if (entry?.isFile) {
          const file = await entryFile(entry as FileSystemFileEntry);
          newFallback.push({ name: file.name, files: [{ path: file.name, file }] });
        }
      }
      if (newHandles.length === 0 && newFallback.length === 0 && plainFiles.length > 0) {
        newFallback.push({
          name: plainFiles[0].name,
          files: plainFiles.map((file) => ({ path: file.name, file })),
        });
      }
      if (newHandles.length > 0) {
        await onChange({ ...task, sources: [...task.sources, ...newHandles] });
      }
      if (newFallback.length > 0) {
        setFallbackSources((prev) => [...prev, ...newFallback]);
      }
    } catch (err) {
      setError(`${t('errGeneric')} ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const pickDest = async () => {
    try {
      const handle = await window.showDirectoryPicker({
        id: `ab-dest-${task.id}`,
        mode: 'readwrite',
      });
      await onChange({ ...task, dest: handle });
    } catch {
      /* picker cancelled */
    }
  };

  const onFilesPicked = (list: FileList | null) => {
    if (!list || list.length === 0) return;
    const files = Array.from(list).map((file) => ({
      path: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name,
      file,
    }));
    const name = files[0].path.includes('/') ? files[0].path.split('/')[0] : files[0].path;
    setFallbackSources((prev) => [...prev, { name, files }]);
    if (fileInput.current) fileInput.current.value = '';
  };

  const run = async () => {
    if (running) return;
    setError(null);
    setBanner(null);
    const sources: SourceDir[] = [
      ...task.sources.map((handle): SourceDir => ({ kind: 'handle', handle })),
      ...fallbackSources.map(
        (source): SourceDir => ({ kind: 'files', name: source.name, files: source.files })
      ),
    ];
    if (sources.length === 0) {
      setError(t('errNoSources'));
      return;
    }
    if (supportsFsAccess && !task.dest) {
      setError(t('errPickBoth'));
      return;
    }
    if (task.encrypt && !passphrase) {
      setError(t('errPassphraseEmpty'));
      return;
    }
    // archive mode stages everything in browser storage — check the quota
    // up front so large backups fail with guidance instead of an OOM error
    if (!supportsFsAccess && navigator.storage?.estimate) {
      const needed = fallbackSources.reduce(
        (sum, source) => sum + source.files.reduce((s, f) => s + f.file.size, 0),
        0
      );
      try {
        const estimate = await navigator.storage.estimate();
        const free = (estimate.quota ?? Number.POSITIVE_INFINITY) - (estimate.usage ?? 0);
        if (needed * 1.1 + 64 * 1024 * 1024 > free) {
          setBanner({
            ok: false,
            message: `${t('errQuota')} — ≈${formatBytes(needed)} ${t('errQuotaNeeded')}, ≈${formatBytes(Math.max(0, free))} ${t('errQuotaFree')}. ${t('errDirectHint')}`,
          });
          return;
        }
      } catch {
        /* estimate unsupported — proceed */
      }
    }
    setRunning(true);
    setProgress(null);
    try {
      let dest: FileSystemDirectoryHandle;
      if (supportsFsAccess) {
        for (const source of task.sources) await ensurePermission(source, 'read');
        await ensurePermission(task.dest!, 'readwrite');
        dest = task.dest!;
      } else {
        dest = await opfsRepoContainer(task.id);
      }
      const summary = await runBackup({
        sources,
        dest,
        taskName: task.name,
        passphrase: task.encrypt ? passphrase : undefined,
        onProgress: (p) => {
          const now = performance.now();
          if (p.phase !== 'backup' || now - lastPaint.current > 60) {
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
      } else if (
        err instanceof DOMException &&
        (err.name === 'QuotaExceededError' || err.name === 'UnknownError')
      ) {
        message = `${t('errQuota')}. ${t('errDirectHint')}`;
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

  // dev-only E2E bridge: inject sources without the native folder dialog
  useEffect(() => {
    if (!import.meta.env.DEV || supportsFsAccess) return;
    const onAdd = (event: Event) => {
      const detail = (event as CustomEvent<FallbackSource>).detail;
      if (detail?.name && Array.isArray(detail.files)) {
        setFallbackSources((prev) => [...prev, detail]);
      }
    };
    window.addEventListener('ab:test:add-source', onAdd);
    return () => window.removeEventListener('ab:test:add-source', onAdd);
  }, []);

  const phaseLabel: Record<Progress['phase'], string> = {
    scan: t('scanPhase'),
    backup: t('phaseBackup'),
    manifest: t('phaseManifest'),
    verify: t('phaseVerify'),
    restore: t('phaseRestore'),
    done: t('done'),
  };

  const sourceRows: { name: string; stats: FolderStats | null }[] = [
    ...task.sources.map((handle, index) => ({
      name: handle.name,
      stats: handleStats[`${index}:${handle.name}`] ?? null,
    })),
    ...fallbackSources.map((source) => ({
      name: source.name,
      stats: {
        files: source.files.length,
        bytes: source.files.reduce((sum, f) => sum + f.file.size, 0),
      },
    })),
  ];

  const pct =
    progress && progress.totalBytes > 0
      ? Math.min(100, Math.round((progress.bytesDone / progress.totalBytes) * 100))
      : null;
  const BAR_WIDTH = 26;
  const filled = pct === null ? 0 : Math.round((pct / 100) * BAR_WIDTH);

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
          className={`card ab-rise flex items-start gap-4 p-5 ${banner.ok ? 'border-emerald-500/50' : 'border-red-500/50'}`}
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
                  <dd className="inline">{formatDuration(banner.summary.durationMs)}</dd>
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

      {/* SOURCES list / DESTINATION / AUTOMATION, CCC layout with terminal tree */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div
          className={`card p-5 transition-colors ${
            isDragOver ? 'border-primary-400 bg-primary-600/10' : ''
          }`}
          onDragOver={(e) => {
            e.preventDefault();
            setIsDragOver(true);
          }}
          onDragLeave={() => setIsDragOver(false)}
          onDrop={(e) => void onDrop(e)}
        >
          <div className="mb-3 text-xs uppercase tracking-widest text-slate-500">{t('sources')}</div>
          {sourceRows.length === 0 && (
            <div className="py-2 text-xs text-slate-500">
              <span className="text-primary-400">$</span> {t('noSources')}
            </div>
          )}
          <ul className="space-y-1 text-sm">
            {sourceRows.map((row, index) => (
              <li key={`${index}:${row.name}`} className="group flex items-baseline gap-2">
                <span className="shrink-0 text-slate-600">
                  {index === sourceRows.length - 1 ? '└─' : '├─'}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-semibold text-slate-100">{row.name}</span>
                  <span className="block text-xs text-slate-500">
                    {row.stats
                      ? `${row.stats.files} ${t('files')} · ${formatBytes(row.stats.bytes)}`
                      : t('scanningStats')}
                  </span>
                </span>
                <button
                  onClick={() => void removeSource(index)}
                  disabled={running}
                  className="shrink-0 text-xs text-slate-600 transition-colors hover:text-red-400"
                >
                  [{t('removeFolder')}]
                </button>
              </li>
            ))}
          </ul>
          <div className="mt-3 text-center text-xs text-slate-500">
            {isDragOver ? (
              <span className="text-primary-400">▼ {t('dropActive')}</span>
            ) : (
              t('dropHint')
            )}
          </div>
          <button onClick={() => void addSource()} disabled={running} className="btn-ghost mt-2 w-full text-primary-400">
            {t('addFolder')}
          </button>
        </div>

        {supportsFsAccess ? (
          <Card
            label={t('destination')}
            icon={DriveIcon}
            title={task.dest?.name ?? '—'}
            hint={t('pickDest')}
            onClick={() => void pickDest()}
            disabled={running}
          />
        ) : (
          <Card label={t('destination')} icon={ArchiveIcon} title=".tar" hint={t('destNoDirect')} />
        )}
        <Card
          label={t('automation')}
          icon={ScheduleIcon}
          title={t('noSchedule')}
          hint={t('scheduleProTeaser')}
        />
      </div>

      {!supportsFsAccess && <p className="text-xs text-slate-500">{t('uploadNote')}</p>}

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
        <div className="card ab-rise border-red-500/50 p-4 text-sm text-red-300" role="alert">
          <span className="text-primary-400">$</span> {error}
        </div>
      )}

      {/* terminal-style live log */}
      {running && (
        <div className="ab-rise ab-running overflow-hidden rounded-xl border border-slate-700/60 bg-slate-950/90">
          <div className="flex items-center gap-1.5 border-b border-slate-700/60 px-3 py-2">
            <span className="h-2.5 w-2.5 rounded-full bg-red-500/80" />
            <span className="h-2.5 w-2.5 rounded-full bg-amber-400/80" />
            <span className="h-2.5 w-2.5 rounded-full bg-emerald-500/80" />
            <span className="ml-2 truncate text-xs text-slate-500">
              allbacked — {task.name}
            </span>
          </div>
          <div className="space-y-1.5 p-4 text-sm text-slate-300">
            <div className="truncate">
              <span className="text-primary-400">$ </span>
              {phaseLabel[progress?.phase ?? 'scan']}
              {progress?.path ? `: ${progress.path}` : '…'}
              <span className="ab-cursor text-primary-400">▌</span>
            </div>
            <div className="text-primary-400">
              [{'█'.repeat(filled)}{'░'.repeat(BAR_WIDTH - filled)}]{' '}
              {pct === null ? '——%' : `${pct}%`}
            </div>
            {progress && (
              <div className="text-xs text-slate-500">
                {progress.filesDone}/{progress.totalFiles || '?'} {t('files')} ·{' '}
                {formatBytes(progress.bytesDone)}
                {progress.totalBytes > 0 ? ` / ${formatBytes(progress.totalBytes)}` : ''} ·{' '}
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
            {formatDuration(task.lastRun.durationMs)}
          </div>
        </div>
      )}
    </div>
  );
}
