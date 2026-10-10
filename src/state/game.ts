import { createStore } from 'zustand/vanilla';
import { persist, type PersistStorage } from 'zustand/middleware';
import type {
  BattleReward,
  EnemyId,
  FloorId,
  NodeId,
} from '../game/data/model';
import type { GameRelease } from '../game/data/release-model';
import { validateFormation, type FormationState } from '../game/party';
import {
  createBattle,
  submitCommand,
  advanceBattle,
  escapeBattle,
  type PlayerCommand,
  getBattleDelta,
  type BattleDelta,
  getBattleOutcome,
  type BattleSession,
} from '../game/battle';
import {
  createVictoryCandidate,
  selectNode,
  warpToFloor,
  returnToGuild,
  moveToNextFloor,
  validateEncounter,
  type Encounter,
  type Progression,
  type ExplorationCandidate,
  type ProgressionResult,
} from '../game/progression';
import {
  SaveConflict,
  type SaveEnvelope,
  type SaveRepository,
  type SaveSnapshot,
} from '../storage/save';
import {
  initialSave,
  inspectSave,
  migrateSave,
  SCHEMA_VERSION,
  type SaveData,
  type Settings,
} from './save-model';

export type SaveStatus =
  'loading' | 'empty' | 'ready' | 'saving' | 'error' | 'recovery' | 'readonly';
/** 唯一の書込経路。各Storeには保存成功後の値だけを配布する。 */
export function createGameState(
  release: GameRelease,
  repository: SaveRepository,
  owns: () => boolean,
) {
  const progression = createStore<{ value: Progression | null }>(() => ({
    value: null,
  }));
  const settings = createStore<{ value: Settings | null }>(() => ({
    value: null,
  }));
  const formation = createStore<{ value: FormationState | null }>(() => ({
    value: null,
  }));
  const exploration = createStore<{
    encounter: Encounter | null;
    entryText: string | null;
  }>(() => ({
    encounter: null,
    entryText: null,
  }));
  const battle = createStore<{
    session: BattleSession<SaveData> | null;
    before: SaveData | null;
    receipt: { enemyId: EnemyId; reward: BattleReward } | null;
    paused: boolean;
    transitioning: boolean;
    exitRequested: boolean;
    feedback: BattleDelta | null;
    changes: { now: number; id: string; hp: number; gauge: number | null }[];
  }>(() => ({
    session: null,
    before: null,
    receipt: null,
    paused: false,
    transitioning: false,
    exitRequested: false,
    feedback: null,
    changes: [],
  }));
  const status = createStore<{
    value: SaveStatus;
    message: string;
    changes: string[];
  }>(() => ({ value: 'loading', message: '', changes: [] }));
  function clearBattle() {
    battle.setState({
      session: null,
      before: null,
      receipt: null,
      paused: false,
      transitioning: false,
      exitRequested: false,
      feedback: null,
      changes: [],
    });
  }
  let raw: unknown;
  let committed: SaveData | null = null;
  let pending: SaveEnvelope<SaveData> | null = null;
  let afterSave: (() => void) | null = null;
  let recovery: SaveData | null = null;
  let future = false;
  const publish = (data: SaveData) => {
    committed = structuredClone(data);
    settings.setState({ value: structuredClone(data.settings) });
    progression.setState({ value: structuredClone(data.progression) });
    formation.setState({
      value: {
        party: structuredClone(data.party),
        presets: structuredClone(data.presets),
      },
    });
  };
  let writing: Promise<void> | null = null;
  const storage: PersistStorage<{ data: SaveData | null }> = {
    getItem: async () => {
      return { state: { data: committed }, version: SCHEMA_VERSION };
    },
    setItem: () => {
      if (!pending) throw new Error('保存候補がありません');
      writing = repository.write(raw, pending);
      return writing;
    },
    removeItem: () => {
      throw new Error('セーブの削除は禁止されています');
    },
  };
  const persisted = createStore(
    persist<{ data: SaveData | null }>(() => ({ data: null }), {
      name: 'relicspire-save',
      version: SCHEMA_VERSION,
      storage,
      skipHydration: true,
      migrate: (state, version) =>
        migrateSave(state, version) as { data: SaveData | null },
    }),
  );
  // persistが開始したIndexedDB書込を待ってから他のStoreへ確定値を配布する。
  async function flush() {
    if (!pending) throw new Error('再試行する候補がありません');
    status.setState({ value: 'saving', message: '保存中…' });
    try {
      persisted.setState({ data: structuredClone(pending.current.data) });
      await writing;
      raw = structuredClone(pending);
      publish(pending.current.data);
      pending = null;
      await persisted.persist.rehydrate();
      status.setState({
        value: owns() ? 'ready' : 'readonly',
        message: '',
        changes: [],
      });
      const next = afterSave;
      afterSave = null;
      if (owns()) next?.();
      else clearBattle();
    } catch (error) {
      await persisted.persist.rehydrate();
      const conflict = error instanceof SaveConflict || !owns();
      status.setState({
        value: conflict ? 'readonly' : 'error',
        message: error instanceof Error ? error.message : '保存に失敗しました',
      });
      if (conflict) clearBattle();
      throw error;
    }
  }
  async function save(
    data: SaveData,
    next: (() => void) | null = null,
    newGame = false,
  ) {
    if (!owns()) {
      clearBattle();
      status.setState({ value: 'readonly', message: '所有権を失いました' });
      throw new SaveConflict('所有権を失いました');
    }
    if (
      !owns() ||
      !['ready', 'empty', 'recovery'].includes(status.getState().value) ||
      future
    )
      throw new Error('現在は変更できません');
    const current = (raw as SaveEnvelope<SaveData> | undefined)?.current;
    const revision =
      !newGame && Number.isSafeInteger(current?.revision)
        ? current!.revision + 1
        : 1;
    const snapshot: SaveSnapshot<SaveData> = {
      saveId:
        newGame || !current?.saveId ? crypto.randomUUID() : current.saveId,
      revision,
      schemaVersion: SCHEMA_VERSION,
      contentVersion: release.contentVersion,
      updatedAt: Date.now(),
      data: structuredClone(data),
    };
    const inspection = inspectSave(release, snapshot);
    if (!inspection.candidate || inspection.changes.length)
      throw new Error(inspection.error ?? '候補の修復が必要です');
    pending = { current: snapshot, previous: current ?? null };
    afterSave = next;
    await flush();
  }
  function activeBattle(
    expected?: BattleSession<SaveData>,
    allowPaused = false,
  ) {
    const session = battle.getState().session;
    if (
      !owns() ||
      status.getState().value !== 'ready' ||
      battle.getState().transitioning ||
      (!allowPaused && battle.getState().paused) ||
      !session ||
      (expected && session !== expected)
    )
      throw new Error('現在は戦闘を操作できません');
    return session;
  }
  function publishBattle(
    before: BattleSession<SaveData>,
    next: BattleSession<SaveData>,
  ) {
    const feedback = getBattleDelta(before, next);
    const changes = feedback.participants
      .filter(
        (p) =>
          p.hpChange !== 0 || (p.gaugeChange !== null && p.gaugeChange !== 0),
      )
      .map((p) => ({
        now: next.state.now,
        id: p.id,
        hp: p.hpChange,
        gauge: p.gaugeChange,
      }));
    battle.setState({
      session: next,
      feedback,
      changes: [...battle.getState().changes, ...changes].slice(-200),
    });
  }
  async function travel(result: ProgressionResult<ExplorationCandidate>) {
    if (
      !committed ||
      battle.getState().session ||
      exploration.getState().encounter ||
      status.getState().value !== 'ready' ||
      !owns()
    )
      throw new Error('現在は移動できません');
    if (!result.ok)
      throw new Error(result.issues.map((i) => i.message).join(' ／ '));
    const candidate = result.value;
    if (candidate.encounter) {
      exploration.setState({ encounter: candidate.encounter, entryText: null });
      return;
    }
    await save({ ...committed, progression: candidate.progression }, () => {
      const location = candidate.progression.location;
      exploration.setState({
        encounter: null,
        entryText:
          candidate.showEntryText && location.kind === 'floor'
            ? release.presentation.floors[location.floorId]!.entryText
            : null,
      });
    });
  }
  async function load() {
    status.setState({ value: 'loading', message: '', changes: [] });
    pending = null;
    afterSave = null;
    committed = null;
    recovery = null;
    future = false;
    await persisted.persist.rehydrate();
    clearBattle();
    exploration.setState({ encounter: null, entryText: null });
    progression.setState({ value: null });
    formation.setState({ value: null });
    settings.setState({ value: null });
    status.setState({ value: 'loading', message: '', changes: [] });
    try {
      raw = await repository.read();
      if (raw === undefined) {
        status.setState({
          value: owns() ? 'empty' : 'readonly',
          message: owns()
            ? '新しく冒険を始められます'
            : '別のタブでプレイ中、またはWeb Locksが利用できません',
        });
        return;
      }
      const inspection = inspectSave(
        release,
        (raw as SaveEnvelope<SaveData> | null)?.current,
      );
      future = inspection.future;
      recovery = inspection.candidate;
      if (inspection.candidate && !inspection.changes.length) {
        publish(inspection.candidate);
        await persisted.persist.rehydrate();
      }
      status.setState({
        value: !owns()
          ? 'readonly'
          : inspection.error || inspection.changes.length
            ? 'recovery'
            : 'ready',
        message: inspection.error ?? '',
        changes: inspection.changes,
      });
    } catch (error) {
      status.setState({ value: 'error', message: String(error) });
    }
  }
  return {
    release,
    progression,
    settings,
    formation,
    exploration,
    battle,
    status,
    persisted,
    load,
    snapshot: () => (committed ? structuredClone(committed) : null),
    hasPendingSave: () => pending !== null,
    isFutureSave: () => future,
    stopForOwnershipLoss() {
      clearBattle();
      exploration.setState({ encounter: null, entryText: null });
      status.setState({
        value: 'readonly',
        message:
          '所有権を失いました。再確認して最新のセーブを読み込んでください。',
      });
    },
    exportRaw: () => JSON.stringify(raw ?? null, null, 2),
    async newGame() {
      await save(
        initialSave(release, committed?.settings ?? recovery?.settings),
        () => {
          clearBattle();
          exploration.setState({ encounter: null, entryText: null });
        },
        true,
      );
    },
    async repair() {
      if (!recovery) throw new Error('修復候補がありません');
      await save(recovery);
    },
    previousInspection: () =>
      inspectSave(
        release,
        (raw as SaveEnvelope<SaveData> | undefined)?.previous,
      ),
    async restorePrevious() {
      const previous = inspectSave(
        release,
        (raw as SaveEnvelope<SaveData> | undefined)?.previous,
      );
      if (future || previous.future || !previous.candidate)
        throw new Error('この保存世代は復元できません');
      await save(previous.candidate);
    },
    retry: flush,
    async cancel() {
      if (status.getState().value !== 'error' || !pending)
        throw new Error('取消できません');
      if (JSON.stringify(await repository.read()) === JSON.stringify(pending)) {
        await flush();
        return;
      }
      if (
        JSON.stringify(await repository.read()) !== JSON.stringify(raw) ||
        !owns()
      ) {
        clearBattle();
        status.setState({
          value: 'readonly',
          message: '保存が更新されています',
        });
        throw new SaveConflict('保存が更新されています');
      }
      pending = null;
      afterSave = null;
      clearBattle();
      exploration.setState({ encounter: null, entryText: null });
      status.setState({ value: committed ? 'ready' : 'empty', message: '' });
    },
    async update(data: SaveData) {
      if (battle.getState().transitioning) throw new Error('戦闘の復元中です');
      if (
        battle.getState().session &&
        (JSON.stringify(data.party) !== JSON.stringify(committed?.party) ||
          JSON.stringify(data.progression) !==
            JSON.stringify(committed?.progression) ||
          JSON.stringify(data.presets) !== JSON.stringify(committed?.presets))
      )
        throw new Error('戦闘中は設定だけ変更できます');
      await save(data);
    },
    async move(nodeId: NodeId) {
      if (!committed) throw new Error('保存済みの現在地がありません');
      await travel(selectNode(release, committed.progression, nodeId));
    },
    async warp(floorId: FloorId) {
      if (!committed) throw new Error('保存済みの現在地がありません');
      await travel(warpToFloor(release, committed.progression, floorId));
    },
    async returnToGuild() {
      if (!committed) throw new Error('保存済みの現在地がありません');
      await travel(returnToGuild(release, committed.progression));
    },
    async nextFloor() {
      if (!committed) throw new Error('保存済みの現在地がありません');
      await travel(moveToNextFloor(release, committed.progression));
    },
    avoidEncounter() {
      if (
        status.getState().value !== 'ready' ||
        !owns() ||
        battle.getState().session
      )
        throw new Error('現在は回避できません');
      exploration.setState({ encounter: null, entryText: null });
    },
    dismissEntry() {
      exploration.setState({ entryText: null });
    },
    command(command: PlayerCommand, expected: BattleSession<SaveData>) {
      const result = submitCommand(activeBattle(expected), command, {
        advance: false,
      });
      if (!result.ok)
        throw new Error('コマンドの条件が変わりました。選び直してください。');
      publishBattle(expected, result.session);
    },
    advance(expected: BattleSession<SaveData>) {
      publishBattle(
        expected,
        advanceBattle(activeBattle(expected), { stopAfterUnit: true }),
      );
    },
    escape(expected: BattleSession<SaveData>) {
      battle.setState({ session: escapeBattle(activeBattle(expected, true)) });
    },
    requestBattleExit() {
      const session = activeBattle(undefined, true);
      if (session.state.result === 'victory')
        throw new Error('勝利の保存を完了してください');
      battle.setState({ paused: true, exitRequested: true });
    },
    continueBattle() {
      activeBattle(undefined, true);
      battle.setState({ paused: false, exitRequested: false });
    },
    pauseBattle(value: boolean) {
      activeBattle(undefined, true);
      battle.setState({ paused: value });
    },
    dismissBattleResult() {
      if (!owns() || status.getState().value !== 'ready')
        throw new Error('現在は結果を閉じられません');
      battle.setState({ receipt: null });
    },
    async startBattle(encounter: Encounter) {
      if (!committed || battle.getState().session)
        throw new Error('戦闘を開始できません');
      const data = structuredClone(committed);
      const issues = [
        ...validateEncounter(release, data.progression, encounter),
        ...validateFormation(release.content, data.party, {
          defeatedEnemyIds: data.progression.defeatedEnemyIds,
          inBattle: false,
        }),
      ];
      if (issues.length)
        throw new Error(issues.map((i) => i.message).join('\n'));
      const session = createBattle(
        release.content,
        {
          party: data.party,
          enemyId: encounter.enemyId,
          campaign: release.campaign,
          context: {
            defeatedEnemyIds: data.progression.defeatedEnemyIds,
            inBattle: false,
          },
        },
        data,
      );
      await save(data, () => {
        battle.setState({
          before: data,
          session,
          receipt: null,
          paused: false,
          transitioning: false,
          exitRequested: false,
          feedback: null,
          changes: [],
        });
        exploration.setState({ encounter: structuredClone(encounter) });
      });
    },
    async leaveBattle() {
      if (status.getState().value !== 'ready' || !owns())
        throw new Error('現在は戦闘を終了できません');
      const { session, before } = battle.getState();
      if (
        !session ||
        !before ||
        !committed ||
        getBattleOutcome(session).result === 'victory'
      )
        throw new Error('勝利の保存を先に完了してください');
      if (battle.getState().transitioning) throw new Error('戦闘の復元中です');
      battle.setState({ transitioning: true });
      try {
        if (
          JSON.stringify(await repository.read()) !== JSON.stringify(raw) ||
          !owns() ||
          status.getState().value !== 'ready'
        ) {
          clearBattle();
          status.setState({ value: 'readonly' });
          throw new SaveConflict('保存が更新されています');
        }
        publish({
          ...committed,
          party: before.party,
          progression: before.progression,
        });
        clearBattle();
        exploration.setState({ encounter: null, entryText: null });
      } finally {
        battle.setState({ transitioning: false });
      }
    },
    async retryBattle() {
      const encounter = exploration.getState().encounter;
      if (!encounter) throw new Error('遭遇情報がありません');
      await this.leaveBattle();
      if (!committed || !owns() || status.getState().value !== 'ready')
        throw new Error('開始前状態がありません');
      const data = structuredClone(committed);
      battle.setState({
        before: data,
        paused: false,
        transitioning: false,
        exitRequested: false,
        feedback: null,
        changes: [],
        session: createBattle(
          release.content,
          {
            party: data.party,
            enemyId: encounter.enemyId,
            campaign: release.campaign,
            context: {
              defeatedEnemyIds: data.progression.defeatedEnemyIds,
              inBattle: false,
            },
          },
          data,
        ),
      });
      exploration.setState({ encounter: structuredClone(encounter) });
    },
    async victory() {
      const { session, before } = battle.getState();
      const encounter = exploration.getState().encounter;
      if (
        !session ||
        getBattleOutcome(session).result !== 'victory' ||
        !before ||
        !encounter ||
        !committed
      )
        throw new Error('勝利が成立していません');
      const candidate = createVictoryCandidate(
        release,
        before.progression,
        encounter,
        encounter.enemyId,
      );
      if (!candidate.ok) throw new Error('勝利候補が不正です');
      await save(
        {
          ...committed,
          party: before.party,
          progression: candidate.value.progression,
        },
        () => {
          battle.setState({
            session: null,
            before: null,
            receipt: {
              enemyId: encounter.enemyId,
              reward: candidate.value.reward,
            },
          });
          exploration.setState({ encounter: null, entryText: null });
        },
      );
    },
  };
}
export type GameState = ReturnType<typeof createGameState>;
