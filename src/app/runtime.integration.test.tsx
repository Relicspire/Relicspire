import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { createStore, get, set } from 'idb-keyval';
import { afterEach, describe, expect, it, vi } from 'vitest';
import input from '../content/release.json';
import { parseGameRelease } from '../game/data/release';
import { selectNode } from '../game/progression';
import {
  DELIVERY_KEY,
  SAVE_KEY,
  SaveOwnership,
  SaveRepository,
} from '../storage/save';
import { App } from './App';
import { createRuntime, type Runtime } from './runtime';

/** Web LocksのifAvailableとコールバック完了までの排他を再現する。 */
function lockManager() {
  let held = false;
  return {
    request: async (
      _name: string,
      _options: unknown,
      callback: (lock: object | null) => Promise<void>,
    ) => {
      if (held) return callback(null);
      held = true;
      try {
        await callback({});
      } finally {
        held = false;
      }
    },
  } as unknown as LockManager;
}
function owner(locks: LockManager) {
  return new (class extends SaveOwnership {
    override acquire() {
      return super.acquire(locks);
    }
  })();
}
const runtimes: Runtime[] = [];
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.dispose();
  vi.restoreAllMocks();
});
async function setup() {
  const store = createStore(`runtime-${crypto.randomUUID()}`, 'state');
  const locks = lockManager();
  const release = parseGameRelease(input);
  await set(DELIVERY_KEY, { buildId: 'integration' }, store);
  const boot = async () => {
    const runtime = await createRuntime(release, 'integration', {
      store,
      ownership: owner(locks),
    });
    runtimes.push(runtime);
    return runtime;
  };
  return { store, release, boot };
}

describe('共通UIと起動管理器の単一タブ接続', () => {
  it('所有権取得後に初回ロードし、別タブでは読取専用と書込拒否になる', async () => {
    const { boot, store } = await setup();
    const first = await boot();
    expect(first.ownership.owned).toBe(true);
    expect(first.game.status.getState().value).toBe('empty');
    expect(first.deliveryReady).toBe(true);
    await first.game.newGame();
    const raw = await get(SAVE_KEY, store);
    const second = await boot();
    render(
      <App
        game={second.game}
        recheck={second.recheck}
        deliveryReady={second.deliveryReady}
      />,
    );
    expect(second.ownership.owned).toBe(false);
    expect(screen.getByText(/読取専用：/)).toBeVisible();
    expect(screen.getByRole('button', { name: '設定' })).toBeDisabled();
    await expect(second.game.update(second.game.snapshot()!)).rejects.toThrow(
      '所有権',
    );
    expect(await get(SAVE_KEY, store)).toEqual(raw);
  });
  it('再確認では所有権を横取りせず、解放後に取得して最新のセーブを表示する', async () => {
    const { boot } = await setup();
    const first = await boot();
    await first.game.newGame();
    const second = await boot();
    const data = first.game.snapshot()!;
    await first.game.update({
      ...data,
      settings: { ...data.settings, masterVolume: 17 },
    });
    await second.recheck();
    expect(second.ownership.owned).toBe(false);
    expect(second.game.status.getState().value).toBe('readonly');
    await act(async () => first.dispose());
    render(<App game={second.game} recheck={second.recheck} deliveryReady />);
    fireEvent.click(screen.getByRole('button', { name: '再確認・読み直し' }));
    await waitFor(() =>
      expect(second.game.status.getState().value).toBe('ready'),
    );
    expect(second.ownership.owned).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '設定' }));
    expect(screen.getByRole('slider', { name: /総音量/ })).toHaveValue('17');
  });
  it('画面をマウントしていなくても所有権喪失で戦闘と遭遇を破棄し操作を止める', async () => {
    const { boot, release } = await setup();
    const runtime = await boot();
    await runtime.game.newGame();
    const data = runtime.game.snapshot()!;
    data.progression.visitedFloorIds = ['floor-01'];
    data.progression.location = {
      kind: 'floor',
      floorId: 'floor-01',
      nodeId: 'floor-01-hall-3',
    };
    await runtime.game.update(data);
    const chosen = selectNode(release, data.progression, 'floor-01-boss');
    if (!chosen.ok || !chosen.value.encounter) throw new Error('遭遇失敗');
    await runtime.game.startBattle(chosen.value.encounter);
    expect(runtime.game.battle.getState().session).not.toBeNull();
    runtime.ownership.release();
    expect(runtime.game.battle.getState().session).toBeNull();
    expect(runtime.game.exploration.getState().encounter).toBeNull();
    expect(runtime.game.status.getState().value).toBe('readonly');
    render(<App game={runtime.game} recheck={runtime.recheck} deliveryReady />);
    expect(screen.getByRole('button', { name: '設定' })).toBeDisabled();
  });
  it('保存失敗候補は通常の再確認では捨てず、所有権喪失後の再取得では最新確定値を読む', async () => {
    const { boot } = await setup();
    const runtime = await boot();
    await runtime.game.newGame();
    const write = vi
      .spyOn(SaveRepository.prototype, 'write')
      .mockRejectedValueOnce(new Error('容量不足'));
    const data = runtime.game.snapshot()!;
    await expect(
      runtime.game.update({
        ...data,
        settings: { ...data.settings, masterVolume: 0 },
      }),
    ).rejects.toThrow('容量不足');
    write.mockRestore();
    await expect(runtime.recheck()).rejects.toThrow('再試行または取り消し');
    expect(runtime.game.hasPendingSave()).toBe(true);
    await act(async () => runtime.ownership.release());
    render(<App game={runtime.game} recheck={runtime.recheck} deliveryReady />);
    fireEvent.click(screen.getByRole('button', { name: '再確認・読み直し' }));
    await waitFor(() =>
      expect(runtime.game.status.getState().value).toBe('ready'),
    );
    expect(runtime.game.hasPendingSave()).toBe(false);
    expect(runtime.game.settings.getState().value?.masterVolume).toBe(80);
  });
  it('連続した再確認を一本化し、終了後には所有権を取得し直さない', async () => {
    const { boot } = await setup();
    const runtime = await boot();
    const acquire = vi.spyOn(runtime.ownership, 'acquire');
    await act(async () => {
      const one = runtime.recheck();
      const two = runtime.recheck();
      expect(one).toBe(two);
      await one;
    });
    expect(acquire).toHaveBeenCalledTimes(1);
    runtime.dispose();
    await expect(runtime.recheck()).rejects.toThrow('終了済み');
    expect(runtime.ownership.owned).toBe(false);
  });
});
