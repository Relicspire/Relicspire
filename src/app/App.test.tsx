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
import { App } from './App';
import { createGameState } from '../state/game';
import { DEFAULT_SETTINGS } from '../state/save-model';
import input from '../content/release.json';
import { parseGameRelease } from '../game/data/release';
import { DELIVERY_KEY, SAVE_KEY, SaveRepository } from '../storage/save';

async function setup(ready = true) {
  const store = createStore(`ui-${crypto.randomUUID()}`, 'state');
  const repository = new SaveRepository('ui-test', () => true, store);
  await set(DELIVERY_KEY, { buildId: 'ui-test' }, store);
  const game = createGameState(parseGameRelease(input), repository, () => true);
  await game.load();
  if (ready) await game.newGame();
  return { game, repository, store };
}
function show(
  game: Awaited<ReturnType<typeof setup>>['game'],
  deliveryReady = true,
) {
  return render(
    <App game={game} recheck={game.load} deliveryReady={deliveryReady} />,
  );
}

describe('共通UIの起動と保存', () => {
  it('正式データがない起動では準備待ちを案内して開始を提供しない', () => {
    render(<App />);
    expect(
      screen.getByRole('heading', { name: 'Relicspire', level: 1 }),
    ).toBeVisible();
    expect(screen.getByText('第1階層 MVP · 開発中')).toBeVisible();
    expect(
      screen.queryByRole('button', { name: '冒険を始める' }),
    ).not.toBeInTheDocument();
  });
  it('配信未準備では初回開始を禁止し、準備済みなら保存して拠点を表示する', async () => {
    const { game } = await setup(false);
    const view = show(game, false);
    expect(screen.getByRole('button', { name: '冒険を始める' })).toBeDisabled();
    view.rerender(<App game={game} recheck={game.load} deliveryReady />);
    fireEvent.click(screen.getByRole('button', { name: '冒険を始める' }));
    await screen.findByRole('heading', { name: '迷宮ギルド' });
    expect(game.snapshot()?.settings).toEqual(DEFAULT_SETTINGS);
  });
  it('設定の編集だけでは保存せず、確定した音量を再読込後も保持する', async () => {
    const { game } = await setup();
    show(game);
    fireEvent.click(screen.getByRole('button', { name: '設定' }));
    fireEvent.change(screen.getByRole('slider', { name: /総音量/ }), {
      target: { value: '25' },
    });
    expect(game.snapshot()?.settings.masterVolume).toBe(80);
    fireEvent.click(screen.getByRole('button', { name: '設定を保存' }));
    await screen.findByText('設定を保存しました。');
    await act(() => game.load());
    expect(game.settings.getState().value?.masterVolume).toBe(25);
  });
  it('設定の取消は確認を表示し、破棄すると確定済みの音量を維持する', async () => {
    const { game } = await setup();
    show(game);
    fireEvent.click(screen.getByRole('button', { name: '設定' }));
    fireEvent.change(screen.getByRole('slider', { name: /総音量/ }), {
      target: { value: '0' },
    });
    fireEvent.click(screen.getByRole('button', { name: '戻る' }));
    expect(screen.getByRole('alertdialog')).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: '変更を破棄して戻る' }));
    expect(game.snapshot()?.settings.masterVolume).toBe(80);
    expect(screen.getByRole('heading', { name: '迷宮ギルド' })).toBeVisible();
  });
  it('容量不足で設定保存が失敗したら確定値を保持し同じ候補を再試行できる', async () => {
    const { game, repository } = await setup();
    show(game);
    vi.spyOn(repository, 'write').mockRejectedValueOnce(
      new DOMException('容量不足', 'QuotaExceededError'),
    );
    fireEvent.click(screen.getByRole('button', { name: '設定' }));
    fireEvent.change(screen.getByRole('slider', { name: /総音量/ }), {
      target: { value: '12' },
    });
    fireEvent.click(screen.getByRole('button', { name: '設定を保存' }));
    await screen.findByRole('button', { name: '保存を再試行' });
    expect(game.settings.getState().value?.masterVolume).toBe(80);
    fireEvent.click(screen.getByRole('button', { name: '保存を再試行' }));
    await waitFor(() =>
      expect(game.settings.getState().value?.masterVolume).toBe(12),
    );
  });
  it('未来版セーブは新版への案内と書き出しを表示し上書き操作を出さない', async () => {
    const { game, repository, store } = await setup();
    const raw = (await repository.read()) as {
      current: { contentVersion: number };
    };
    raw.current.contentVersion = 999;
    await set(SAVE_KEY, raw, store);
    await game.load();
    show(game);
    expect(screen.getByRole('alert')).toHaveTextContent('新版');
    expect(
      screen.getByRole('button', { name: 'current／previousをJSON書き出し' }),
    ).toBeEnabled();
    expect(
      screen.queryByRole('button', { name: '新規開始' }),
    ).not.toBeInTheDocument();
  });
  it('previousの復元は巻き戻り確認後だけ保存し、Escapeで確認を閉じられる', async () => {
    const { game } = await setup();
    const data = game.snapshot()!;
    await game.update({ ...data, settings: { ...data.settings, muted: true } });
    show(game);
    fireEvent.click(screen.getByRole('button', { name: '直前のセーブへ復元' }));
    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveTextContent('巻き戻します');
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(game.snapshot()?.settings.muted).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '直前のセーブへ復元' }));
    fireEvent.click(
      within(screen.getByRole('alertdialog')).getByRole('button', {
        name: '確定',
      }),
    );
    await waitFor(() => expect(game.snapshot()?.settings.muted).toBe(false));
  });
  it('非表示から戻っても設定操作を休止し、再開ボタンで操作を許可する', async () => {
    const { game } = await setup();
    show(game);
    const spy = vi.spyOn(document, 'visibilityState', 'get');
    spy.mockReturnValue('hidden');
    fireEvent(document, new Event('visibilitychange'));
    expect(screen.getByRole('button', { name: '設定' })).toBeDisabled();
    spy.mockReturnValue('visible');
    fireEvent(document, new Event('visibilitychange'));
    expect(screen.getByRole('button', { name: '設定' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '再開' }));
    expect(screen.getByRole('button', { name: '設定' })).toBeEnabled();
    spy.mockRestore();
  });
  it('設定破損の差分を確認するまで原本を保持し、確定後に既定値へ修復する', async () => {
    const { game, repository, store } = await setup();
    const raw = (await repository.read()) as {
      current: { data: { settings: { masterVolume: number } } };
    };
    raw.current.data.settings.masterVolume = -1;
    await set(SAVE_KEY, raw, store);
    await game.load();
    show(game);
    expect(screen.getByText('不正・欠落した設定を既定値へ修復')).toBeVisible();
    expect(await repository.read()).toEqual(raw);
    fireEvent.click(
      screen.getByRole('button', { name: '差分を確認して修復・移行を保存' }),
    );
    await waitFor(() =>
      expect(game.settings.getState().value?.masterVolume).toBe(80),
    );
  });
  it('保存処理が完了するまでは共通メニューと新規開始を禁止する', async () => {
    const { game, repository } = await setup();
    show(game);
    const originalWrite = repository.write.bind(repository);
    let finish: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    vi.spyOn(repository, 'write').mockImplementation(
      async (expected, candidate) => {
        await gate;
        await originalWrite(expected, candidate);
      },
    );
    let operation: Promise<void>;
    act(() => {
      operation = game.update(game.snapshot()!);
    });
    expect(screen.getByRole('button', { name: '設定' })).toBeDisabled();
    expect(
      screen.queryByRole('button', { name: '新規開始' }),
    ).not.toBeInTheDocument();
    await act(async () => {
      finish();
      await operation;
    });
    expect(screen.getByRole('button', { name: '設定' })).toBeEnabled();
  });
  it('所有権喪失で操作を停止し最新セーブの再確認を提示する', async () => {
    const { game } = await setup();
    show(game);
    act(() => game.stopForOwnershipLoss());
    expect(screen.getByRole('button', { name: '設定' })).toBeDisabled();
    expect(
      screen.getByRole('button', { name: '再確認・読み直し' }),
    ).toBeEnabled();
  });
});

describe('正式第1階層での復旧操作', () => {
  it('S08: 予算超過の差分確認後にだけ本人のスキルを全解除して保存する', async () => {
    const { game, repository, store } = await setup();
    const raw = (await repository.read()) as {
      current: { data: { party: { learnedSkills: string[] }[] } };
    };
    raw.current.data.party[0]!.learnedSkills.push('knight-a3');
    await set(SAVE_KEY, raw, store);
    await game.load();
    show(game);
    expect(
      screen.getByRole('button', { name: '差分を確認して修復・移行を保存' }),
    ).toBeEnabled();
    expect(await repository.read()).toEqual(raw);
    fireEvent.click(
      screen.getByRole('button', { name: '差分を確認して修復・移行を保存' }),
    );
    await waitFor(() => expect(game.status.getState().value).toBe('ready'));
    expect(game.snapshot()!.party[0].learnedSkills).toEqual([]);
    expect(game.snapshot()!.party[1].learnedSkills).toEqual([
      'wizard-a1',
      'wizard-a2',
    ]);
  });
  it('S11: 新規開始の保存失敗では旧セーブを保持し、同じ候補の再試行で開始する', async () => {
    const { game, repository } = await setup();
    show(game);
    const before = await repository.read();
    vi.spyOn(repository, 'write').mockRejectedValueOnce(new Error('容量不足'));
    fireEvent.click(screen.getByRole('button', { name: '新規開始' }));
    fireEvent.click(
      within(screen.getByRole('alertdialog')).getByRole('button', {
        name: '確定',
      }),
    );
    await screen.findByRole('button', { name: '保存を再試行' });
    expect(await repository.read()).toEqual(before);
    fireEvent.click(
      within(screen.getByRole('alertdialog')).getByRole('button', {
        name: '戻る',
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: '保存を再試行' }));
    await waitFor(() => expect(game.status.getState().value).toBe('ready'));
    expect(await repository.read()).not.toEqual(before);
    expect(game.snapshot()!.progression.defeatedEnemyIds).toEqual([]);
  });
});
