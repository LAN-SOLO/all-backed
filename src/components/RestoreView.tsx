import { useEffect, useRef, useState } from 'react';
import { EngineError, Progress } from '../engine/types';
import { OpenRepo, findRepos, listManifests, openRepo, readManifest } from '../engine/repo';
import { runRestore } from '../engine/restore';
import { downloadBlob, opfsScratch, supportsFsAccess } from '../engine/caps';
import { tarDirectory, untarToDirectory } from '../engine/tar';
import { Lang, makeT } from '../i18n';

interface Props {
  lang: Lang;
}

interface RepoEntry {
  name: string;
  handle: FileSystemDirectoryHandle;
}

export default function RestoreView({ lang }: Props) {
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
  const tarInput = useRef<HTMLInputElement>(null);

  const reset = () => {
    setSelected(null);
    setOpen(null);
    setNeedPass(false);
    setPassphrase('');
    setManifests([]);
    setProgress(null);
    setDoneMsg(null);
    setError(null);
  };

  const scanDir = async (dir: FileSystemDirectoryHandle) => {
    reset();
    const found = await findRepos(dir);
    setRepos(found);
    if (found.length === 1) await selectRepo(found[0]);
  };

  const pickRepoDir = async () => {
    if (!supportsFsAccess) {
      tarInput.current?.click();
      return;
    }
    try {
      const dir = await window.showDirectoryPicker({ id: 'ab-restore-repo', mode: 'read' });
      await scanDir(dir);
    } catch {
      /* picker cancelled */
    }
  };

  const importTar = async (archive: Blob) => {
    try {
      const scratch = await opfsScratch('restore-import');
      await untarToDirectory(archive, scratch);
      await scanDir(scratch);
    } catch (err) {
      setError(`${t('errGeneric')} ${err instanceof Error ? err.message : String(err)}`);
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
        setError(`${t('errGeneric')} ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  };

  const restore = async (manifestName: string) => {
    if (!open) return;
    setError(null);
    setDoneMsg(null);
    try {
      let target: FileSystemDirectoryHandle;
      if (supportsFsAccess) {
        target = await window.showDirectoryPicker({ id: 'ab-restore-target', mode: 'readwrite' });
      } else {
        target = await opfsScratch('restore-out');
      }
      setRunning(true);
      const result = await runRestore({
        repo: open,
        manifestName,
        target,
        onProgress: setProgress,
      });
      if (supportsFsAccess) {
        setDoneMsg(
          `${t('restored')}: ${result.fileCount} ${t('files')} → ${target.name} (${(
            result.durationMs / 1000
          ).toFixed(1)}s)`
        );
      } else {
        const archive = await tarDirectory(target);
        const stamp = new Date().toISOString().slice(0, 10);
        downloadBlob(archive, `restored-${stamp}.tar`);
        setDoneMsg(`${t('restored')}: ${result.fileCount} ${t('files')} — ${t('restoredTarHint')}`);
      }
    } catch (err) {
      if (err instanceof EngineError && err.code === 'passphrase-wrong') {
        setError(t('errPassphraseWrong'));
      } else if (!(err instanceof DOMException && err.name === 'AbortError')) {
        setError(`${t('errGeneric')} ${err instanceof Error ? err.message : String(err)}`);
      }
    } finally {
      setRunning(false);
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
      <h1 className="text-2xl font-bold text-primary-400">{t('restoreTitle')}</h1>
      <p className="text-sm text-slate-400">
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
        <div className="card p-4 text-sm text-slate-400">{t('noRepos')}</div>
      )}

      {repos !== null && repos.length > 0 && (
        <div className="card p-5">
          <div className="mb-2 text-xs uppercase tracking-widest text-slate-500">
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
                    : 'border border-slate-600/60 text-slate-300 hover:bg-slate-700/60'
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
          <div className="text-sm text-slate-300">
            {selected.name} — {t('encryptedRepo')}
          </div>
          <div className="flex gap-2">
            <input
              type="password"
              className="input max-w-sm"
              placeholder={t('enterPassphrase')}
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && selectRepo(selected, passphrase)}
            />
            <button onClick={() => selectRepo(selected, passphrase)} className="btn-ghost">
              {t('unlock')}
            </button>
          </div>
        </div>
      )}

      {open && manifests.length > 0 && (
        <div className="card p-5">
          <div className="mb-3 text-xs uppercase tracking-widest text-slate-500">{t('versions')}</div>
          <ul className="space-y-2">
            {manifests.map((name) => (
              <li key={name} className="flex items-center justify-between gap-4">
                <span className="text-sm text-slate-300">{manifestLabel(name)}</span>
                <button onClick={() => restore(name)} disabled={running} className="btn-ghost">
                  {running ? t('restoring') : t('startRestore')}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {running && progress && (
        <div className="card p-5 text-sm text-slate-300">
          <span className="text-primary-400">$</span> {t('phaseRestore')}
          {progress.path ? `: ${progress.path}` : '…'} — {progress.filesDone} {t('files')}
        </div>
      )}

      {doneMsg && <div className="card border-emerald-500/50 p-4 text-sm text-emerald-300">{doneMsg}</div>}
      {error && (
        <div className="card border-red-500/50 p-4 text-sm text-red-300" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}
