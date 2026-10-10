import { createStore, set } from 'idb-keyval';
import { describe, expect, it, vi } from 'vitest';
import input from '../content/release.json';
import { parseGameRelease } from '../game/data/release';
import { releaseFixture } from '../game/data/release.fixtures.test-support';
import { recallPreset } from '../game/party';
import { deriveProgression, selectNode } from '../game/progression';
import type { EnemyId, FloorId, NodeId } from '../game/data/model';
import {
  DELIVERY_KEY,
  SAVE_KEY,
  SaveRepository,
  type SaveEnvelope,
} from '../storage/save';
import { createGameState } from './game';
import { initialSave, type SaveData } from './save-model';

/** 正式第1階層（最終階層のみ合成）と実IndexedDB APIで保存境界を検証する。戦闘の勝敗計算自体はエンジンテストが担当する。 */
async function source(final = false) {
  const release = final ? releaseFixture(10) : parseGameRelease(input);
  const store = createStore(`contracts-${crypto.randomUUID()}`, 'state');
  await set(DELIVERY_KEY, { buildId: 'test' }, store);
  const repository = new SaveRepository('test', () => true, store);
  const game = createGameState(release, repository, () => true);
  await game.load();
  await game.newGame();
  const data = initialSave(release);
  const floorId: FloorId = final ? 'floor-10' : 'floor-01';
  data.progression.location = {
    kind: 'floor',
    floorId,
    nodeId: `${floorId}-hall-1` as NodeId,
  };
  data.progression.visitedFloorIds = [floorId];
  if (final) {
    data.progression.defeatedEnemyIds = Array.from(
      { length: 9 },
      (_, i) => `boss-${String(i + 1).padStart(2, '0')}` as EnemyId,
    );
    data.progression.location.nodeId = 'floor-10-hall-3';
  }
  await game.update(data);
  const room: NodeId = final ? 'floor-10-boss' : 'floor-01-alcove-1';
  const selected = selectNode(release, data.progression, room);
  if (!selected.ok || !selected.value.encounter)
    throw new Error('遭遇候補がありません');
  const encounter = selected.value.encounter;
  await game.startBattle(encounter);
  const win = () => {
    const session = structuredClone(game.battle.getState().session!);
    session.state.result = 'victory';
    game.battle.setState({ session });
  };
  const reboot = async () => {
    const next = createGameState(release, repository, () => true);
    await next.load();
    return next;
  };
  return { release, store, repository, game, data, encounter, win, reboot };
}

describe('保存・復旧仕様の未検証境界', () => {
  it('S04: 守護者の勝利保存後に再起動すると遺物1個・討伐部屋が復元される', async () => {
    const { game, release, win, reboot, encounter } = await source();
    win();
    await game.victory();
    const next = await reboot();
    const progression = next.progression.getState().value!;
    expect(progression.defeatedEnemyIds).toEqual(['guardian-01-01']);
    expect(progression.location).toEqual(encounter.room);
    expect(
      deriveProgression(release.campaign, progression).inventory.get(
        'relic-01-01',
      ),
    ).toBe(1);
    expect(next.battle.getState().session).toBeNull();
  });
  it.each([false, true])(
    'S05: 勝利保存失敗後の再起動で実際の確定状態（保存済み=%s）だけを復元する',
    async (saved) => {
      const { game, repository, store, win, reboot, encounter, release } =
        await source();
      win();
      vi.spyOn(repository, 'write').mockImplementation(
        async (_expected, candidate) => {
          if (saved) await set(SAVE_KEY, candidate, store);
          throw new Error('応答失敗');
        },
      );
      await expect(game.victory()).rejects.toThrow('応答失敗');
      const next = await reboot();
      const progression = next.progression.getState().value!;
      expect(progression.location).toEqual(
        saved ? encounter.room : encounter.parent,
      );
      expect(progression.defeatedEnemyIds).toEqual(
        saved ? ['guardian-01-01'] : [],
      );
      expect(
        deriveProgression(release.campaign, progression).inventory.get(
          'relic-01-01',
        ),
      ).toBe(saved ? 1 : 0);
    },
  );
  it('S08: 現編成の予算超過は確認後に全解除し、旧プリセットは保持して呼出拒否する', async () => {
    const { game, repository, store, release } = await source();
    const raw = (await repository.read()) as SaveEnvelope<SaveData>;
    raw.current.data.party[0].learnedSkills.push('knight-a3');
    const preset = {
      id: 'preset-over-budget' as const,
      name: '旧編成',
      createdAt: 1,
      updatedAt: 1,
      contentVersion: release.contentVersion,
      party: structuredClone(raw.current.data.party),
    };
    raw.current.data.presets = [preset];
    await set(SAVE_KEY, raw, store);
    await game.load();
    expect(game.status.getState().value).toBe('recovery');
    expect(
      game.status.getState().changes.some((c) => c.includes('全解除')),
    ).toBe(true);
    expect(await repository.read()).toEqual(raw);
    await game.repair();
    const restored = game.formation.getState().value!;
    expect(restored.party[0].learnedSkills).toEqual([]);
    expect(restored.party.slice(1)).toEqual(raw.current.data.party.slice(1));
    expect(restored.presets).toEqual([preset]);
    expect(
      recallPreset(
        release.content,
        restored,
        preset.id,
        { defeatedEnemyIds: [], inBattle: false },
        { repair: true },
      ).ok,
    ).toBe(false);
    const saved = (await repository.read()) as SaveEnvelope<SaveData>;
    expect(saved.previous).toEqual(raw.current);
  });
  it('S09: 最終勝利後の再起動でクリア済み・未処理エンディング・拠点を復元する', async () => {
    const { game, release, win, reboot } = await source(true);
    win();
    await game.victory();
    const next = await reboot();
    const progression = next.progression.getState().value!;
    expect(progression.location).toEqual({ kind: 'guild' });
    expect(progression.endingHandled).toBe(false);
    expect(
      progression.defeatedEnemyIds.filter((id) => id === 'boss-10'),
    ).toHaveLength(1);
    expect(deriveProgression(release.campaign, progression).finalClear).toBe(
      true,
    );
    expect(
      deriveProgression(release.campaign, progression).skillPointLimit,
    ).toBe(12);
    await expect(next.victory()).rejects.toThrow('勝利が成立していません');
  });
  it.each(['retry', 'cancel'] as const)(
    'S10: スキップ保存失敗時は結末未確定を保持し、%sで正しい状態へ戻る',
    async (action) => {
      const { game, repository, win, reboot } = await source(true);
      win();
      await game.victory();
      const original = (await repository.read()) as SaveEnvelope<SaveData>;
      const skipped = structuredClone(original.current.data);
      skipped.progression.endingHandled = true;
      const failure = vi
        .spyOn(repository, 'write')
        .mockRejectedValue(new Error('容量不足'));
      await expect(game.update(skipped)).rejects.toThrow('容量不足');
      expect(game.progression.getState().value?.endingHandled).toBe(false);
      expect(await repository.read()).toEqual(original);
      failure.mockRestore();
      await game[action]();
      const next = await reboot();
      expect(next.progression.getState().value?.endingHandled).toBe(
        action === 'retry',
      );
      expect(next.progression.getState().value?.location).toEqual({
        kind: 'guild',
      });
      expect(next.progression.getState().value?.defeatedEnemyIds).toEqual(
        original.current.data.progression.defeatedEnemyIds,
      );
    },
  );
  it('S12: 戦闘中の設定保存後に同編成リトライしても最新設定とrevisionを保持する', async () => {
    const { game, repository, data } = await source();
    const initialState = structuredClone(game.battle.getState().session!.state);
    const changed = structuredClone(data);
    changed.settings.masterVolume = 17;
    await game.update(changed);
    const original = await repository.read();
    await game.retryBattle();
    expect(game.battle.getState().before?.party).toEqual(data.party);
    expect(game.battle.getState().before?.settings.masterVolume).toBe(17);
    expect(game.battle.getState().session?.state).toEqual(initialState);
    expect(await repository.read()).toEqual(original);
  });
  it.each(['encounter', 'battle', 'defeat'] as const)(
    'S02: %sで再起動すると親分岐・未討伐・戦闘なしへ戻る',
    async (phase) => {
      const { game, reboot, encounter } = await source();
      const initialState = structuredClone(
        game.battle.getState().session!.state,
      );
      if (phase === 'encounter') await game.leaveBattle();
      if (phase === 'defeat') {
        const session = structuredClone(game.battle.getState().session!);
        session.state.result = 'defeat';
        game.battle.setState({ session });
      }
      const next = await reboot();
      expect(next.progression.getState().value?.location).toEqual(
        encounter.parent,
      );
      expect(next.progression.getState().value?.defeatedEnemyIds).toEqual([]);
      expect(next.battle.getState().session).toBeNull();
      await next.startBattle(encounter);
      expect(next.battle.getState().session?.state).toEqual(initialState);
    },
  );
  it('S06: 非所有タブは読取専用となり、古い戦闘結果のrevision競合でも上書きしない', async () => {
    const { game, repository, store, release, win } = await source();
    const observerRepository = new SaveRepository('test', () => false, store);
    const observer = createGameState(release, observerRepository, () => false);
    await observer.load();
    expect(observer.status.getState().value).toBe('readonly');
    await expect(observer.newGame()).rejects.toThrow();
    const newer = (await repository.read()) as SaveEnvelope<SaveData>;
    newer.current.revision++;
    newer.current.data.settings.muted = true;
    await set(SAVE_KEY, newer, store);
    win();
    await expect(game.victory()).rejects.toThrow();
    expect(game.status.getState().value).toBe('readonly');
    expect(game.battle.getState().session).toBeNull();
    expect(await repository.read()).toEqual(newer);
  });
  it('S11: 進行・プリセット・設定を持つセーブの新規開始失敗でも旧包を保持する', async () => {
    const { game, repository, data, release } = await source();
    await game.leaveBattle();
    data.settings.muted = true;
    data.presets = [
      {
        id: 'preset-kept',
        name: '保持する編成',
        createdAt: 1,
        updatedAt: 1,
        contentVersion: release.contentVersion,
        party: structuredClone(data.party),
      },
    ];
    await game.update(data);
    const original = await repository.read();
    vi.spyOn(repository, 'write').mockRejectedValue(new Error('容量不足'));
    await expect(game.newGame()).rejects.toThrow('容量不足');
    expect(await repository.read()).toEqual(original);
    expect(game.persisted.getState().data).toEqual(data);
    await game.cancel();
    expect(game.formation.getState().value?.presets).toEqual(data.presets);
    expect(game.progression.getState().value).toEqual(data.progression);
  });
});
