import { createStore, get, type UseStore } from 'idb-keyval';

export const SAVE_KEY = 'relicspire-save';
export const DELIVERY_KEY = 'relicspire-delivery';
export interface SaveIdentity {
  saveId: string;
  revision: number;
}
export interface SaveSnapshot<T> extends SaveIdentity {
  schemaVersion: number;
  contentVersion: number;
  updatedAt: number;
  data: T;
}
export interface SaveEnvelope<T> {
  current: SaveSnapshot<T>;
  previous: unknown;
}
export class SaveConflict extends Error {}
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);

/** idb-keyvalの同一ストア内で配信版・期待値の照合と包更新を原子的に行う。 */
export class SaveRepository {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(
    readonly buildId: string,
    private readonly owns: () => boolean,
    readonly store: UseStore = createStore('relicspire', 'state'),
  ) {}
  read(): Promise<unknown> {
    return get(SAVE_KEY, this.store);
  }
  write<T>(expected: unknown, candidate: SaveEnvelope<T>): Promise<void> {
    const operation = this.queue.then(async () => {
      if (!this.owns()) throw new SaveConflict('別のタブでプレイ中です');
      try {
        await this.store(
          'readwrite',
          (store) =>
            new Promise<void>((resolve, reject) => {
              const tx = store.transaction;
              tx.oncomplete = () => resolve();
              tx.onabort = () =>
                reject(tx.error ?? new SaveConflict('保存が競合しました'));
              const saved = store.get(SAVE_KEY);
              saved.onsuccess = () => {
                const delivery = store.get(DELIVERY_KEY);
                delivery.onsuccess = () => {
                  const active = delivery.result as
                    { buildId?: string } | undefined;
                  if (
                    !this.owns() ||
                    !same(saved.result, expected) ||
                    active?.buildId !== this.buildId
                  ) {
                    tx.abort();
                    return;
                  }
                  store.put(candidate, SAVE_KEY);
                };
              };
            }),
        );
      } catch (error) {
        if (error instanceof SaveConflict) throw error;
        if (same(await this.read(), candidate)) return;
        throw error;
      }
    });
    this.queue = operation.catch(() => undefined);
    return operation;
  }
}

/** lock callbackが終了するまで所有権を保持する。非表示では解放しない。 */
export class SaveOwnership {
  owned = false;
  private releaseLock: (() => void) | undefined;
  async acquire(
    locks: LockManager | undefined = navigator.locks,
  ): Promise<boolean> {
    if (this.owned) return true;
    if (!locks) return false;
    return new Promise<boolean>((resolve, reject) => {
      void locks
        .request(
          'relicspire-save-owner',
          { ifAvailable: true },
          async (lock) => {
            if (!lock) {
              resolve(false);
              return;
            }
            this.owned = true;
            await new Promise<void>((release) => {
              this.releaseLock = release;
              resolve(true);
            });
            this.owned = false;
          },
        )
        .catch(reject);
    });
  }
  release() {
    this.owned = false;
    this.releaseLock?.();
    this.releaseLock = undefined;
  }
}
