import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { createStore, set } from 'idb-keyval';
import { describe, expect, it, vi } from 'vitest';
import input from './release.json';
import { parseGameRelease } from '../game/data/release';
import { getInputActor } from '../game/battle';
import { deriveProgression } from '../game/progression';
import { createGameState } from '../state/game';
import { DELIVERY_KEY, SaveRepository } from '../storage/save';
import { App } from '../app/App';
import { chooseCommand } from './strategy.test-support';

vi.mock('../features/exploration/scene', () => ({
  createExplorationScene: () => ({ update: vi.fn(), destroy: vi.fn() }),
}));
const click = (name: string) =>
  fireEvent.click(screen.getByRole('button', { name }));
async function setup() {
  const release = parseGameRelease(input);
  const store = createStore(crypto.randomUUID(), 'state');
  await set(DELIVERY_KEY, { buildId: 'floor-01' }, store);
  const repository = new SaveRepository('floor-01', () => true, store);
  const game = createGameState(release, repository, () => true);
  await game.load();
  render(<App game={game} recheck={game.load} deliveryReady />);
  return { game, repository, release };
}
async function ready(game: ReturnType<typeof createGameState>) {
  await waitFor(() => expect(game.status.getState().value).toBe('ready'));
}
async function fight(
  game: ReturnType<typeof createGameState>,
  saveFails = false,
) {
  for (let turn = 0; turn < 60; turn++) {
    await waitFor(() =>
      expect(
        game.battle.getState().receipt ||
          (saveFails && game.status.getState().value === 'error') ||
          getInputActor(game.battle.getState().session!),
      ).toBeTruthy(),
    );
    if (
      game.battle.getState().receipt ||
      (saveFails && game.status.getState().value === 'error')
    )
      return;
    const command = chooseCommand(game.battle.getState().session!);
    click(game.release.presentation.entries[command.skillId]!.name);
    if (command.selectedTargetId)
      fireEvent.change(screen.getByLabelText('対象'), {
        target: { value: command.selectedTargetId },
      });
    if (command.chosenElement)
      fireEvent.change(screen.getByLabelText('属性'), {
        target: { value: command.chosenElement },
      });
    click('コマンドを確定');
  }
  throw new Error('60手以内に決着しませんでした');
}
describe('正式第1階層の画面一巡', () => {
  it('ヒントを読み雷へリビルドし、祠・予告碑・ボス・報酬保存・次階層解放・再読込まで一巡する', async () => {
    const { game, repository, release } = await setup();
    click('冒険を始める');
    await ready(game);
    click('伝言板・階層');
    expect(
      screen.getByText(release.presentation.floors['floor-01']!.hints[0]!),
    ).toBeVisible();
    expect(
      screen.getByRole('button', { name: '第2階層へワープ' }),
    ).toBeDisabled();
    click('パーティ・スキル');
    fireEvent.click(screen.getByRole('button', { name: /仲間2 ウィザード/ }));
    click('全スキルを解除');
    click('候補へ反映');
    click('氷雷術Iを習得');
    click('氷雷術IIを習得');
    click('変更を保存');
    await ready(game);
    expect(game.snapshot()!.party[1].learnedSkills).toEqual([
      'wizard-b1',
      'wizard-b2',
    ]);
    click('設定');
    fireEvent.click(
      screen.getByRole('checkbox', { name: '戦闘演出をスキップ' }),
    );
    click('設定を保存');
    await ready(game);
    click('伝言板・階層');
    click('第1階層へワープ');
    await screen.findByRole('alertdialog');
    click('探索を続ける');
    click('灯火回廊・一');
    await ready(game);
    click('石牙の短剣の祠 · 石造の試練の剣の守り手');
    click('戦う');
    await ready(game);
    await fight(game);
    expect(screen.getByLabelText('勝利報酬')).toHaveTextContent(
      '石牙の短剣 × 1',
    );
    const guardianSaved = await repository.read();
    click('探索を続ける');
    expect(screen.getByText(/この部屋の敵は再出現/)).toBeVisible();
    click('灯火回廊・一');
    await ready(game);
    click('灯火回廊・二');
    await ready(game);
    click('灯火回廊・三');
    await ready(game);
    click('予告碑・ボスの攻略ヒントを読む');
    expect(
      within(screen.getByRole('alertdialog')).getByText(
        release.presentation.floors['floor-01']!.hints[1]!,
      ),
    ).toBeVisible();
    click('探索を続ける');
    click('封印の広間 · 門衛ゴーレム');
    click('戦う');
    await ready(game);
    await fight(game);
    expect(screen.getByLabelText('勝利報酬')).toHaveTextContent(
      '第2階層を解放',
    );
    expect(
      screen.getByRole('button', { name: '次の階層はこの版では未収録です' }),
    ).toBeDisabled();
    const progress = deriveProgression(
      release.campaign,
      game.snapshot()!.progression,
    );
    expect(progress.skillPointLimit).toBe(4);
    expect(progress.inventory.get('relic-01-01')).toBe(1);
    expect(progress.unlockedFloorIds).toContain('floor-02');
    expect(await repository.read()).not.toEqual(guardianSaved);
    // 帰還保存失敗でも報酬画面を消さず、再試行成功後に拠点へ遷移する。
    vi.spyOn(repository, 'write').mockRejectedValueOnce(new Error('容量不足'));
    click('拠点へ戻る');
    await screen.findByRole('button', { name: '保存を再試行' });
    expect(game.battle.getState().receipt?.enemyId).toBe('boss-01');
    click('保存を再試行');
    await screen.findByRole('heading', { name: '迷宮ギルド' });
    click('伝言板・階層');
    expect(screen.getByText('解放済み・この版では未実装')).toBeVisible();
    await act(() => game.load());
    expect(game.snapshot()!.progression.defeatedEnemyIds).toEqual([
      'guardian-01-01',
      'boss-01',
    ]);
    expect(game.battle.getState().session).toBeNull();
    expect(game.snapshot()!.progression.location.kind).toBe('guild');
  });
});

describe('正式第1階層の保存境界', () => {
  it('S01・S02・S12: 戦闘前保存失敗では開始せず、再試行後の設定を保存し、再読込すると親分岐と最新設定を復元する', async () => {
    const { game, repository } = await setup();
    click('冒険を始める');
    await ready(game);
    click('伝言板・階層');
    click('第1階層へワープ');
    await screen.findByRole('alertdialog');
    click('探索を続ける');
    click('灯火回廊・一');
    await ready(game);
    const before = await repository.read();
    click('石牙の短剣の祠 · 石造の試練の剣の守り手');
    vi.spyOn(repository, 'write').mockRejectedValueOnce(new Error('容量不足'));
    click('戦う');
    await screen.findByRole('button', { name: '保存を再試行' });
    expect(game.battle.getState().session).toBeNull();
    expect(await repository.read()).toEqual(before);
    click('保存を再試行');
    await screen.findByLabelText('コマンド選択');
    click('設定');
    fireEvent.change(screen.getByRole('slider', { name: /総音量/ }), {
      target: { value: '17' },
    });
    click('設定を保存');
    await ready(game);
    const next = createGameState(game.release, repository, () => true);
    await next.load();
    expect(next.snapshot()!.progression.location).toHaveProperty(
      'nodeId',
      'floor-01-hall-1',
    );
    expect(next.snapshot()!.progression.defeatedEnemyIds).toEqual([]);
    expect(next.battle.getState().session).toBeNull();
    expect(next.snapshot()!.settings.masterVolume).toBe(17);
  });
});

describe('正式ボスの未保存勝利', () => {
  it('S03・S05: 実戦勝利の保存失敗後は再起動で未討伐、再試行で報酬と解放を一度だけ確定する', async () => {
    const { game, repository } = await setup();
    click('冒険を始める');
    await ready(game);
    await act(async () => {
      const data = game.snapshot()!;
      data.party[1].learnedSkills = ['wizard-b1', 'wizard-b2'];
      data.settings.skipBattleAnimations = true;
      await game.update(data);
      await game.warp('floor-01');
      game.dismissEntry();
      await game.move('floor-01-hall-1');
      await game.move('floor-01-hall-2');
      await game.move('floor-01-hall-3');
      await game.move('floor-01-boss');
    });
    click('戦う');
    await ready(game);
    const before = await repository.read();
    vi.spyOn(repository, 'write').mockRejectedValueOnce(new Error('容量不足'));
    await fight(game, true);
    expect(screen.queryByLabelText('勝利報酬')).toBeNull();
    expect(await repository.read()).toEqual(before);
    const reboot = createGameState(game.release, repository, () => true);
    await reboot.load();
    expect(reboot.snapshot()!.progression.location).toHaveProperty(
      'nodeId',
      'floor-01-hall-3',
    );
    expect(reboot.snapshot()!.progression.defeatedEnemyIds).toEqual([]);
    click('保存を再試行');
    await screen.findByLabelText('勝利報酬');
    expect(game.snapshot()!.progression.defeatedEnemyIds).toEqual(['boss-01']);
    expect(
      deriveProgression(game.release.campaign, game.snapshot()!.progression)
        .skillPointLimit,
    ).toBe(4);
    await expect(game.victory()).rejects.toThrow('勝利が成立していません');
  });
});
