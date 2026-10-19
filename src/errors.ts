// Maps engine and browser errors to a translated, actionable message.
import { EngineError } from './engine/types';
import { StringKey } from './i18n';

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
};

// codes whose technical detail helps (which file/block) — appended in parens
const WITH_DETAIL = new Set<EngineError['code']>(['repo-invalid', 'manifest-invalid', 'block-corrupt']);

export function errorMessage(err: unknown, t: (key: StringKey) => string): string {
  if (err instanceof EngineError) {
    const base = t(ENGINE_KEYS[err.code]);
    return WITH_DETAIL.has(err.code) ? `${base} (${err.message})` : base;
  }
  if (err instanceof DOMException) {
    if (err.name === 'QuotaExceededError' || err.name === 'UnknownError') {
      return `${t('errQuota')}. ${t('errDirectHint')}`;
    }
    if (err.name === 'NotAllowedError' || err.name === 'SecurityError') return t('errPermission');
    if (err.name === 'NotFoundError') return t('errNotFound');
    if (err.name === 'NotReadableError') return t('errNotReadable');
  }
  return `${t('errGeneric')} ${err instanceof Error ? err.message : String(err)}`;
}
