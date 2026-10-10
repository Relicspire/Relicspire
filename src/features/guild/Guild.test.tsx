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
import { App } from '../../app/App';
import { releaseFixture } from '../../game/data/release.fixtures.test-support';
import { createGameState } from '../../state/game';
import { DELIVERY_KEY, SaveRepository } from '../../storage/save';

async function setup() {
  const release = releaseFixture();
  const store = createStore(`guild-${crypto.randomUUID()}`, 'state');
  const repository = new SaveRepository('guild-test', () => true, store);
  await set(DELIVERY_KEY, { buildId: 'guild-test' }, store);
  const game = createGameState(release, repository, () => true);
  await game.load();
  await game.newGame();
  return { game, repository };
}
function show(game: Awaited<ReturnType<typeof setup>>['game']) {
  render(<App game={game} recheck={game.load} deliveryReady />);
}
function click(name: string) {
  fireEvent.click(screen.getByRole('button', { name }));
}
function confirm() {
  fireEvent.click(
    within(screen.getByRole('alertdialog')).getByRole('button', {
      name: '候補へ反映',
    }),
  );
}
async function save(game: Awaited<ReturnType<typeof setup>>['game']) {
  click('変更を保存');
  await waitFor(() => expect(game.status.getState().value).toBe('ready'));
}

describe('迷宮ギルドの編成と保存', () => {
  it('3人と全8ジョブを表示し、予算不足の上位ノードも性能を閲覧できる', async () => {
    const { game } = await setup();
    show(game);
    expect(screen.getAllByRole('option')).toHaveLength(8);
    expect(
      screen.getByRole('button', { name: '名称 knight-a3を習得' }),
    ).toBeDisabled();
    expect(
      screen.getByRole('button', { name: '名称 knight-b3を習得' }),
    ).toBeDisabled();
    expect(screen.getAllByText('性能・効果を見る')).toHaveLength(6);
    expect(screen.getByRole('button', { name: /名称 party-3/ })).toBeVisible();
  });
  it('ジョブ変更は確認後に本人だけ全解除し、保存成功まで確定編成を変えない', async () => {
    const { game } = await setup();
    show(game);
    const before = game.snapshot()!;
    fireEvent.change(screen.getByRole('combobox', { name: 'ジョブ' }), {
      target: { value: 'wizard' },
    });
    expect(screen.getByRole('alertdialog')).toHaveTextContent(
      '習得スキルを全解除',
    );
    expect(game.snapshot()).toEqual(before);
    confirm();
    expect(game.snapshot()).toEqual(before);
    await save(game);
    expect(game.snapshot()?.party[0].jobId).toBe('wizard');
    expect(game.snapshot()?.party[0].learnedSkills).toEqual([]);
    expect(game.snapshot()?.party.slice(1)).toEqual(before.party.slice(1));
    await act(() => game.load());
    expect(game.snapshot()?.party[0].jobId).toBe('wizard');
  });
  it('前提ノードの解除は子孫と返却費用を確認し、別ルートへ無料で割り振れる', async () => {
    const { game } = await setup();
    show(game);
    click('名称 knight-a1を解除');
    expect(screen.getByRole('alertdialog')).toHaveTextContent('名称 knight-a2');
    expect(screen.getByRole('alertdialog')).toHaveTextContent('3 pt返却');
    confirm();
    click('名称 knight-b1を習得');
    await save(game);
    expect(game.snapshot()?.party[0].learnedSkills).toEqual(['knight-b1']);
    expect(game.snapshot()?.party[1].learnedSkills).toEqual([
      'wizard-a1',
      'wizard-a2',
    ]);
  });
  it('未保存のリビルドは確認付きで取り消し、編成を元へ戻す', async () => {
    const { game } = await setup();
    show(game);
    const before = game.snapshot()!;
    click('全スキルを解除');
    confirm();
    expect(screen.getByRole('button', { name: '設定' })).toBeDisabled();
    click('変更を取り消す');
    confirm();
    expect(game.snapshot()).toEqual(before);
    expect(
      screen.getByRole('button', { name: '名称 knight-a1を解除' }),
    ).toBeEnabled();
  });
  it('保存失敗時は確定編成を保ち、同じ編集候補を再試行して確定できる', async () => {
    const { game, repository } = await setup();
    show(game);
    click('全スキルを解除');
    confirm();
    vi.spyOn(repository, 'write').mockRejectedValueOnce(new Error('容量不足'));
    click('変更を保存');
    await screen.findByRole('button', { name: '保存を再試行' });
    expect(game.snapshot()?.party[0].learnedSkills).toHaveLength(2);
    click('保存を再試行');
    await waitFor(() =>
      expect(game.snapshot()?.party[0].learnedSkills).toHaveLength(0),
    );
  });
});

describe('宝物庫・装備・プリセット', () => {
  it('18枠を表示し、タップで人物間の装備を交換して保存できる', async () => {
    const { game } = await setup();
    show(game);
    const before = game.snapshot()!;
    click('宝物庫・装備');
    expect(screen.getAllByRole('button', { name: /の枠\d：/ })).toHaveLength(
      18,
    );
    click('名称 party-1の枠1：名称 starter-sword');
    click('名称 party-2の枠2：名称 starter-staff');
    await save(game);
    expect(game.snapshot()?.party[0].equipment[0]).toBe('starter-staff');
    expect(game.snapshot()?.party[1].equipment[1]).toBe('starter-sword');
    expect(game.snapshot()?.party[2]).toEqual(before.party[2]);
  });
  it('ドラッグで所持数を超える装備候補を拒否し、外した品だけ再装着できる', async () => {
    const { game } = await setup();
    show(game);
    click('宝物庫・装備');
    const target = screen
      .getByRole('button', { name: '名称 party-1の枠2：名称 starter-staff' })
      .closest('li')!;
    fireEvent.drop(target, {
      dataTransfer: {
        getData: () => JSON.stringify({ item: 'starter-sword' }),
      },
    });
    expect(screen.getByRole('alert')).toHaveTextContent('所持');
    expect(screen.getByRole('button', { name: '変更を保存' })).toBeDisabled();
    click('名称 party-1の枠1を外す');
    click('名称 starter-swordを選ぶ');
    click('名称 party-1の枠1：空欄');
    expect(screen.getByRole('button', { name: '変更を保存' })).toBeDisabled();
  });
  it('プリセットを登録・改名・呼出し、確認付き削除を保存できる', async () => {
    const { game } = await setup();
    show(game);
    click('プリセット');
    fireEvent.change(screen.getByRole('textbox', { name: 'プリセット名' }), {
      target: { value: '初期構成' },
    });
    click('現在の編成を登録');
    expect(game.snapshot()?.presets).toHaveLength(0);
    await save(game);
    click('プリセット');
    fireEvent.change(screen.getByRole('textbox', { name: 'プリセット名' }), {
      target: { value: '守護構成' },
    });
    click('初期構成を改名');
    await save(game);
    expect(game.snapshot()?.presets[0]?.name).toBe('守護構成');
    click('全スキルを解除');
    confirm();
    await save(game);
    click('プリセット');
    click('守護構成を呼び出す');
    confirm();
    await save(game);
    expect(game.snapshot()?.party[0].learnedSkills).toHaveLength(2);
    click('プリセット');
    click('守護構成を削除');
    expect(game.snapshot()?.presets).toHaveLength(1);
    confirm();
    await save(game);
    expect(game.snapshot()?.presets).toHaveLength(0);
  });
  it('プリセットの上書きは確認後に現在候補を記録し、20件では新規登録を禁止する', async () => {
    const { game } = await setup();
    const data = game.snapshot()!;
    data.presets = Array.from({ length: 20 }, (_, i) => ({
      id: `preset-${i}` as const,
      name: `構成${i}`,
      createdAt: 1,
      updatedAt: 1,
      contentVersion: 1,
      party: structuredClone(data.party),
    }));
    await game.update(data);
    show(game);
    click('全スキルを解除');
    confirm();
    click('プリセット');
    fireEvent.change(screen.getByRole('textbox', { name: 'プリセット名' }), {
      target: { value: '更新構成' },
    });
    expect(
      screen.getByRole('button', { name: '現在の編成を登録' }),
    ).toBeDisabled();
    click('構成0を上書き');
    confirm();
    await save(game);
    expect(
      game.snapshot()?.presets.find((entry) => entry.id === 'preset-0')
        ?.party[0].learnedSkills,
    ).toEqual([]);
    expect(
      game.snapshot()?.presets.find((entry) => entry.id === 'preset-0')
        ?.createdAt,
    ).toBe(1);
    expect(game.snapshot()?.presets).toHaveLength(20);
  });
  it('構造不正の旧プリセットも画面を壊さず呼出不可の理由と削除操作を表示する', async () => {
    const { game } = await setup();
    const data = game.snapshot()!;
    data.presets = [
      {
        id: 'preset-broken',
        name: '破損構成',
        createdAt: 1,
        updatedAt: 1,
        contentVersion: 1,
        party: null as unknown as typeof data.party,
      },
    ];
    await game.update(data);
    show(game);
    click('プリセット');
    expect(
      screen.getByRole('button', { name: '破損構成を呼び出す' }),
    ).toBeDisabled();
    click('破損構成の修復を確認');
    expect(
      within(screen.getByRole('alertdialog')).getByRole('button', {
        name: '候補へ反映',
      }),
    ).toBeDisabled();
    fireEvent.click(
      within(screen.getByRole('alertdialog')).getByRole('button', {
        name: '取消',
      }),
    );
    click('破損構成を削除');
    confirm();
    await save(game);
    expect(game.snapshot()?.presets).toEqual([]);
  });
  it('旧プリセットの未所持装備は差分確認後にだけ外し、原本を保持する', async () => {
    const { game } = await setup();
    const data = game.snapshot()!;
    const party = structuredClone(data.party);
    party[0].equipment[0] = 'relic-01-01';
    data.presets.push({
      id: 'preset-old',
      name: '旧構成',
      createdAt: 1,
      updatedAt: 1,
      contentVersion: 1,
      party,
    });
    await game.update(data);
    show(game);
    click('プリセット');
    expect(
      screen.getByRole('button', { name: '旧構成を呼び出す' }),
    ).toBeDisabled();
    click('旧構成の修復を確認');
    expect(screen.getByRole('alertdialog')).toHaveTextContent('relic-01-01');
    expect(game.snapshot()?.party[0].equipment[0]).toBe('starter-sword');
    confirm();
    await save(game);
    expect(game.snapshot()?.party[0].equipment[0]).toBeNull();
    expect(game.snapshot()?.presets[0]?.party[0].equipment[0]).toBe(
      'relic-01-01',
    );
  });
});

describe('伝言板・階層ワープ', () => {
  it('ヒントと解放状態を表示し、ワープ保存後に探索現在地へ移り帰還できる', async () => {
    const { game } = await setup();
    show(game);
    click('伝言板・階層');
    expect(screen.getByText('攻略ヒント')).toBeVisible();
    expect(
      screen.getByRole('button', { name: '第2階層へワープ' }),
    ).toBeDisabled();
    click('第1階層へワープ');
    await screen.findByRole('heading', { name: '探索の再開' });
    expect(game.snapshot()?.progression.location).toEqual({
      kind: 'floor',
      floorId: 'floor-01',
      nodeId: 'floor-01-entry',
    });
    click('探索を続ける');
    click('拠点へ帰還');
    await screen.findByRole('heading', { name: '迷宮ギルド' });
    expect(game.snapshot()?.progression.location).toEqual({ kind: 'guild' });
  });
  it('ワープ保存に失敗したら拠点を維持し、再試行成功後だけ階層へ進む', async () => {
    const { game, repository } = await setup();
    show(game);
    click('伝言板・階層');
    vi.spyOn(repository, 'write').mockRejectedValueOnce(new Error('容量不足'));
    click('第1階層へワープ');
    await screen.findByRole('button', { name: '保存を再試行' });
    expect(game.snapshot()?.progression.location).toEqual({ kind: 'guild' });
    expect(
      screen.getByRole('button', { name: '第1階層へワープ' }),
    ).toBeDisabled();
    click('保存を再試行');
    await screen.findByRole('heading', { name: '探索の再開' });
    expect(game.snapshot()?.progression.location.kind).toBe('floor');
  });
  it('解放済みでも未収録の階層は理由を表示してワープを禁止する', async () => {
    const { game } = await setup();
    const data = game.snapshot()!;
    data.progression.defeatedEnemyIds = ['boss-01'];
    await game.update(data);
    show(game);
    click('伝言板・階層');
    expect(screen.getByText('解放済み・この版では未実装')).toBeVisible();
    expect(
      screen.getByRole('button', { name: '第2階層へワープ' }),
    ).toBeDisabled();
  });
});
