import { createStore as createIDBStore, set, get } from 'idb-keyval';
import { describe, expect, it, vi } from 'vitest';
import { releaseFixture } from '../game/data/release.fixtures.test-support';
import {
  DELIVERY_KEY,
  SAVE_KEY,
  SaveConflict,
  SaveRepository,
  type SaveEnvelope,
} from '../storage/save';
import {
  selectNode,
  warpToFloor,
  createInitialProgression,
  deriveProgression,
} from '../game/progression';
import { createGameState } from './game';
import { initialSave, inspectSave, type SaveData } from './save-model';

async function setup() {
  const release = releaseFixture();
  const store = createIDBStore(`save-test-${crypto.randomUUID()}`, 'state');
  await set(DELIVERY_KEY, { buildId: 'test' }, store);
  let owner = true;
  const repository = new SaveRepository('test', () => owner, store);
  const game = createGameState(release, repository, () => owner);
  await game.load();
  return {
    release,
    store,
    repository,
    game,
    loseOwnership: () => {
      owner = false;
    },
  };
}

describe('保存管理と復旧', () => {
  it('初回起動で自動初期化せず、新規開始後の編成と設定を再読込する', async () => {
    const { game, repository, release } = await setup();
    expect(game.status.getState().value).toBe('empty');
    expect(await repository.read()).toBeUndefined();
    await game.newGame();
    const data = initialSave(release);
    data.settings.muted = true;
    await game.update(data);
    const raw = (await repository.read()) as SaveEnvelope<SaveData>;
    expect(raw.current.revision).toBe(2);
    expect((raw.previous as SaveEnvelope<SaveData>['current']).revision).toBe(
      1,
    );
    expect(Object.keys(raw.current.data)).toEqual([
      'party',
      'presets',
      'progression',
      'settings',
    ]);
    await game.load();
    expect(game.persisted.getState().data?.settings.muted).toBe(true);
    expect(game.formation.getState().value?.party).toEqual(data.party);
  });
  it('期待revisionが古い同時書込を拒否して確定セーブを保持する', async () => {
    const { game, repository, release } = await setup();
    await game.newGame();
    const expected = (await repository.read()) as SaveEnvelope<SaveData>;
    const a = structuredClone(expected);
    a.current.revision++;
    a.current.data.settings.muted = true;
    const b = structuredClone(a);
    b.current.data = initialSave(release);
    const results = await Promise.allSettled([
      repository.write(expected, a),
      repository.write(expected, b),
    ]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected']);
    expect(await repository.read()).toEqual(a);
  });
  it('配信buildId不一致では旧版の保存を拒否する', async () => {
    const { game, repository, store } = await setup();
    await game.newGame();
    const expected = (await repository.read()) as SaveEnvelope<SaveData>;
    await set(DELIVERY_KEY, { buildId: 'new' }, store);
    await expect(repository.write(expected, expected)).rejects.toBeInstanceOf(
      SaveConflict,
    );
    expect(await repository.read()).toEqual(expected);
  });
  it('S11: 容量不足の新規開始で旧saveId・進行・プリセットを変更しない', async () => {
    const { game, repository } = await setup();
    await game.newGame();
    const original = await repository.read();
    const spy = vi
      .spyOn(repository, 'write')
      .mockRejectedValue(new DOMException('容量不足', 'QuotaExceededError'));
    await expect(game.newGame()).rejects.toThrow('容量不足');
    expect(await repository.read()).toEqual(original);
    expect(game.status.getState().value).toBe('error');
    spy.mockRestore();
    await game.retry();
    expect(
      ((await repository.read()) as SaveEnvelope<SaveData>).current.saveId,
    ).not.toBe((original as SaveEnvelope<SaveData>).current.saveId);
  });
  it('schema0の移行を確認待ちにし、確定後は旧currentをpreviousに残す', async () => {
    const { game, repository, store } = await setup();
    await game.newGame();
    const old = (await repository.read()) as SaveEnvelope<SaveData>;
    old.current.schemaVersion = 0;
    await set(SAVE_KEY, old, store);
    await game.load();
    expect(game.status.getState().value).toBe('recovery');
    expect(await repository.read()).toEqual(old);
    await game.repair();
    const saved = (await repository.read()) as SaveEnvelope<SaveData>;
    expect(saved.current.schemaVersion).toBe(1);
    expect(saved.previous).toEqual(old.current);
  });
  it('S07: 未来版はprevious復元・新規開始を拒否し原本を書き出せる', async () => {
    const { game, repository, store } = await setup();
    await game.newGame();
    await game.newGame();
    const future = (await repository.read()) as SaveEnvelope<SaveData>;
    future.current.contentVersion++;
    await set(SAVE_KEY, future, store);
    await game.load();
    expect(game.status.getState().value).toBe('recovery');
    await expect(game.restorePrevious()).rejects.toThrow();
    await expect(game.newGame()).rejects.toThrow();
    expect(JSON.parse(game.exportRaw())).toEqual(future);
  });
  it('current破損時にpreviousを明示復元し、破損原本を保持する', async () => {
    const { game, repository, store } = await setup();
    await game.newGame();
    await game.newGame();
    const broken = (await repository.read()) as SaveEnvelope<SaveData>;
    broken.current.data.party = [] as unknown as SaveData['party'];
    await set(SAVE_KEY, broken, store);
    await game.load();
    expect(game.status.getState().value).toBe('recovery');
    expect(game.previousInspection().candidate).not.toBeNull();
    await game.restorePrevious();
    const saved = (await repository.read()) as SaveEnvelope<SaveData>;
    expect(saved.previous).toEqual(broken.current);
    expect(saved.current.revision).toBe(broken.current.revision + 1);
  });
  it('S06: 所有権を失ったタブは書込と進行を拒否する', async () => {
    const { game, repository, release, loseOwnership } = await setup();
    await game.newGame();
    const original = await repository.read();
    loseOwnership();
    await game.load();
    expect(game.status.getState().value).toBe('readonly');
    await expect(game.update(initialSave(release))).rejects.toThrow();
    expect(await repository.read()).toEqual(original);
  });
  it('設定の不正値だけ修復し、進行の穴と未知討伐は自動修復しない', async () => {
    const { game, repository, release } = await setup();
    await game.newGame();
    const saved = (await repository.read()) as SaveEnvelope<SaveData>;
    saved.current.data.settings.masterVolume = 101;
    saved.current.data.settings.bgmVolume = 22;
    const inspected = inspectSave(release, saved.current);
    expect(inspected.candidate?.settings.masterVolume).toBe(80);
    expect(inspected.candidate?.settings.bgmVolume).toBe(22);
    saved.current.data.progression.defeatedEnemyIds = ['boss-02'];
    expect(inspectSave(release, saved.current).candidate).toBeNull();
  });
  it('保存成功後に応答だけ失敗した場合は読直しで成功を確定する', async () => {
    const { repository, store, release } = await setup();
    const candidate: SaveEnvelope<SaveData> = {
      current: {
        saveId: 'test',
        revision: 1,
        schemaVersion: 1,
        contentVersion: release.contentVersion,
        updatedAt: Date.now(),
        data: initialSave(release),
      },
      previous: null,
    };
    const faulty = new SaveRepository(
      'test',
      () => true,
      async () => {
        await set(SAVE_KEY, candidate, store);
        throw new Error('応答失敗');
      },
    );
    vi.spyOn(faulty, 'read').mockImplementation(() => get(SAVE_KEY, store));
    await faulty.write(undefined, candidate);
    expect(await repository.read()).toEqual(candidate);
  });
  it('S01・S02: 戦闘前保存に失敗したら開始せず、再読込で親分岐に戻る', async () => {
    const { game, repository, release } = await setup();
    await game.newGame();
    const warp = warpToFloor(release, createInitialProgression(), 'floor-01');
    if (!warp.ok) throw new Error('ワープ失敗');
    let progression = warp.value.progression;
    for (const suffix of ['hall-1', 'hall-2', 'hall-3'] as const) {
      const step = selectNode(release, progression, `floor-01-${suffix}`);
      if (!step.ok) throw new Error('移動失敗');
      progression = step.value.progression;
    }
    await game.update({ ...initialSave(release), progression });
    const chosen = selectNode(release, progression, 'floor-01-boss');
    if (!chosen.ok || !chosen.value.encounter) throw new Error('遭遇失敗');
    const failure = vi
      .spyOn(repository, 'write')
      .mockRejectedValue(new Error('保存不能'));
    await expect(game.startBattle(chosen.value.encounter)).rejects.toThrow(
      '保存不能',
    );
    expect(game.battle.getState().session).toBeNull();
    failure.mockRestore();
    await game.retry();
    expect(game.battle.getState().session).not.toBeNull();
    await game.load();
    expect(game.battle.getState().session).toBeNull();
    expect(game.progression.getState().value?.location).toEqual(
      progression.location,
    );
  });
  it('S03・S12: 勝利保存の再試行で報酬を二重加算せず、逃走で最新設定を保つ', async () => {
    const { game, repository, release } = await setup();
    await game.newGame();
    const data = initialSave(release);
    data.progression = {
      defeatedEnemyIds: [],
      visitedFloorIds: ['floor-01'],
      endingHandled: false,
      location: {
        kind: 'floor',
        floorId: 'floor-01',
        nodeId: 'floor-01-hall-3',
      },
    };
    await game.update(data);
    const chosen = selectNode(release, data.progression, 'floor-01-boss');
    if (!chosen.ok || !chosen.value.encounter) throw new Error('遭遇失敗');
    await game.startBattle(chosen.value.encounter);
    data.settings.muted = true;
    await game.update(data);
    await game.leaveBattle();
    expect(game.persisted.getState().data?.settings.muted).toBe(true);
    await game.startBattle(chosen.value.encounter);
    const session = structuredClone(game.battle.getState().session!);
    session.state.result = 'victory';
    game.battle.setState({ session });
    const failure = vi
      .spyOn(repository, 'write')
      .mockRejectedValue(new Error('保存不能'));
    await expect(game.victory()).rejects.toThrow();
    expect(game.progression.getState().value?.defeatedEnemyIds).toEqual([]);
    await expect(game.update(data)).rejects.toThrow();
    failure.mockRestore();
    await game.retry();
    const progression = game.progression.getState().value!;
    expect(progression.defeatedEnemyIds).toEqual(['boss-01']);
    expect(
      deriveProgression(release.campaign, progression).skillPointLimit,
    ).toBe(4);
    expect(game.battle.getState().session).toBeNull();
    expect(game.persisted.getState().data?.settings.muted).toBe(true);
  });
});
