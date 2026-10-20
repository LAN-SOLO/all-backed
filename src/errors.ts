// Maps engine and browser errors to a translated, actionable message.
//
// describeError() turns an error into a language-neutral ErrorInfo (i18n
// keys + technical detail). The UI formats it with the current language, and
// a failed run stores the ErrorInfo — so its "Last run" card follows a later
// EN/DE switch instead of showing the language of the failure.
import { EngineError } from './engine/types';
import { supportsFsAccess } from './engine/caps';
import { StringKey, isStringKey } from './i18n';

export interface ErrorInfo {
  keys: StringKey[];
  /** Language-neutral detail (file/block name) or, for unknown errors, the raw message. */
  detail?: string;
}

const ENGINE_KEYS: Record<EngineError['code'], StringKey> = {
  'passphrase-required': 'errPassphraseRequired',
  'passphrase-wrong': 'errPassphraseWrong',
  'repo-unencrypted': 'errRepoUnencrypted',
  'not-a-repo': 'noRepos',
  'verify-failed': 'errVerifyFailed',
  'permission-denied': 'errPermission',
  'repo-invalid': 'errRepoInvalid',
  'manifest-invalid': 'errManifestInvalid',
  'block-corrupt': 'errBlockCorrupt',
  'archive-invalid': 'errArchiveInvalid',
  'archive-truncated': 'errArchiveTruncated',
  'source-in-repo': 'errSourceInRepo',
  'target-locked': 'errTargetLocked',
};

// codes whose detail helps (which file/block/folder) — appended in parens
const WITH_DETAIL = new Set<EngineError['code']>([
  'repo-invalid',
  'manifest-invalid',
  'block-corrupt',
  'permission-denied',
  'source-in-repo',
  'target-locked',
]);

export function describeError(err: unknown): ErrorInfo {
  if (err instanceof EngineError) {
    const keys: StringKey[] = [ENGINE_KEYS[err.code]];
    return WITH_DETAIL.has(err.code) && err.detail ? { keys, detail: err.detail } : { keys };
  }
  if (err instanceof DOMException) {
    if (err.name === 'AbortError') return { keys: ['errCancelled'] };
    if (err.name === 'QuotaExceededError' || err.name === 'UnknownError') {
      // direct mode writes to a real folder: there it is the drive that is
      // full, not browser storage (archive mode stages in OPFS)
      return supportsFsAccess ? { keys: ['errDiskFull'] } : { keys: ['errQuota', 'errDirectHint'] };
    }
    if (err.name === 'NotAllowedError' || err.name === 'SecurityError') return { keys: ['errPermission'] };
    if (err.name === 'NotFoundError') return { keys: ['errNotFound'] };
    if (err.name === 'NotReadableError') return { keys: ['errNotReadable'] };
    if (err.name === 'NoModificationAllowedError' || err.name === 'InvalidStateError') {
      return { keys: ['errLocked'] };
    }
    if (err.name === 'TypeMismatchError') return { keys: ['errTypeMismatch'] };
  }
  // Chromium rejects names the target file system can't hold with a TypeError
  // ("Name is not allowed.") — the engine renames those before writing, so
  // this is only a fallback for names it could not foresee
  if (err instanceof TypeError && /name/i.test(err.message) && /not allowed|invalid/i.test(err.message)) {
    return { keys: ['errBadName'] };
  }
  return { keys: ['errGeneric'], detail: err instanceof Error ? err.message : String(err) };
}

export function formatError(info: ErrorInfo, t: (key: StringKey) => string): string {
  const keys = info.keys.filter(isStringKey);
  if (keys.length === 0) keys.push('errGeneric');
  const base = keys.map((key) => t(key)).join('. ');
  if (!info.detail) return base;
  return keys[0] === 'errGeneric' ? `${base} ${info.detail}` : `${base} (${info.detail})`;
}

export function errorMessage(err: unknown, t: (key: StringKey) => string): string {
  return formatError(describeError(err), t);
}
