import { get } from 'idb-keyval';
import { parseGameRelease } from '../game/data/release';
import { createGameState } from '../state/game';
import { DELIVERY_KEY, SaveOwnership, SaveRepository } from '../storage/save';

/** 正式データと、タスク8が検証・確定した配信状態だけで起動する。 */
export async function createRuntime(input: unknown, buildId: string) {
  const release = parseGameRelease(input);
  const ownership = new SaveOwnership();
  await ownership.acquire();
  const repository = new SaveRepository(buildId, () => ownership.owned);
  const game = createGameState(release, repository, () => ownership.owned);
  const recheck = async () => {
    await ownership.acquire();
    await game.load();
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
        game.stopForOwnershipLoss();
        ownership.release();
      },
    };
  } catch (error) {
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
