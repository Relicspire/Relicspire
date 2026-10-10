import { describe, expect, it, vi } from 'vitest';
import { SaveOwnership } from '../storage/save';
import { createRuntime } from './runtime';

describe('起動と単一タブの所有権', () => {
  it('不正な正式データは所有権を取得する前に拒否する', async () => {
    const acquire = vi.spyOn(SaveOwnership.prototype, 'acquire');
    await expect(createRuntime({}, 'test')).rejects.toThrow();
    expect(acquire).not.toHaveBeenCalled();
    acquire.mockRestore();
  });
  it('Web Locksが利用できない環境は所有権を取得しない', async () => {
    const ownership = new SaveOwnership();
    await expect(ownership.acquire(undefined)).resolves.toBe(false);
    expect(ownership.owned).toBe(false);
  });
  it('ロック取得と解放を通知し、再取得後に古い解放通知で所有権を失わない', async () => {
    const locks = {
      request: async (
        _name: string,
        _options: unknown,
        callback: (lock: object) => Promise<void>,
      ) => callback({}),
    } as unknown as LockManager;
    const ownership = new SaveOwnership();
    const states: boolean[] = [];
    const unsubscribe = ownership.subscribe(() => states.push(ownership.owned));
    expect(await ownership.acquire(locks)).toBe(true);
    ownership.release();
    expect(await ownership.acquire(locks)).toBe(true);
    expect(ownership.owned).toBe(true);
    expect(states).toEqual([true, false, true]);
    ownership.release();
    unsubscribe();
  });
});
