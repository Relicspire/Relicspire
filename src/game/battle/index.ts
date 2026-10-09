import type {
  BattleParticipant,
  BattleState,
  ParticipantId,
} from '../data/battle';
import type { CharacterId, EnemyId, GameContent, SkillId } from '../data/model';
import { parseGameContent } from '../data/validation';
import { validateFormation } from '../party/validation';
import { getBuildStats } from '../party/stats';
import { clampStats, initialWaitTU } from './calculations';
import { Engine } from './engine';
import type {
  BattleOutcome,
  BattleSession,
  BattleSetup,
  CommandResult,
  PartyBuild,
  PlayerCommand,
} from './types';
export { effectiveStats } from './calculations';
export type * from './types';
/**
 * 確定ビルドから装備加算後の基礎値と開始待機を持つ味方を生成する。
 *
 * @param content 検証済みのゲームコンテンツ。
 * @param build 対象キャラクターのジョブ・習得・装備。
 * @param slot 参加者順を決める0〜2の味方スロット。
 */
function buildParticipant(
  content: GameContent,
  build: PartyBuild,
  slot: 0 | 1 | 2,
): BattleParticipant {
  const definition = content.characters.find((c) => c.id === build.id);
  const job = content.jobs.find((j) => j.id === build.jobId);
  if (!definition || !job)
    throw new Error(`Unknown character/job: ${build.id}/${build.jobId}`);
  const nodes = [...job.routes.a, ...job.routes.b];
  if (
    new Set(build.learnedSkills).size !== build.learnedSkills.length ||
    build.learnedSkills.some(
      (id) =>
        !nodes.some((n) => n.id === id) ||
        nodes
          .find((n) => n.id === id)!
          .prerequisites.some((p) => !build.learnedSkills.includes(p)),
    )
  )
    throw new Error('Invalid learned skills/prerequisites');
  if (build.equipment.length !== 6)
    throw new Error('Exactly six equipment slots are required');
  const {
    equipmentStats: stats,
    effectiveStats: finalStats,
    initialWait,
  } = getBuildStats(content, build);
  return {
    id: build.id,
    side: 'party',
    slot,
    jobId: build.jobId,
    learnedSkills: [...build.learnedSkills],
    equipment: structuredClone(build.equipment),
    stats: { ...stats, maxHp: finalStats.maxHp },
    hp: finalStats.maxHp,
    action: {
      kind: 'waiting',
      ready: { kind: 'running', at: initialWait },
    },
    statuses: [],
    cooldowns: [],
    timeStopUntil: null,
  };
}
/**
 * コンテンツを検証し、TU0から最初の入力または戦闘終了まで初期化する。
 *
 * @param input ゲームコンテンツ。型付きの値でも実行時に検証する。
 * @param setup 順序付きの3人の確定編成と敵ID。
 * @param preBattle 呼び出し元が保存済みの戦闘前進行。コピーして保持し、内容を変更しない。
 * @returns 最初の入力待ちまたは終了状態の新しいセッション。
 */
export function createBattle<T = null>(
  input: GameContent,
  setup: BattleSetup,
  preBattle: T = null as T,
): BattleSession<T> {
  const content = parseGameContent(input, setup.campaign);
  if (
    setup.party.length !== 3 ||
    setup.party.some((p, i) => p.id !== `party-${i + 1}`)
  )
    throw new Error('Party slots must be party-1, party-2, party-3');
  const context = setup.context ?? { defeatedEnemyIds: [], inBattle: false };
  if (context.inBattle)
    throw new Error('Cannot start a battle while in battle');
  const formationIssues = validateFormation(content, setup.party, context);
  if (formationIssues.length)
    throw new Error(
      formationIssues
        .map((i) => `${i.path}: ${i.code}: ${i.message}`)
        .join('\n'),
    );

  const def = content.enemies.find((e) => e.id === setup.enemyId);
  if (!def) throw new Error(`Unknown enemy: ${setup.enemyId}`);
  const finalStats = clampStats(def.stats);
  const stats = { ...def.stats, maxHp: finalStats.maxHp };
  const enemy: BattleParticipant = {
    id: def.id,
    side: 'enemy',
    stats,
    hp: stats.maxHp,
    action: {
      kind: 'waiting',
      ready: { kind: 'running', at: initialWaitTU(finalStats.spd) },
    },
    statuses: [],
    cooldowns: [],
    timeStopUntil: null,
    breakGauge: def.maxBreakGauge,
    maxBreakGauge: def.maxBreakGauge,
    phaseIndex: 0,
    actionIndex: 0,
  };
  const state: BattleState = {
    now: 0,
    participants: [
      buildParticipant(content, setup.party[0], 0),
      buildParticipant(content, setup.party[1], 1),
      buildParticipant(content, setup.party[2], 2),
      enemy,
    ],
    timeline: [],
    traps: [],
    nextSequence: 1,
    result: 'ongoing',
  };
  const session: BattleSession<T> = {
    content,
    setup: structuredClone(setup),
    initialState: structuredClone(state),
    state,
    log: [],
    preBattle: structuredClone(preBattle),
  };
  const engine = new Engine(content, state, session.log);
  engine.record('start');
  engine.advance();
  return session;
}
/**
 * 有効予定を入力待ちまたは終了まで進める。入力待ち中に再度呼んでもTUは進まない。
 *
 * @param session 更新または照会対象の戦闘セッション。入力オブジェクトは変更しない。
 * @param options stopAfterUnitがtrueなら1処理単位ごとに停止する。省略時は自動進行。
 */
export function advanceBattle<T>(
  session: BattleSession<T>,
  options: { stopAfterUnit?: boolean } = {},
): BattleSession<T> {
  const next = structuredClone(session);
  new Engine(next.content, next.state, next.log).advance(
    options.stopAfterUnit ?? false,
  );
  return next;
}
/**
 * コマンドの手番・習得・上位自動置換・CD・属性・対象を状態変更なしで検証する。
 *
 * @param session 更新または照会対象の戦闘セッション。入力オブジェクトは変更しない。
 * @param command 使用スキル・予約対象・属性選択を含むコマンド。プレイヤー入力では行動者IDも含む。
 * @returns 使用可否と、不正時の理由。
 */
export function checkCommand<T>(
  session: BattleSession<T>,
  command: PlayerCommand,
) {
  return new Engine(session.content, session.state, session.log).checkCommand(
    command,
  );
}
/**
 * コマンドを原子的に確定する。不正入力では元セッションをそのまま返す。
 *
 * @param session 更新または照会対象の戦闘セッション。入力オブジェクトは変更しない。
 * @param command 使用スキル・予約対象・属性選択を含むコマンド。プレイヤー入力では行動者IDも含む。
 * @param options advanceをfalseにすると、確定した処理だけを実行して後続イベント前で止まる。
 */
export function submitCommand<T>(
  session: BattleSession<T>,
  command: PlayerCommand,
  options: { advance?: boolean } = {},
): CommandResult<T> {
  const check = checkCommand(session, command);
  if (!check.ok) return { ...check, session };
  const next = structuredClone(session);
  const engine = new Engine(next.content, next.state, next.log);
  const { actorId, ...reservation } = command;
  engine.startCommand(engine.participant(actorId), reservation);
  if (options.advance ?? true) engine.advance();
  else engine.syncTimeline();
  return { ok: true, session: next };
}
/**
 * 現在入力を待っている味方のIDを返す。敵・未到達・終了ならnull。
 *
 * @param session 更新または照会対象の戦闘セッション。入力オブジェクトは変更しない。
 */
export function getInputActor<T>(
  session: BattleSession<T>,
): CharacterId | null {
  return (
    new Engine(session.content, session.state, session.log).inputActor()?.id ??
    null
  );
}
/**
 * 現在の対象適格性を満たす参加者IDを参加者順で返す。
 *
 * @param session 更新または照会対象の戦闘セッション。入力オブジェクトは変更しない。
 * @param actorId 行動者の参加者ID。
 * @param skillId 使用または照会するスキルID。
 */
export function getSkillTargets<T>(
  session: BattleSession<T>,
  actorId: ParticipantId,
  skillId: SkillId,
): ParticipantId[] {
  const engine = new Engine(session.content, session.state, session.log);
  return engine.targetIds(engine.participant(actorId), engine.skill(skillId));
}
/**
 * 固定行動列と現在状態から敵の予告を生成する。詠唱中の予約対象は変更しない。
 *
 * @param session 更新または照会対象の戦闘セッション。入力オブジェクトは変更しない。
 * @param enemyId 予告対象の敵ID。省略時はこの戦闘の敵。
 */
export function getEnemyForecast<T>(
  session: BattleSession<T>,
  enemyId: EnemyId = session.setup.enemyId,
) {
  const engine = new Engine(session.content, session.state, session.log);
  return engine.forecast(engine.participant(enemyId));
}
/**
 * 勝利以外なら開始時のTU0状態とログへ戻し、最初の入力まで再実行する。
 *
 * @param session 更新または照会対象の戦闘セッション。入力オブジェクトは変更しない。
 * @returns 再初期化したセッション。勝利済みなら例外。
 */
export function retryBattle<T>(session: BattleSession<T>): BattleSession<T> {
  if (session.state.result === 'victory')
    throw new Error('Cannot retry a victorious battle');
  const next = structuredClone(session);
  next.state = structuredClone(next.initialState);
  next.log = [];
  const engine = new Engine(next.content, next.state, next.log);
  engine.record('start');
  engine.advance();
  return next;
}
/**
 * 進行中の戦闘を逃走で終了し、全予定を破棄する。確定済みの勝敗を優先する。
 *
 * @param session 更新または照会対象の戦闘セッション。入力オブジェクトは変更しない。
 */
export function escapeBattle<T>(session: BattleSession<T>): BattleSession<T> {
  if (session.state.result !== 'ongoing') return structuredClone(session);
  const next = structuredClone(session);
  next.state.result = 'escaped';
  next.state.timeline = [];
  next.state.traps = [];
  for (const p of next.state.participants) {
    p.action = { kind: 'finished' };
    p.statuses = [];
    p.cooldowns = [];
    p.timeStopUntil = null;
  }
  new Engine(next.content, next.state, next.log).record(
    'result',
    null,
    null,
    null,
    'escaped',
  );
  return next;
}
/**
 * 勝敗・勝利報酬候補・戦闘前進行をコピーして返す。報酬保存は呼び出し元で一度だけ行う。
 *
 * @param session 更新または照会対象の戦闘セッション。入力オブジェクトは変更しない。
 */
export function getBattleOutcome<T>(
  session: BattleSession<T>,
): BattleOutcome<T> {
  const reward =
    session.state.result === 'victory'
      ? session.content.enemies.find((e) => e.id === session.setup.enemyId)!
          .reward
      : null;
  return {
    result: session.state.result,
    reward: structuredClone(reward),
    preBattle: structuredClone(session.preBattle),
  };
}
/**
 * 戦闘状態とログの独立したコピーを返す。デバッグ表示やJSON記録に使用する。
 *
 * @param session 更新または照会対象の戦闘セッション。入力オブジェクトは変更しない。
 */
export function getDebugSnapshot<T>(session: BattleSession<T>) {
  return structuredClone({ state: session.state, log: session.log });
}

export * from './queries';
