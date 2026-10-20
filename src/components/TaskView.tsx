import { ReactNode, useEffect, useRef, useState } from 'react';
import { BackupTask, Progress, REPO_DIR, RunSummary } from '../engine/types';
import { claimRepoSlug } from '../engine/store';
import { SourceDir, runBackup } from '../engine/backup';
import { ensurePermission, getDirByPath, walkFiles } from '../engine/fsx';
import { downloadBlob, localDateStamp, opfsRepoContainer, supportsFsAccess } from '../engine/caps';
import { tarDirectory } from '../engine/tar';
import { Lang, StringKey, makeT } from '../i18n';
import { describeError, errorMessage, formatError } from '../errors';

interface Props {
  task: BackupTask;
  lang: Lang;
  onChange: (task: BackupTask) => Promise<void>;
  onDelete: () => void;
  /** Reports a running backup so the app can lock navigation meanwhile. */
  onBusyChange?: (busy: boolean) => void;
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
  <svg className="h-12 w-12 text-primary-400 light:text-primary-700" fill="currentColor" viewBox="0 0 24 24">
    <path d="M4 5c0-1.1.9-2 2-2h12a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5zm2 0v9h12V5H6zm6 12.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z" />
  </svg>
);

const ArchiveIcon = (
  <svg className="h-12 w-12 text-primary-400 light:text-primary-700" fill="currentColor" viewBox="0 0 24 24">
    <path d="M20.54 5.23 19.15 3.55A1.99 1.99 0 0 0 17.6 3H6.4c-.62 0-1.17.28-1.55.55L3.46 5.23C3.17 5.57 3 6.02 3 6.5V19a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6.5c0-.48-.17-.93-.46-1.27zM6.24 5h11.52l.81.97H5.44l.8-.97zM5 19V8h14v11H5zm8.45-9h-2.9v3H8l4 4 4-4h-2.55v-3z" />
  </svg>
);

const ScheduleIcon = (
  <svg className="h-12 w-12 text-slate-500 light:text-slate-600" fill="currentColor" viewBox="0 0 24 24">
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
      <div className="mb-3 text-xs uppercase tracking-widest text-slate-500 light:text-slate-600">{label}</div>
      <div className="flex flex-col items-center gap-3 py-4">
        {icon}
        <div className="max-w-full truncate text-base font-semibold text-slate-100 light:text-slate-900">{title}</div>
        <div className={`text-center text-xs ${onClick ? 'text-primary-400 light:text-primary-700' : 'text-slate-500 light:text-slate-600'}`}>
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

function SkippedList({ summary, t }: { summary: RunSummary; t: (key: StringKey) => string }) {
  if (!summary.skippedCount) return null;
  const reason = (r: string, path: string) =>
    path.endsWith('/') ? t('skippedFolder') : r === 'NotFoundError' ? t('skippedGone') : t('skippedLocked');
  return (
    <div className="mt-2 text-amber-300 light:text-amber-800" role="status">
      <div>
        {summary.skippedCount} {t('skippedFiles')}
      </div>
      <ul className="mt-1 max-h-32 space-y-0.5 overflow-y-auto text-xs">
        {(summary.skipped ?? []).map((entry, i) => (
          <li key={i} className="break-all">
            <span className="text-slate-500 light:text-slate-600">└─</span> {entry.path} — {reason(entry.reason, entry.path)}
          </li>
        ))}
        {(summary.skipped?.length ?? 0) < summary.skippedCount && <li>…</li>}
      </ul>
    </div>
  );
}

export default function TaskView({ task, lang, onChange, onDelete, onBusyChange }: Props) {
  const t = makeT(lang);
  const [passphrase, setPassphrase] = useState('');
  const [fallbackSources, setFallbackSources] = useState<FallbackSource[]>([]);
  const [handleStats, setHandleStats] = useState<Record<string, FolderStats>>({});
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [banner, setBanner] = useState<{
    ok: boolean;
    cancelled?: boolean;
    summary?: RunSummary;
    note?: string;
    message?: string;
  } | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const deleteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (deleteTimer.current) clearTimeout(deleteTimer.current);
  }, []);
  const [error, setError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const lastPaint = useRef(0);
  // on a small window the live log and the result banner can be off screen
  const logRef = useRef<HTMLDivElement>(null);
  const bannerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (running) logRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [running]);
  useEffect(() => {
    if (banner) bannerRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [banner]);
  const fileInput = useRef<HTMLInputElement>(null);

  // folder stats for picked directory handles (async walk, cached per name+index)
  useEffect(() => {
    if (!supportsFsAccess) return;
    let cancelled = false;
    (async () => {
      for (const [index, handle] of task.sources.entries()) {
        const key = `${index}:${handle.name}`;
        if (handleStats[key] && handleStats[key].files >= 0) continue;
        let files = 0;
        let bytes = 0;
        try {
          for await (const item of walkFiles(handle)) {
            files += 1;
            bytes += (await item.handle.getFile()).size;
          }
        } catch {
          // no read permission yet (e.g. after a browser restart) — it is
          // requested on the next run; show that instead of "scanning…"
          if (cancelled) return;
          setHandleStats((prev) => ({ ...prev, [key]: { files: -1, bytes: 0 } }));
          continue;
        }
        if (cancelled) return;
        setHandleStats((prev) => ({ ...prev, [key]: { files, bytes } }));
      }
    })();
    return () => {
      cancelled = true;
    };
    // re-run after a backup: the run may just have granted read access
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task.sources, task.lastRun]);

  const addSource = async () => {
    if (!supportsFsAccess) {
      fileInput.current?.click();
      return;
    }
    let handle: FileSystemDirectoryHandle;
    try {
      handle = await window.showDirectoryPicker({ id: `ab-source-${task.id}`, mode: 'read' });
    } catch {
      return; // picker cancelled
    }
    if (await isKnownSource(handle)) {
      setError(t('errDuplicateSource'));
      return;
    }
    setError(null);
    await onChange({ ...task, sources: [...task.sources, handle] });
  };

  // the same folder must not be listed twice (it would be backed up twice)
  const isKnownSource = async (handle: FileSystemDirectoryHandle, extra: FileSystemDirectoryHandle[] = []) => {
    for (const existing of [...task.sources, ...extra]) {
      if (await existing.isSameEntry(handle).catch(() => false)) return true;
    }
    return false;
  };

  // archive mode has no handles to compare: the same folder picked or
  // dropped again has the same name and the same files (path, size, date)
  const sameFallback = (a: FallbackSource, b: FallbackSource) =>
    a.name === b.name &&
    a.files.length === b.files.length &&
    a.files.every((f, i) => {
      const g = b.files[i];
      return f.path === g.path && f.file.size === g.file.size && f.file.lastModified === g.file.lastModified;
    });
  const addFallback = (added: FallbackSource[]) => {
    const fresh: FallbackSource[] = [];
    for (const source of added) {
      if ([...fallbackSources, ...fresh].some((known) => sameFallback(known, source))) setError(t('errDuplicateSource'));
      else fresh.push(source);
    }
    if (fresh.length > 0) setFallbackSources((prev) => [...prev, ...fresh]);
  };
  // the dev-only test bridge below takes the same path as a real pick
  const addFallbackRef = useRef(addFallback);
  addFallbackRef.current = addFallback;

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
          const dir = handle as FileSystemDirectoryHandle;
          if (await isKnownSource(dir, newHandles)) setError(t('errDuplicateSource'));
          else newHandles.push(dir);
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
      if (newFallback.length > 0) addFallback(newFallback);
    } catch (err) {
      setError(errorMessage(err, t));
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
    setError(null);
    addFallback([{ name, files }]);
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
    onBusyChange?.(true);
    setProgress(null);
    setCancelling(false);
    const abort = new AbortController();
    abortRef.current = abort;
    const started = performance.now();
    // pinned on the first run, so renaming keeps the repository; a slug
    // another task already uses gets a number instead of sharing its folder
    let repoSlug = task.repoSlug ?? '';
    try {
      repoSlug = await claimRepoSlug(task);
      if (repoSlug !== task.repoSlug) await onChange({ ...task, repoSlug });
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
        repoSlug,
        passphrase: task.encrypt ? passphrase : undefined,
        signal: abort.signal,
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
        const repoRoot = await getDirByPath(dest, [REPO_DIR, repoSlug], false);
        const archive = await tarDirectory(repoRoot);
        downloadBlob(archive, `allbacked-${repoSlug}-${localDateStamp()}.tar`);
        note = `${t('exportedTar')} (${formatBytes(archive.size)})`;
      }
      setBanner({ ok: true, summary, note });
      await onChange({ ...task, repoSlug, lastRun: summary });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        // cancelled by the user: no version was written, the previous
        // "Last run" stays as it was — only the repository folder is pinned
        setBanner({ ok: false, cancelled: true });
        if (repoSlug && repoSlug !== task.repoSlug) await onChange({ ...task, repoSlug }).catch(() => {});
        return;
      }
      const info = describeError(err);
      const message = formatError(info, t);
      setBanner({ ok: false, message });
      // record the failure so the sidebar status dot turns red
      const failedRun: RunSummary = {
        finishedAt: new Date().toISOString(),
        manifestName: '',
        fileCount: 0,
        totalBytes: 0,
        newBlocks: 0,
        dedupBlocks: 0,
        verifiedOk: false,
        durationMs: Math.round(performance.now() - started),
        encrypted: task.encrypt,
        error: message,
        errorInfo: info,
      };
      await onChange({ ...task, ...(repoSlug ? { repoSlug } : {}), lastRun: failedRun }).catch(() => {});
    } finally {
      abortRef.current = null;
      onBusyChange?.(false);
      setRunning(false);
      setCancelling(false);
      setProgress(null);
    }
  };

  const cancelRun = () => {
    if (!abortRef.current) return;
    setCancelling(true);
    abortRef.current.abort();
  };

  // triggered by the function key bar (F5 backup / F8 delete) and Start button
  const runRef = useRef(run);
  runRef.current = run;
  const deleteRef = useRef(() => {});
  deleteRef.current = () => {
    if (running) return; // never delete the task under a running backup
    if (confirmingDelete) {
      if (deleteTimer.current) clearTimeout(deleteTimer.current);
      onDelete();
    } else {
      setConfirmingDelete(true);
      deleteTimer.current = setTimeout(() => setConfirmingDelete(false), 3000);
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
        addFallbackRef.current([detail]);
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
          className="input min-w-0 max-w-md flex-1 text-lg font-bold"
          value={task.name}
          disabled={running}
          aria-label={t('taskName')}
          onChange={(e) => onChange({ ...task, name: e.target.value })}
        />
        <button
          onClick={() => deleteRef.current()}
          disabled={running}
          className={`btn-ghost shrink-0 whitespace-nowrap ${confirmingDelete ? 'border-red-500/60 text-red-300 light:text-red-700' : 'text-red-400 light:text-red-700 hover:text-red-300 light:hover:text-red-700'}`}
        >
          {confirmingDelete ? t('confirmDelete') : t('deleteTask')}
        </button>
      </div>

      {/* CCC-style result banner */}
      {banner && (
        <div
          ref={bannerRef}
          className={`card ab-rise flex scroll-my-6 items-start gap-4 p-5 ${
            banner.ok ? 'border-emerald-500/50' : banner.cancelled ? 'border-amber-500/50' : 'border-red-500/50'
          }`}
          role={banner.ok || banner.cancelled ? 'status' : 'alert'}
        >
          <span
            className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${
              banner.ok ? 'bg-emerald-500' : banner.cancelled ? 'bg-amber-400' : 'bg-red-500'
            }`}
          >
            <svg className="h-5 w-5 text-slate-950" fill="none" stroke="currentColor" strokeWidth={3} viewBox="0 0 24 24">
              {banner.ok ? (
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              ) : banner.cancelled ? (
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 12h12" />
              ) : (
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              )}
            </svg>
          </span>
          <div className="min-w-0 flex-1 text-sm">
            <div className="mb-2 text-base font-bold text-slate-100 light:text-slate-900">
              {banner.ok ? t('successTitle') : banner.cancelled ? t('cancelledTitle') : t('failTitle')}
            </div>
            {banner.ok && banner.summary && (
              <dl className="space-y-1 text-slate-300 light:text-slate-700">
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
                    <span className="text-emerald-400 light:text-emerald-700">{t('verified')}</span>
                  </dd>
                </div>
                {banner.note && <div className="text-emerald-300 light:text-emerald-700">{banner.note}</div>}
              </dl>
            )}
            {banner.ok && banner.summary && <SkippedList summary={banner.summary} t={t} />}
            {banner.cancelled && <p className="text-amber-300 light:text-amber-800">{t('cancelledNote')}</p>}
            {!banner.ok && !banner.cancelled && <p className="break-words text-red-300 light:text-red-700">{banner.message}</p>}
          </div>
          <button onClick={() => setBanner(null)} className="btn-ghost shrink-0 px-4 py-1">
            {t('ok')}
          </button>
        </div>
      )}

      {/* SOURCES list / DESTINATION / AUTOMATION, CCC layout with terminal tree */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
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
          <div className="mb-3 text-xs uppercase tracking-widest text-slate-500 light:text-slate-600">{t('sources')}</div>
          {sourceRows.length === 0 && (
            <div className="py-2 text-xs text-slate-500 light:text-slate-600">
              <span className="text-primary-400 light:text-primary-700">$</span> {t('noSources')}
            </div>
          )}
          <ul className="space-y-1 text-sm">
            {sourceRows.map((row, index) => (
              <li key={`${index}:${row.name}`} className="group flex items-baseline gap-2">
                <span className="shrink-0 text-slate-600 light:text-slate-500">
                  {index === sourceRows.length - 1 ? '└─' : '├─'}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-semibold text-slate-100 light:text-slate-900">{row.name}</span>
                  <span className="block text-xs text-slate-500 light:text-slate-600">
                    {row.stats
                      ? row.stats.files < 0
                        ? t('statsLocked')
                        : `${row.stats.files} ${t('files')} · ${formatBytes(row.stats.bytes)}`
                      : t('scanningStats')}
                  </span>
                </span>
                <button
                  onClick={() => void removeSource(index)}
                  disabled={running}
                  className="shrink-0 text-xs text-slate-600 light:text-slate-500 transition-colors hover:text-red-400 light:hover:text-red-700"
                >
                  [{t('removeFolder')}]
                </button>
              </li>
            ))}
          </ul>
          <div className="mt-3 text-center text-xs text-slate-500 light:text-slate-600">
            {isDragOver ? (
              <span className="text-primary-400 light:text-primary-700">▼ {t('dropActive')}</span>
            ) : (
              t('dropHint')
            )}
          </div>
          <button onClick={() => void addSource()} disabled={running} className="btn-ghost mt-2 w-full text-primary-400 light:text-primary-700">
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

      {!supportsFsAccess && <p className="text-xs text-slate-500 light:text-slate-600">{t('uploadNote')}</p>}

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
        <label className="flex items-start gap-3 text-sm text-slate-300 light:text-slate-700">
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
            <p className="mt-1 text-xs text-slate-500 light:text-slate-600">{t('passphraseHint')}</p>
          </div>
        )}
      </div>

      {error && (
        <div className="card ab-rise border-red-500/50 p-4 text-sm text-red-300 light:text-red-700" role="alert">
          <span className="text-primary-400 light:text-primary-700">$</span> {error}
        </div>
      )}

      {/* terminal-style live log */}
      {running && (
        <div ref={logRef} className="ab-rise ab-running scroll-my-6 overflow-hidden rounded-xl border border-slate-700/60 light:border-slate-300 bg-slate-950/90 light:bg-white">
          <div className="flex items-center gap-1.5 border-b border-slate-700/60 light:border-slate-300 px-3 py-2">
            <span className="h-2.5 w-2.5 rounded-full bg-red-500/80" />
            <span className="h-2.5 w-2.5 rounded-full bg-amber-400/80" />
            <span className="h-2.5 w-2.5 rounded-full bg-emerald-500/80" />
            <span className="ml-2 min-w-0 flex-1 truncate text-xs text-slate-500 light:text-slate-600">
              allbacked — {task.name}
            </span>
            <button
              onClick={cancelRun}
              disabled={cancelling}
              className="shrink-0 rounded border border-slate-600/60 light:border-slate-400/60 px-2 py-0.5 text-xs text-slate-300 light:text-slate-700 transition-colors hover:border-red-500/60 hover:text-red-300 light:hover:text-red-700 disabled:opacity-50"
            >
              {cancelling ? t('cancelling') : `[${t('cancel')}]`}
            </button>
          </div>
          <div className="space-y-1.5 p-4 text-sm text-slate-300 light:text-slate-700">
            <div className="truncate">
              <span className="text-primary-400 light:text-primary-700">$ </span>
              {phaseLabel[progress?.phase ?? 'scan']}
              {progress?.path ? `: ${progress.path}` : '…'}
              <span className="ab-cursor text-primary-400 light:text-primary-700">▌</span>
            </div>
            <div className="text-primary-400 light:text-primary-700">
              [{'█'.repeat(filled)}{'░'.repeat(BAR_WIDTH - filled)}]{' '}
              {pct === null ? '——%' : `${pct}%`}
            </div>
            {progress && (
              <div className="text-xs text-slate-500 light:text-slate-600">
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
          <div className="mb-2 text-xs uppercase tracking-widest text-slate-500 light:text-slate-600">{t('lastRun')}</div>
          {task.lastRun.error ? (
            <div className="text-sm text-slate-300 light:text-slate-700">
              {new Date(task.lastRun.finishedAt).toLocaleString(lang)} —{' '}
              <span className="text-red-400 light:text-red-700">{t('lastRunFailed')}</span>:{' '}
              <span className="break-words">
                {task.lastRun.errorInfo
                  ? formatError(task.lastRun.errorInfo as Parameters<typeof formatError>[0], t)
                  : task.lastRun.error}
              </span>
            </div>
          ) : (
          <div className="text-sm text-slate-300 light:text-slate-700">
            {new Date(task.lastRun.finishedAt).toLocaleString(lang)} — {task.lastRun.fileCount}{' '}
            {t('files')}, {formatBytes(task.lastRun.totalBytes)}, {task.lastRun.newBlocks}{' '}
            {t('newBlocks')}, {task.lastRun.dedupBlocks} {t('dedup')} ·{' '}
            <span className={task.lastRun.verifiedOk ? 'text-emerald-400 light:text-emerald-700' : 'text-red-400 light:text-red-700'}>
              {task.lastRun.verifiedOk ? t('verified') : t('verifyFailed')}
            </span>
            {' · '}
            {formatDuration(task.lastRun.durationMs)}
            <SkippedList summary={task.lastRun} t={t} />
          </div>
          )}
        </div>
      )}
    </div>
  );
}
