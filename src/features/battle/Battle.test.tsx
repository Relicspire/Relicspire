import {
  act,
  render,
  screen,
  fireEvent,
  waitFor,
} from '@testing-library/react';
import { createStore, set } from 'idb-keyval';
import { describe, it, expect, vi } from 'vitest';
import { App } from '../../app/App';
import { createGameState } from '../../state/game';
import { releaseFixture } from '../../game/data/release.fixtures.test-support';
import { attackPayload } from '../../game/battle/fixtures.test-support';
import { getInputActor } from '../../game/battle';
import { DELIVERY_KEY, SaveRepository } from '../../storage/save';
import { CommandPanel } from './CommandPanel';
import { Timeline } from './Timeline';

vi.mock('../exploration/scene', () => ({
  createExplorationScene: () => ({ update: vi.fn(), destroy: vi.fn() }),
}));
async function setup(hp = 300) {
  const release = releaseFixture();
  release.content.enemies.find((e) => e.id === 'guardian-01-01')!.stats.maxHp =
    hp;
  const store = createStore(crypto.randomUUID(), 'state');
  await set(DELIVERY_KEY, { buildId: 'test' }, store);
  const repository = new SaveRepository('test', () => true, store);
  const game = createGameState(release, repository, () => true);
  await game.load();
  await game.newGame();
  await game.warp('floor-01');
  game.dismissEntry();
  await game.move('floor-01-hall-1');
  await game.move('floor-01-alcove-1');
  await game.startBattle(game.exploration.getState().encounter!);
  return { game, repository, release };
}
const click = (name: string) =>
  fireEvent.click(screen.getByRole('button', { name }));
const show = (game: ReturnType<typeof createGameState>) =>
  render(<App game={game} recheck={() => game.load()} deliveryReady />);

describe('戦闘操作と保存の画面接続', () => {
  it('HP・ゲージ・予告・300 TUバーを表示し、選択と取消では本状態を変更しない', async () => {
    const { game } = await setup();
    show(game);
    expect(screen.getByLabelText('300 TUタイムライン')).toBeVisible();
    expect(
      screen.getByRole('progressbar', { name: '敵ブレイクゲージ' }),
    ).toHaveAttribute('max', '500');
    expect(screen.getByLabelText('敵の予告')).toHaveTextContent(
      '名称 guardian-01-01-s1',
    );
    const before = structuredClone(game.battle.getState().session);
    click('通常攻撃');
    expect(screen.getByText('この行動の結果')).toBeVisible();
    expect(screen.getByLabelText('対象')).toHaveValue('guardian-01-01');
    expect(game.battle.getState().session).toEqual(before);
    click('選択を取り消す');
    expect(game.battle.getState().session).toEqual(before);
    click('通常攻撃');
    click('コマンドを確定');
    await waitFor(() =>
      expect(getInputActor(game.battle.getState().session!)).toBe('party-2'),
    );
    expect(game.battle.getState().changes.some((c) => c.gauge === -5)).toBe(
      true,
    );
  });
  it('戦闘前保存を保ちながら逃走し、探索復帰と同編成リトライを選べる', async () => {
    const { game, repository } = await setup();
    const saved = await repository.read();
    const initial = structuredClone(game.battle.getState().session);
    show(game);
    click('逃走');
    click('戦闘を続ける');
    expect(game.battle.getState().session).toEqual(initial);
    click('逃走');
    click('逃走を確定');
    expect(screen.getByLabelText('戦闘結果')).toHaveTextContent('逃走');
    click('同じ編成でリトライ');
    await waitFor(() =>
      expect(game.battle.getState().session?.state.result).toBe('ongoing'),
    );
    expect(game.battle.getState().session?.state).toEqual(initial?.state);
    expect(await repository.read()).toEqual(saved);
    click('逃走');
    click('逃走を確定');
    click('探索へ戻る');
    await screen.findByRole('heading', { name: '探索の再開' });
    expect(game.snapshot()?.progression.location).toHaveProperty(
      'nodeId',
      'floor-01-hall-1',
    );
  });
  it('勝利保存中は次操作を禁止し、成功後に報酬を表示して討伐部屋へ進む', async () => {
    const { game, repository } = await setup(1);
    let releaseWrite!: () => void;
    const gate = new Promise<void>((r) => {
      releaseWrite = r;
    });
    const write = repository.write.bind(repository);
    vi.spyOn(repository, 'write').mockImplementationOnce(async (...args) => {
      await gate;
      await write(...args);
    });
    show(game);
    click('通常攻撃');
    click('コマンドを確定');
    await screen.findByText('勝利報酬を保存中…次の操作はお待ちください。');
    expect(game.snapshot()?.progression.defeatedEnemyIds).toEqual([]);
    expect(game.snapshot()?.progression.location).toHaveProperty(
      'nodeId',
      'floor-01-hall-1',
    );
    expect(screen.getByRole('button', { name: '設定' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'コマンドを確定' })).toBeNull();
    await act(async () => {
      releaseWrite();
    });
    await screen.findByRole('heading', { name: '勝利報酬を保存しました' });
    expect(game.snapshot()?.progression.defeatedEnemyIds).toEqual([
      'guardian-01-01',
    ]);
    click('探索を続ける');
    expect(screen.getByLabelText('迷宮探索')).toHaveTextContent(
      '現在地：守護者の間 1',
    );
  });
  it('勝利保存失敗は未確定を維持し、再試行で報酬を一度だけ確定する', async () => {
    const { game, repository } = await setup(1);
    vi.spyOn(repository, 'write').mockRejectedValueOnce(new Error('容量不足'));
    show(game);
    click('通常攻撃');
    click('コマンドを確定');
    await screen.findByRole('button', { name: '保存を再試行' });
    expect(screen.getByLabelText('戦闘結果')).toHaveTextContent('未保存');
    expect(game.snapshot()?.progression.defeatedEnemyIds).toEqual([]);
    click('保存を再試行');
    await screen.findByRole('heading', { name: '勝利報酬を保存しました' });
    expect(game.snapshot()?.progression.defeatedEnemyIds).toEqual([
      'guardian-01-01',
    ]);
    await act(() => game.load());
    expect(game.battle.getState().receipt).toBeNull();
    expect(game.snapshot()?.progression.defeatedEnemyIds).toEqual([
      'guardian-01-01',
    ]);
  });
  it('未保存勝利の放棄は確認を経て親分岐へ戻り、報酬を付与しない', async () => {
    const { game, repository } = await setup(1);
    vi.spyOn(repository, 'write').mockRejectedValueOnce(new Error('容量不足'));
    show(game);
    click('通常攻撃');
    click('コマンドを確定');
    await screen.findByRole('button', { name: '変更・未保存の勝利を取り消す' });
    click('変更・未保存の勝利を取り消す');
    expect(screen.getByRole('alertdialog')).toHaveTextContent('勝利報酬を放棄');
    expect(game.battle.getState().session?.state.result).toBe('victory');
    click('確定');
    await screen.findByRole('heading', { name: '探索の再開' });
    expect(game.snapshot()?.progression.defeatedEnemyIds).toEqual([]);
    expect(game.exploration.getState().encounter).toBeNull();
    expect(game.snapshot()?.progression.location).toHaveProperty(
      'nodeId',
      'floor-01-hall-1',
    );
  });
  it('休止中は入力・進行を止め、設定画面から戻っても手動休止を保つ', async () => {
    const { game } = await setup();
    show(game);
    click('戦闘を一時停止');
    const before = structuredClone(game.battle.getState().session);
    expect(screen.getByRole('button', { name: '通常攻撃' })).toBeDisabled();
    click('設定');
    click('現在地');
    expect(screen.getByRole('button', { name: '戦闘を再開' })).toBeVisible();
    expect(game.battle.getState().session).toEqual(before);
    click('戦闘を再開');
    expect(screen.getByRole('button', { name: '通常攻撃' })).toBeEnabled();
  });
  it('敗北画面から拠点へ帰還し、開始前の編成と設定を保持して帰還位置だけ保存する', async () => {
    const { game } = await setup();
    const before = game.snapshot()!;
    const session = structuredClone(game.battle.getState().session!);
    session.state.result = 'defeat';
    game.battle.setState({ session });
    show(game);
    click('拠点へ帰還');
    await screen.findByRole('heading', { name: '迷宮ギルド' });
    expect(game.snapshot()?.progression.location).toEqual({ kind: 'guild' });
    expect(game.snapshot()?.party).toEqual(before.party);
    expect(game.snapshot()?.settings).toEqual(before.settings);
    expect(game.snapshot()?.progression.defeatedEnemyIds).toEqual([]);
  });
  it('戻るキーで戦闘を休止し、続行・同編成リトライ・逃走を確認できる', async () => {
    const { game } = await setup();
    show(game);
    const before = structuredClone(game.battle.getState().session);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.getByRole('alertdialog')).toHaveAccessibleName(
      '戦闘を離れる',
    );
    expect(game.battle.getState().paused).toBe(true);
    click('戦闘を続ける');
    expect(game.battle.getState().session).toEqual(before);
    expect(game.battle.getState().paused).toBe(false);
    fireEvent.keyDown(window, { altKey: true, key: 'ArrowLeft' });
    click('同じ編成でリトライ');
    await waitFor(() =>
      expect(game.battle.getState().exitRequested).toBe(false),
    );
    expect(game.battle.getState().session?.state).toEqual(before?.state);
    fireEvent(window, new PopStateEvent('popstate'));
    click('逃走して探索へ戻る');
    await screen.findByRole('heading', { name: '探索の再開' });
    expect(game.snapshot()?.progression.location).toHaveProperty(
      'nodeId',
      'floor-01-hall-1',
    );
  });
  it('画面非表示で進行を止め、表示復帰後も再開入力まで停止を保つ', async () => {
    const { game } = await setup();
    vi.useFakeTimers();
    const descriptor = Object.getOwnPropertyDescriptor(
      document,
      'visibilityState',
    );
    try {
      show(game);
      click('通常攻撃');
      click('コマンドを確定');
      const before = structuredClone(game.battle.getState().session);
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        value: 'hidden',
      });
      fireEvent(document, new Event('visibilitychange'));
      await act(() => vi.advanceTimersByTimeAsync(2000));
      expect(game.battle.getState().session).toEqual(before);
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        value: 'visible',
      });
      fireEvent(document, new Event('visibilitychange'));
      await act(() => vi.advanceTimersByTimeAsync(2000));
      expect(game.battle.getState().session).toEqual(before);
      click('再開');
      await act(() => vi.advanceTimersByTimeAsync(550));
      expect(getInputActor(game.battle.getState().session!)).toBe('party-2');
    } finally {
      if (descriptor)
        Object.defineProperty(document, 'visibilityState', descriptor);
      else Reflect.deleteProperty(document, 'visibilityState');
      vi.useRealTimers();
    }
  });
  it('自動進行中に休止・所有権喪失した場合は古い進行コールを拒否する', async () => {
    const { game } = await setup();
    const session = game.battle.getState().session!;
    game.pauseBattle(true);
    expect(() => game.advance(session)).toThrow('現在は戦闘');
    game.pauseBattle(false);
    game.command(
      {
        actorId: 'party-1',
        skillId: 'wait',
        selectedTargetId: null,
        chosenElement: null,
      },
      session,
    );
    expect(() => game.advance(session)).toThrow('現在は戦闘');
    const current = game.battle.getState().session!;
    game.stopForOwnershipLoss();
    expect(() => game.advance(current)).toThrow('現在は戦闘');
  });
  it('敗北時は報酬を付与せず同じ編成と親分岐を復元する', async () => {
    const { game } = await setup();
    const original = game.snapshot();
    const session = structuredClone(game.battle.getState().session!);
    session.state.result = 'defeat';
    session.state.participants.slice(0, 3).forEach((p) => {
      p.hp = 0;
      p.action = { kind: 'dead' };
    });
    game.battle.setState({ session });
    show(game);
    expect(screen.getByLabelText('戦闘結果')).toHaveTextContent('敗北');
    click('同じ編成でリトライ');
    await waitFor(() =>
      expect(game.battle.getState().session?.state.result).toBe('ongoing'),
    );
    expect(game.snapshot()).toEqual(original);
    expect(
      game.battle
        .getState()
        .session?.state.participants.slice(0, 3)
        .every((p) => p.hp === p.stats.maxHp),
    ).toBe(true);
  });
});

describe('戦闘詳細の表示境界', () => {
  it('300 TU超を左端に集約し、同着の縦位置・凍結した詠唱・復帰参考値を表示する', async () => {
    const { game, release } = await setup();
    const session = structuredClone(game.battle.getState().session!);
    const now = session.state.now;
    session.state.participants[0]!.action = {
      kind: 'waiting',
      ready: { kind: 'running', at: now + 400 },
    };
    session.state.participants[1]!.action = {
      kind: 'casting',
      cast: {
        command: {
          skillId: 'wizard-a2',
          selectedTargetId: null,
          chosenElement: null,
        },
        completes: { kind: 'frozen', remaining: 90 },
      },
    };
    session.state.participants[1]!.timeStopUntil = now + 400;
    session.state.participants[3]!.action = {
      kind: 'broken',
      break: { recovers: { kind: 'running', at: now + 400 } },
    };
    render(<Timeline session={session} release={release} />);
    const a = screen.getByRole('button', {
      name: '名称 party-1 次の手番 400 TU',
    });
    const b = screen.getByRole('button', {
      name: '名称 party-2 停止解除 400 TU',
    });
    expect(a).toHaveStyle({ left: '0%', top: '0px' });
    expect(b).toHaveStyle({ left: '0%', top: '58px' });
    fireEvent.click(b);
    expect(screen.getByRole('status')).toHaveTextContent('凍結残り 90 TU');
    fireEvent.click(screen.getByText('行動順・予定の詳細'));
    expect(screen.getByText(/復帰後の待機参考値/)).toBeVisible();
  });
  it('詠唱・属性選択の予測は期限警告と参考値を表示し、選択の変更で本状態を変えない', async () => {
    const { game, release } = await setup();
    const session = structuredClone(game.battle.getState().session!);
    const skill = session.content.skills.find((s) => s.id === 'knight-a2')!;
    skill.target = 'enemy-single';
    skill.castTime = 40;
    skill.elementChoices = ['fire', 'ice'];
    skill.effects = [
      {
        kind: 'attack',
        target: 'selected',
        ...attackPayload({ element: 'chosen' }),
        attached: [],
      },
    ];
    release.content = session.content;
    session.state.participants[0]!.statuses.push({
      id: 999,
      sourceId: 'party-1',
      sequence: 999,
      spec: { familyId: 'atk-up', magnitude: 2000 },
      dispellable: true,
      expires: { kind: 'running', at: session.state.now + 20 },
      nextTick: null,
      remainingCharges: null,
    });
    const before = structuredClone(session);
    const onCommand = vi.fn();
    render(
      <CommandPanel
        session={session}
        actorId="party-1"
        release={release}
        disabled={false}
        onCommand={onCommand}
      />,
    );
    click('名称 knight-a2');
    expect(screen.getByText('詠唱予約と現在の状態での参考値')).toBeVisible();
    expect(screen.getByText(/発動予定前に期限切れ/)).toBeVisible();
    expect(screen.getByText('現在発動した場合の参考結果')).toBeVisible();
    fireEvent.change(screen.getByLabelText('属性'), {
      target: { value: 'ice' },
    });
    expect(session).toEqual(before);
    click('コマンドを確定');
    expect(onCommand).toHaveBeenCalledWith({
      actorId: 'party-1',
      skillId: 'knight-a2',
      selectedTargetId: 'guardian-01-01',
      chosenElement: 'ice',
    });
  });
  it('CD中と対象なしのコマンドを選択不可にし、実効果の不成立理由を表示する', async () => {
    const { game, release } = await setup();
    const session = structuredClone(game.battle.getState().session!);
    const actor = session.state.participants[0]!;
    actor.cooldowns.push({
      id: 'knight-a',
      timer: { kind: 'running', at: session.state.now + 120 },
    });
    const skill = session.content.skills.find((s) => s.id === 'knight-a2')!;
    skill.target = 'dead-ally-other';
    render(
      <CommandPanel
        session={session}
        actorId="party-1"
        release={release}
        disabled={false}
        onCommand={vi.fn()}
      />,
    );
    expect(
      screen.getByRole('button', { name: '名称 knight-a2' }),
    ).toBeDisabled();
    expect(screen.getByText('クールダウン中です')).toBeVisible();
    expect(screen.getByText('D 90 TU ／ CD残り 120 TU')).toBeVisible();
  });
  it('蘇生対象がいないコマンドを選択不可にして対象なしの理由を示す', async () => {
    const { game, release } = await setup();
    const session = structuredClone(game.battle.getState().session!);
    session.content.skills.find((s) => s.id === 'knight-a2')!.target =
      'dead-ally-other';
    render(
      <CommandPanel
        session={session}
        actorId="party-1"
        release={release}
        disabled={false}
        onCommand={vi.fn()}
      />,
    );
    expect(
      screen.getByRole('button', { name: '名称 knight-a2' }),
    ).toBeDisabled();
    expect(screen.getByText('有効な対象がありません')).toBeVisible();
  });
  it('演出スキップと速度の違いでも同じ入力列でTU・HP・CD・ログが一致する', async () => {
    const results = [];
    for (const configuration of [
      { animationSpeed: 0.5, skipBattleAnimations: false },
      { animationSpeed: 2, skipBattleAnimations: true },
    ] as const) {
      const { game } = await setup();
      const data = game.snapshot()!;
      Object.assign(data.settings, configuration);
      await game.update(data);
      const view = show(game);
      click('通常攻撃');
      click('コマンドを確定');
      await waitFor(
        () =>
          expect(getInputActor(game.battle.getState().session!)).toBe(
            'party-2',
          ),
        { timeout: 2500 },
      );
      results.push(structuredClone(game.battle.getState().session!));
      view.unmount();
    }
    expect(results[0]!.state).toEqual(results[1]!.state);
    expect(results[0]!.log).toEqual(results[1]!.log);
  });
});
