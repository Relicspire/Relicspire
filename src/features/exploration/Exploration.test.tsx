import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { createStore, set } from 'idb-keyval';
import { describe, it, expect, vi } from 'vitest';
import { App } from '../../app/App';
import { createGameState } from '../../state/game';
import { releaseFixture } from '../../game/data/release.fixtures.test-support';
import { DELIVERY_KEY, SaveRepository } from '../../storage/save';

vi.mock('./scene', () => ({
  createExplorationScene: (_host: HTMLElement, failure: () => void) => {
    failure();
    return { update: vi.fn(), destroy: vi.fn() };
  },
}));
async function setup() {
  const release = releaseFixture();
  const store = createStore(crypto.randomUUID(), 'state');
  await set(DELIVERY_KEY, { buildId: 'test' }, store);
  const repository = new SaveRepository('test', () => true, store);
  const game = createGameState(release, repository, () => true);
  await game.load();
  await game.newGame();
  await game.warp('floor-01');
  return { game, repository };
}
function show(game: ReturnType<typeof createGameState>) {
  render(<App game={game} recheck={() => game.load()} deliveryReady />);
}
const click = (name: string) =>
  fireEvent.click(screen.getByRole('button', { name }));

describe('探索画面と保存', () => {
  it('初訪問本文と描画障害案内を表示し、保存済み経路から再読込を再開する', async () => {
    const { game } = await setup();
    show(game);
    expect(screen.getByRole('alertdialog')).toHaveTextContent('入口文');
    expect(screen.getByRole('alert')).toHaveTextContent('Canvas・WebGL');
    click('探索を続ける');
    click('分岐 1');
    await waitFor(() =>
      expect(game.snapshot()?.progression.location).toHaveProperty(
        'nodeId',
        'floor-01-hall-1',
      ),
    );
    await game.load();
    expect(game.progression.getState().value?.location).toHaveProperty(
      'nodeId',
      'floor-01-hall-1',
    );
    expect(game.exploration.getState().entryText).toBeNull();
  });
  it('移動保存が失敗したら旧位置を維持し、再試行成功後だけ移動する', async () => {
    const { game, repository } = await setup();
    show(game);
    click('探索を続ける');
    vi.spyOn(repository, 'write').mockRejectedValueOnce(new Error('容量不足'));
    click('分岐 1');
    await screen.findByRole('button', { name: '保存を再試行' });
    expect(game.snapshot()?.progression.location).toHaveProperty(
      'nodeId',
      'floor-01-entry',
    );
    click('保存を再試行');
    await waitFor(() =>
      expect(game.snapshot()?.progression.location).toHaveProperty(
        'nodeId',
        'floor-01-hall-1',
      ),
    );
  });
  it('守護者の遭遇と回避では現在地も保存世代も変えず、戦う時に保存して開始する', async () => {
    const { game, repository } = await setup();
    game.dismissEntry();
    await game.move('floor-01-hall-1');
    show(game);
    const before = await repository.read();
    click('守護者の間 1 · 名称 guardian-01-01');
    expect(screen.getByRole('alertdialog')).toHaveTextContent('弱点');
    expect(await repository.read()).toEqual(before);
    click('回避する');
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(game.snapshot()?.progression.location).toHaveProperty(
      'nodeId',
      'floor-01-hall-1',
    );
    click('守護者の間 1 · 名称 guardian-01-01');
    vi.spyOn(repository, 'write').mockRejectedValueOnce(new Error('容量不足'));
    click('戦う');
    await screen.findByRole('button', { name: '保存を再試行' });
    expect(game.battle.getState().session).toBeNull();
    click('保存を再試行');
    await screen.findByRole('heading', {
      name: '戦闘開始：名称 guardian-01-01',
    });
    expect(game.battle.getState().session).not.toBeNull();
    click('探索へ戻る');
    await waitFor(() => expect(game.battle.getState().session).toBeNull());
    expect(game.snapshot()?.progression.location).toHaveProperty(
      'nodeId',
      'floor-01-hall-1',
    );
  });
  it('討伐済み守護者を経路の敵表示から除き、普通の部屋として保存して帰還する', async () => {
    const { game } = await setup();
    game.dismissEntry();
    const data = game.snapshot()!;
    data.progression.defeatedEnemyIds.push('guardian-01-01');
    await game.update(data);
    await game.move('floor-01-hall-1');
    show(game);
    expect(screen.queryByRole('button', { name: /守護者の間 1 ·/ })).toBeNull();
    click('守護者の間 1');
    await waitFor(() =>
      expect(game.snapshot()?.progression.location).toHaveProperty(
        'nodeId',
        'floor-01-alcove-1',
      ),
    );
    expect(game.exploration.getState().encounter).toBeNull();
    click('拠点へ帰還');
    await screen.findByRole('heading', { name: '迷宮ギルド' });
  });
  it('ワープ保存の取消では初訪問を消費せず、再試行成功時に入口文を表示する', async () => {
    const { game, repository } = await setup();
    game.dismissEntry();
    await game.returnToGuild();
    const data = game.snapshot()!;
    data.progression.visitedFloorIds = [];
    await game.update(data);
    vi.spyOn(repository, 'write').mockRejectedValueOnce(new Error('容量不足'));
    await expect(game.warp('floor-01')).rejects.toThrow('容量不足');
    await game.cancel();
    expect(game.snapshot()?.progression.visitedFloorIds).toEqual([]);
    await game.warp('floor-01');
    expect(game.exploration.getState().entryText).toBe('入口文');
  });
});
