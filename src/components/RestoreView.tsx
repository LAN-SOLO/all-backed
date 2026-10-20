import { useEffect, useRef, useState } from 'react';
import { EngineError, Progress } from '../engine/types';
import { OpenRepo, findRepos, listManifests, openRepo, readManifest } from '../engine/repo';
import { RestoreFailure, RestoreRename, inspectRestoreTarget, runRestore } from '../engine/restore';
import { downloadBlob, localDateStamp, opfsScratch, supportsFsAccess, withScratchLock } from '../engine/caps';
import { tarDirectory, untarToDirectory } from '../engine/tar';
import { Lang, makeT } from '../i18n';
import { errorMessage } from '../errors';

interface Props {
  lang: Lang;
  /** Reports a running import/restore so the app can lock navigation. */
  onBusyChange?: (busy: boolean) => void;
}

interface RepoEntry {
  name: string;
  handle: FileSystemDirectoryHandle;
}

export default function RestoreView({ lang, onBusyChange }: Props) {
  const t = makeT(lang);
  const [repos, setRepos] = useState<RepoEntry[] | null>(null);
  const [selected, setSelected] = useState<RepoEntry | null>(null);
  const [open, setOpen] = useState<OpenRepo | null>(null);
  const [needPass, setNeedPass] = useState(false);
  const [passphrase, setPassphrase] = useState('');
  const [manifests, setManifests] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [doneMsg, setDoneMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [failures, setFailures] = useState<RestoreFailure[]>([]);
  const [renamed, setRenamed] = useState<RestoreRename[]>([]);
  const [cancelledMsg, setCancelledMsg] = useState<string | null>(null);
  // a non-empty target folder: same-named files would be overwritten, so
  // the restore waits for an explicit confirmation
  const [pending, setPending] = useState<{
    manifestName: string;
    target: FileSystemDirectoryHandle;
    existing: string[];
  } | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [taskKind, setTaskKind] = useState<'import' | 'restore'>('restore');
  const tarInput = useRef<HTMLInputElement>(null);
  // the confirmation and results appear below the version list — scroll
  // them into view, on a small window they would be off screen
  const pendingRef = useRef<HTMLDivElement>(null);
  const resultRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (pending) pendingRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [pending]);
  useEffect(() => {
    if (doneMsg || error || cancelledMsg) resultRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [doneMsg, error, cancelledMsg]);

  useEffect(() => {
    onBusyChange?.(running);
  }, [running, onBusyChange]);

  const reset = () => {
    setSelected(null);
    setOpen(null);
    setNeedPass(false);
    setPassphrase('');
    setManifests([]);
    setProgress(null);
    setDoneMsg(null);
    setError(null);
    setFailures([]);
    setRenamed([]);
    setCancelledMsg(null);
    setPending(null);
  };

  const startTask = (kind: 'import' | 'restore') => {
    setTaskKind(kind);
    const abort = new AbortController();
    abortRef.current = abort;
    setCancelling(false);
    setRunning(true);
    return abort.signal;
  };

  const endTask = () => {
    abortRef.current = null;
    setCancelling(false);
    setRunning(false);
    setProgress(null);
  };

  const cancel = () => {
    if (!abortRef.current) return;
    setCancelling(true);
    abortRef.current.abort();
  };

  const isAbort = (err: unknown) => err instanceof DOMException && err.name === 'AbortError';

  const scanDir = async (dir: FileSystemDirectoryHandle) => {
    reset();
    try {
      const found = await findRepos(dir);
      setRepos(found);
      if (found.length === 1) await selectRepo(found[0]);
    } catch (err) {
      setRepos(null);
      setError(errorMessage(err, t));
    }
  };

  const pickRepoDir = async () => {
    if (!supportsFsAccess) {
      tarInput.current?.click();
      return;
    }
    let dir: FileSystemDirectoryHandle;
    try {
      dir = await window.showDirectoryPicker({ id: 'ab-restore-repo', mode: 'read' });
    } catch {
      return; // picker cancelled
    }
    await scanDir(dir);
  };

  const importTar = async (archive: Blob) => {
    if (running) return;
    const signal = startTask('import');
    try {
      const scratch = await withScratchLock(async () => {
        const dir = await opfsScratch('restore-import');
        await untarToDirectory(archive, dir, signal);
        return dir;
      });
      await scanDir(scratch);
    } catch (err) {
      reset();
      setRepos(null);
      if (!isAbort(err)) setError(errorMessage(err, t));
    } finally {
      endTask();
      if (tarInput.current) tarInput.current.value = '';
    }
  };

  const onTarPicked = async (list: FileList | null) => {
    if (!list || list.length === 0) return;
    await importTar(list[0]);
  };

  // dev-only E2E bridge: feed a backup archive without the native file dialog
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const onTar = (event: Event) => {
      const detail = (event as CustomEvent<{ file: Blob }>).detail;
      if (detail?.file) void importTar(detail.file);
    };
    window.addEventListener('ab:test:restore-tar', onTar);
    return () => window.removeEventListener('ab:test:restore-tar', onTar);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectRepo = async (repo: RepoEntry, pass?: string) => {
    setSelected(repo);
    setError(null);
    setDoneMsg(null);
    try {
      const opened = await openRepo(repo.handle, pass);
      const names = await listManifests(opened);
      if (names.length > 0 && names[0].endsWith('.enc')) {
        // validate the passphrase early by decrypting the newest manifest
        await readManifest(opened, names[0]);
      }
      setOpen(opened);
      setManifests(names);
      setNeedPass(false);
    } catch (err) {
      if (err instanceof EngineError && err.code === 'passphrase-required') {
        setNeedPass(true);
        setOpen(null);
      } else if (err instanceof EngineError && err.code === 'passphrase-wrong') {
        setNeedPass(true);
        setOpen(null);
        setError(t('errPassphraseWrong'));
      } else {
        setError(errorMessage(err, t));
      }
    }
  };

  const clearResult = () => {
    setError(null);
    setDoneMsg(null);
    setFailures([]);
    setRenamed([]);
    setCancelledMsg(null);
    setPending(null);
  };

  /** "Restore this version": pick the target, check it, then restore. */
  const restore = async (manifestName: string) => {
    if (!open || running) return;
    clearResult();
    if (!supportsFsAccess) {
      await doRestore(manifestName, null);
      return;
    }
    let target: FileSystemDirectoryHandle;
    try {
      target = await window.showDirectoryPicker({ id: 'ab-restore-target', mode: 'readwrite' });
    } catch {
      return; // picker cancelled
    }
    try {
      const check = await inspectRestoreTarget(target, open.root);
      if (check.insideRepo) {
        setError(t('errTargetInRepo'));
        return;
      }
      if (check.containsRepo) {
        setError(t('errTargetContainsRepo'));
        return;
      }
      if (check.existing.length > 0) {
        setPending({ manifestName, target, existing: check.existing });
        return;
      }
    } catch (err) {
      setError(errorMessage(err, t));
      return;
    }
    await doRestore(manifestName, target);
  };

  const doRestore = async (manifestName: string, target: FileSystemDirectoryHandle | null) => {
    if (!open || running) return;
    clearResult();
    const signal = startTask('restore');
    try {
      await withScratchLock(async () => {
        const dest = target ?? (await opfsScratch('restore-out'));
        const result = await runRestore({
          repo: open,
          manifestName,
          target: dest,
          onProgress: setProgress,
          signal,
        });
        setFailures(result.failed);
        setRenamed(result.renamed);
        if (supportsFsAccess) {
          setDoneMsg(
            `${t('restored')}: ${result.fileCount} ${t('files')} → ${dest.name} (${(
              result.durationMs / 1000
            ).toFixed(1)}s)`
          );
        } else {
          const archive = await tarDirectory(dest);
          downloadBlob(archive, `restored-${localDateStamp()}.tar`);
          setDoneMsg(`${t('restored')}: ${result.fileCount} ${t('files')} — ${t('restoredTarHint')}`);
        }
      });
    } catch (err) {
      if (isAbort(err)) setCancelledMsg(t('restoreCancelled'));
      else setError(errorMessage(err, t));
    } finally {
      endTask();
    }
  };

  const manifestLabel = (name: string) => {
    const stamp = name.replace(/^manifest-/, '').replace(/\.json(\.enc)?$/, '');
    // 2026-08-12T14-30-05-123Z → ISO again
    const iso = stamp.replace(/^(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/, '$1:$2:$3.$4Z');
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? name : date.toLocaleString(lang);
  };

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <h1 className="text-2xl font-bold text-primary-400 light:text-primary-700">{t('restoreTitle')}</h1>
      <p className="text-sm text-slate-400 light:text-slate-600">
        {supportsFsAccess ? t('restoreIntro') : t('restoreIntroFallback')}
      </p>
      <button onClick={pickRepoDir} disabled={running} className="btn-primary">
        {supportsFsAccess ? t('pickRepoDir') : t('pickTar')}
      </button>
      <input
        ref={tarInput}
        type="file"
        accept=".tar,application/x-tar"
        className="hidden"
        onChange={(e) => onTarPicked(e.target.files)}
      />

      {repos !== null && repos.length === 0 && (
        <div className="card p-4 text-sm text-slate-400 light:text-slate-600">{t('noRepos')}</div>
      )}

      {repos !== null && repos.length > 0 && (
        <div className="card p-5">
          <div className="mb-2 text-xs uppercase tracking-widest text-slate-500 light:text-slate-600">
            {t('reposFound')}
          </div>
          <div className="flex flex-wrap gap-2">
            {repos.map((repo, index) => (
              <button
                key={`${index}-${repo.name}`}
                onClick={() => selectRepo(repo)}
                disabled={running}
                className={`rounded-lg px-3 py-1.5 text-sm ${
                  selected === repo
                    ? 'bg-primary-600 text-white'
                    : 'border border-slate-600/60 light:border-slate-400/60 text-slate-300 light:text-slate-700 hover:bg-slate-700/60 light:hover:bg-slate-300/60'
                }`}
              >
                {repo.name}
              </button>
            ))}
          </div>
        </div>
      )}

      {needPass && selected && (
        <div className="card space-y-3 p-5">
          <div className="text-sm text-slate-300 light:text-slate-700">
            {selected.name} — {t('encryptedRepo')}
          </div>
          <div className="flex gap-2">
            <input
              type="password"
              className="input min-w-0 max-w-sm flex-1"
              placeholder={t('enterPassphrase')}
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              disabled={running}
              onKeyDown={(e) => e.key === 'Enter' && !running && selectRepo(selected, passphrase)}
            />
            <button onClick={() => selectRepo(selected, passphrase)} disabled={running} className="btn-ghost shrink-0">
              {t('unlock')}
            </button>
          </div>
        </div>
      )}

      {open && manifests.length > 0 && (
        <div className="card p-5">
          <div className="mb-3 text-xs uppercase tracking-widest text-slate-500 light:text-slate-600">{t('versions')}</div>
          <ul className="space-y-2">
            {manifests.map((name) => (
              <li key={name} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
                <span className="text-sm text-slate-300 light:text-slate-700">{manifestLabel(name)}</span>
                <button onClick={() => restore(name)} disabled={running} className="btn-ghost whitespace-nowrap">
                  {running ? t('restoring') : t('startRestore')}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {pending && !running && (
        <div ref={pendingRef} className="card ab-rise scroll-my-6 space-y-3 border-amber-500/50 p-5 text-sm" role="alertdialog" aria-label={t('targetNotEmpty')}>
          <div className="font-semibold text-amber-300 light:text-amber-800">
            {t('targetNotEmpty')} {pending.target.name}
          </div>
          <ul className="space-y-0.5 text-xs text-slate-400 light:text-slate-600">
            {pending.existing.map((name) => (
              <li key={name} className="break-all">
                <span className="text-slate-500 light:text-slate-600">└─</span> {name}
              </li>
            ))}
            {pending.existing.length >= 5 && <li>…</li>}
          </ul>
          <p className="text-slate-300 light:text-slate-700">{t('targetNotEmptyHint')}</p>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => void doRestore(pending.manifestName, pending.target)}
              className="btn-ghost border-amber-500/60 text-amber-300 light:text-amber-800"
            >
              {t('overwriteRestore')}
            </button>
            <button onClick={() => void restore(pending.manifestName)} className="btn-ghost">
              {t('otherFolder')}
            </button>
            <button onClick={() => setPending(null)} className="btn-ghost">
              {t('cancel')}
            </button>
          </div>
        </div>
      )}

      {running && (
        <div className="card flex items-start gap-3 p-5 text-sm text-slate-300 light:text-slate-700">
          <span className="min-w-0 flex-1 break-all">
            <span className="text-primary-400 light:text-primary-700">$</span>{' '}
            {taskKind === 'import' ? t('phaseImport') : t('phaseRestore')}
            {progress?.path ? `: ${progress.path}` : '…'}
            {progress ? ` — ${progress.filesDone}/${progress.totalFiles} ${t('files')}` : ''}
          </span>
          <button
            onClick={cancel}
            disabled={cancelling}
            className="shrink-0 rounded border border-slate-600/60 light:border-slate-400/60 px-2 py-0.5 text-xs text-slate-300 light:text-slate-700 transition-colors hover:border-red-500/60 hover:text-red-300 light:hover:text-red-700 disabled:opacity-50"
          >
            {cancelling ? t('cancelling') : `[${t('cancel')}]`}
          </button>
        </div>
      )}

      <div ref={resultRef} className="scroll-my-6 space-y-6">
      {doneMsg && <div className="card break-words border-emerald-500/50 p-4 text-sm text-emerald-300 light:text-emerald-700">{doneMsg}</div>}
      {cancelledMsg && (
        <div className="card border-amber-500/50 p-4 text-sm text-amber-300 light:text-amber-800" role="status">
          {cancelledMsg}
        </div>
      )}
      {renamed.length > 0 && (
        <div className="card border-amber-500/50 p-4 text-sm text-amber-300 light:text-amber-800" role="status">
          <div className="mb-2 font-semibold">
            {renamed.length} {t('renamedFiles')}
          </div>
          <ul className="max-h-48 space-y-1 overflow-y-auto text-xs">
            {renamed.slice(0, 200).map((r, i) => (
              <li key={i} className="break-all">
                <span className="text-slate-500 light:text-slate-600">└─</span> {r.path} → {r.to}
              </li>
            ))}
            {renamed.length > 200 && <li>…</li>}
          </ul>
        </div>
      )}
      {failures.length > 0 && (
        <div className="card border-amber-500/50 p-4 text-sm text-amber-300 light:text-amber-800" role="alert">
          <div className="mb-2 font-semibold">
            {failures.length} {t('restoreFailedSome')}:
          </div>
          <ul className="max-h-48 space-y-1 overflow-y-auto text-xs">
            {failures.slice(0, 200).map((f, i) => (
              <li key={i} className="break-all">
                <span className="text-slate-500 light:text-slate-600">└─</span> {f.path} — {errorMessage(f.error, t)}
              </li>
            ))}
            {failures.length > 200 && <li>…</li>}
          </ul>
        </div>
      )}
      {error && (
        <div className="card break-words border-red-500/50 p-4 text-sm text-red-300 light:text-red-700" role="alert">
          {error}
        </div>
      )}
      </div>
    </div>
  );
}
