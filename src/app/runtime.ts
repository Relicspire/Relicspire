import { get, type UseStore } from 'idb-keyval';
import { parseGameRelease } from '../game/data/release';
import { createGameState } from '../state/game';
import { DELIVERY_KEY, SaveOwnership, SaveRepository } from '../storage/save';

/** 正式データと、タスク8が検証・確定した配信状態だけで起動する。 */
export async function createRuntime(
  input: unknown,
  buildId: string,
  options: {
    ownership?: SaveOwnership;
    store?: UseStore;
  } = {},
) {
  const release = parseGameRelease(input);
  const ownership = options.ownership ?? new SaveOwnership();
  await ownership.acquire();
  const repository = new SaveRepository(
    buildId,
    () => ownership.owned,
    options.store,
  );
  const game = createGameState(release, repository, () => ownership.owned);
  // 画面のマウント前・アンマウント後でも所有権喪失を同期的に反映する。
  const unsubscribe = ownership.subscribe(() => {
    if (!ownership.owned) game.stopForOwnershipLoss();
  });
  let disposed = false;
  let checking: Promise<void> | null = null;
  const recheck = () => {
    if (disposed) return Promise.reject(new Error('終了済みの起動管理器です'));
    if (checking) return checking;
    if (
      game.status.getState().value === 'saving' ||
      (game.status.getState().value === 'error' && game.hasPendingSave())
    ) {
      return Promise.reject(
        new Error('保存を再試行または取り消してから再確認してください'),
      );
    }
    checking = (async () => {
      game.stopForOwnershipLoss();
      game.status.setState({
        value: 'loading',
        message: '所有権と最新セーブを再確認中…',
      });
      try {
        await ownership.acquire();
        if (disposed) {
          ownership.release();
          return;
        }
        await game.load();
        if (disposed) game.stopForOwnershipLoss();
      } catch (error) {
        game.stopForOwnershipLoss();
        throw error;
      }
    })().finally(() => {
      checking = null;
    });
    return checking;
  };
  try {
    await game.load();
    const delivery = await get<{ buildId: string }>(
      DELIVERY_KEY,
      repository.store,
    );
    return {
      game,
      release,
      ownership,
      recheck,
      deliveryReady: delivery?.buildId === buildId,
      dispose: () => {
        disposed = true;
        game.stopForOwnershipLoss();
        unsubscribe();
        ownership.release();
      },
    };
  } catch (error) {
    unsubscribe();
    ownership.release();
    throw error;
  }
}
export type Runtime = Awaited<ReturnType<typeof createRuntime>>;

// 合成fixtureは製品へ取り込まない。正式カタログの制作は5.5で扱う。
export function bundledRelease(): unknown {
  const modules = import.meta.glob('../content/release.json', {
    eager: true,
    import: 'default',
  });
  return modules['../content/release.json'];
}
