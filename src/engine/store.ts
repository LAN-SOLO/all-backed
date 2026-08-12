// Task persistence in IndexedDB. Directory handles are structured-cloneable,
// so tasks keep their source/destination across sessions; Chrome re-prompts
// for permission on first use after a restart.

import { BackupTask } from './types';

const DB_NAME = 'allbacked';
const STORE = 'tasks';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const req = run(t.objectStore(STORE));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
        t.oncomplete = () => db.close();
      })
  );
}

export async function loadTasks(): Promise<BackupTask[]> {
  const tasks = await tx<BackupTask[]>('readonly', (s) => s.getAll() as IDBRequest<BackupTask[]>);
  return tasks.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function saveTask(task: BackupTask): Promise<IDBValidKey> {
  return tx('readwrite', (s) => s.put(task));
}

export function deleteTask(id: string): Promise<undefined> {
  return tx('readwrite', (s) => s.delete(id) as IDBRequest<undefined>);
}

export function newTask(name: string): BackupTask {
  return {
    id: crypto.randomUUID(),
    name,
    createdAt: new Date().toISOString(),
    encrypt: true,
    source: null,
    dest: null,
    lastRun: null,
  };
}
