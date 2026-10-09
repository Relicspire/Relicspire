import type {
  BattleParticipant,
  BattleState,
  ParticipantId,
  Timer,
  TimelineEvent,
} from '../data/battle';
import type { SkillId } from '../data/model';
import { getActiveSkillIds } from '../party/validation';
import { initialWaitTU, effectiveStats, delayTU } from './calculations';
import { Engine, canReact } from './engine';
import type {
  BattleLogEntry,
  BattleSession,
  CommandCheck,
  PlayerCommand,
} from './types';
/** 表示ログの上限。全ログの保存・集計とは独立する。 */
export const DISPLAY_LOG_LIMIT = 200;
/** 反応・挑発・かばうが一時的に成立しない理由。 */
export type InactiveReason =
  | 'source-dead'
  | 'source-stopped'
  | 'source-broken'
  | 'battle-finished'
  | 'charges-exhausted';
/** 1人に1個の主アイコン。停止時は絶対時刻と凍結予定を分離する。 */
export interface MainSchedule {
  participantId: ParticipantId;
  kind: 'ready' | 'waiting' | 'casting' | 'broken' | 'stopped';
  at: number;
  remaining: number;
  frozenRemaining: number | null;
  skillId: SkillId | null;
  recoveryWaitReference: number | null;
}
/** 1処理単位の比較結果。能力・状態・CD・予定も参加者の前後コピーに含む。 */
export interface BattleDelta {
  participants: {
    id: ParticipantId;
    before: BattleParticipant;
    after: BattleParticipant;
    hpChange: number;
    gaugeChange: number | null;
  }[];
  before: BattleState;
  after: BattleState;
  events: BattleLogEntry[];
}
/** 即時結果と詠唱予約・現在発動した場合の参考値を区別した予測。 */
export type CommandPreview =
  | { ok: false; check: Extract<CommandCheck, { ok: false }> }
  | {
      ok: true;
      kind: 'immediate' | 'casting';
      committed: BattleDelta;
      reference: BattleDelta | null;
      activationAt: number;
      cooldown: Timer | null;
      command: PlayerCommand;
      precedingEvents: TimelineEvent[];
      expiringStatuses: {
        participantId: ParticipantId;
        statusId: number;
        at: number;
      }[];
      warnings: EffectWarning[];
      trapReferences: {
        sequence: number;
        reference: BattleDelta | null;
        inactiveReason: InactiveReason | null;
      }[];
    };
/** タイマーの残りTUを計算する。凍結値を絶対時刻へ誤変換しない。
 * @param timer 表示対象。
 * @param now 現在の論理TU。
 */
function remaining(timer: Timer, now: number): number {
  return timer.kind === 'frozen'
    ? timer.remaining
    : Math.max(0, timer.at - now);
}
/** 参加者の反応不能理由を照会する。
 * @param p 反応の実行者。
 */
function blockedReason(p: BattleParticipant): InactiveReason | null {
  if (p.hp === 0) return 'source-dead';
  if (p.action.kind === 'finished') return 'battle-finished';
  if (p.timeStopUntil !== null) return 'source-stopped';
  if (p.action.kind === 'broken') return 'source-broken';
  return null;
}
/** 主予定を取得する。戦闘不能・終了済みはバーから除外する。
 * @param session 照会する戦闘。
 */
export function getMainSchedules<T>(session: BattleSession<T>): MainSchedule[] {
  const now = session.state.now;
  return session.state.participants.flatMap((p) => {
    if (p.hp === 0 || p.action.kind === 'finished' || p.action.kind === 'dead')
      return [];
    const engine = new Engine(session.content, session.state, session.log);
    const timer = engine.actionTimer(p);
    const kind = p.timeStopUntil !== null ? 'stopped' : p.action.kind;
    if (kind === 'acting') return [];
    const at = p.timeStopUntil ?? (timer?.kind === 'running' ? timer.at : now);
    return [
      {
        participantId: p.id,
        kind,
        at,
        remaining: Math.max(0, at - now),
        frozenRemaining: timer?.kind === 'frozen' ? timer.remaining : null,
        skillId:
          p.action.kind === 'casting' ? p.action.cast.command.skillId : null,
        recoveryWaitReference:
          p.action.kind === 'broken'
            ? initialWaitTU(effectiveStats(p).spd)
            : null,
      },
    ];
  });
}
/** 状態の期限・強度・実付与者・回数と一時無効理由を返す。
 * @param session 照会する戦闘。
 * @param participantId 状態を持つ参加者ID。
 */
export function getStatusDetails<T>(
  session: BattleSession<T>,
  participantId: ParticipantId,
) {
  const p = session.state.participants.find((p) => p.id === participantId);
  if (!p) return [];
  return p.statuses.map((status) => {
    const source = session.state.participants.find(
      (p) => p.id === status.sourceId,
    )!;
    let inactiveReason: InactiveReason | null = null;
    if (status.remainingCharges === 0) inactiveReason = 'charges-exhausted';
    else if (status.spec.familyId === 'taunt')
      inactiveReason = source.hp === 0 ? 'source-dead' : null;
    else if (status.spec.familyId === 'cover')
      inactiveReason = blockedReason(source);
    else if (['reflect', 'counter', 'follow'].includes(status.spec.familyId))
      inactiveReason = blockedReason(p);
    return {
      status: structuredClone(status),
      remaining: remaining(status.expires, session.state.now),
      frozen: status.expires.kind === 'frozen',
      nextTickRemaining: status.nextTick
        ? remaining(status.nextTick, session.state.now)
        : null,
      inactiveReason,
    };
  });
}
/** 次列と予約済み詠唱を別々に返し、全フェーズ条件も公開する。
 * @param session 照会する戦闘。
 */
export function getEnemyDetails<T>(session: BattleSession<T>) {
  const p = session.state.participants.find((p) => p.side === 'enemy')!;
  const engine = new Engine(session.content, session.state, session.log);
  const definition = session.content.enemies.find((e) => e.id === p.id)!;
  return {
    definition: structuredClone(definition),
    forecast: engine.forecast(p),
    reservedCast:
      p.action.kind === 'casting'
        ? structuredClone(p.action.cast.command)
        : null,
    nextColumn:
      p.side === 'enemy'
        ? structuredClone(
            definition.phases[p.phaseIndex]!.actions[p.actionIndex]!,
          )
        : null,
  };
}
/** コマンドの適格対象・時間・CDと入力候補の使用可否を返す。
 * @param session 照会する戦闘。
 * @param command 判定する属性・対象込みの入力候補。
 */
export function getCommandDetails<T>(
  session: BattleSession<T>,
  command: PlayerCommand,
) {
  const e = new Engine(session.content, session.state, session.log);
  const check = e.checkCommand(command);
  if (
    !session.content.skills.some((s) => s.id === command.skillId) &&
    command.skillId !== 'basic-attack' &&
    command.skillId !== 'wait'
  )
    return { check, skill: null, targets: [], cooldownRemaining: 0 };
  const skill = e.skill(command.skillId);
  const p = session.state.participants.find((p) => p.id === command.actorId)!;
  return {
    check,
    skill: structuredClone(skill),
    delayReference: p ? delayTU(skill.delay, effectiveStats(p).spd) : null,
    targets: p ? e.targetIds(p, skill) : [],
    cooldownRemaining: p?.cooldowns.find((c) => c.id === skill.cooldownId)
      ? remaining(
          p.cooldowns.find((c) => c.id === skill.cooldownId)!.timer,
          session.state.now,
        )
      : 0,
  };
}
/** 全体の状態コピーと有効コマンド・主予定を表示へ渡す。
 * @param session 照会する戦闘。
 */
export function getBattleDisplay<T>(session: BattleSession<T>) {
  return {
    now: session.state.now,
    result: session.state.result,
    schedules: getMainSchedules(session),
    participants: session.state.participants.map((p) => ({
      participant: structuredClone(p),
      effectiveStats: effectiveStats(p),
      statuses: getStatusDetails(session, p.id),
      commands: p.side === 'party' ? getActiveSkillIds(session.content, p) : [],
    })),
    enemy: getEnemyDetails(session),
    traps: structuredClone(session.state.traps),
  };
}
/** ログ連番以後の処理単位差分を取得する。カーソルは同じセッション履歴内で使う。
 * @param session 更新後の戦闘。
 * @param afterSequence 更新前に取得した最後のログ連番。開始時は0。
 */
export function getBattleEvents<T>(
  session: BattleSession<T>,
  afterSequence = 0,
): BattleLogEntry[] {
  return structuredClone(
    session.log.filter((entry) => entry.sequence > afterSequence),
  );
}
/** 表示用に直近200件だけ返す。全ログは削除しない。
 * @param session 照会する戦闘。
 */
export function getDisplayLog<T>(session: BattleSession<T>): BattleLogEntry[] {
  return structuredClone(session.log.slice(-DISPLAY_LOG_LIMIT));
}
/** 1処理単位の前後状態と、新しいイベントだけを比較する。
 * @param before 更新前。
 * @param after 更新後。
 */
export function getBattleDelta<T>(
  before: BattleSession<T>,
  after: BattleSession<T>,
): BattleDelta {
  return {
    before: structuredClone(before.state),
    after: structuredClone(after.state),
    events: getBattleEvents(after, before.log.at(-1)?.sequence ?? 0),
    participants: after.state.participants.map((p, i) => ({
      id: p.id,
      before: structuredClone(before.state.participants[i]!),
      after: structuredClone(p),
      hpChange: p.hp - before.state.participants[i]!.hp,
      gaugeChange:
        p.side === 'enemy' && before.state.participants[i]!.side === 'enemy'
          ? p.breakGauge -
            (
              before.state.participants[i] as Extract<
                BattleParticipant,
                { side: 'enemy' }
              >
            ).breakGauge
          : null,
    })),
  };
}
/** 設置罠1個が今発動した場合の参考値。本エンジンの開始前トリガーを使用する。
 * @param session 設置後の状態。
 * @param sequence 参考値を計算する罠の連番。
 */
export function getTrapReference<T>(
  session: BattleSession<T>,
  sequence: number,
) {
  const trap = session.state.traps.find((t) => t.sequence === sequence);
  if (!trap) return null;
  const source = session.state.participants.find(
    (p) => p.id === trap.sourceId,
  )!;
  const inactiveReason = blockedReason(source);
  if (inactiveReason) return { sequence, reference: null, inactiveReason };
  const next = structuredClone(session);
  const e = new Engine(next.content, next.state, next.log);
  const target = e.participant(trap.targetId);
  if (target.hp === 0 || next.state.result !== 'ongoing')
    return {
      sequence,
      reference: null,
      inactiveReason: 'battle-finished' as const,
    };
  next.state.traps = [structuredClone(trap)];
  target.action = { kind: 'ready' };
  e.syncTimeline();
  const baseline = structuredClone(next);
  e.startEnemy(target, true);
  e.syncTimeline();
  return {
    sequence,
    reference: getBattleDelta(baseline, next),
    inactiveReason: null,
  };
}
/** 本エンジンで入力を予測する。未来の味方入力や自動イベントは仮定しない。
 * @param session 現在の入力待ちセッション。
 * @param command 確定前の候補入力。
 */
export function previewCommand<T>(
  session: BattleSession<T>,
  command: PlayerCommand,
): CommandPreview {
  const check = new Engine(
    session.content,
    session.state,
    session.log,
  ).checkCommand(command);
  if (!check.ok) return { ok: false, check };
  const next = structuredClone(session);
  const e = new Engine(next.content, next.state, next.log);
  const { actorId, ...reservation } = command;
  const actor = e.participant(actorId);
  const skill = e.skill(command.skillId);
  e.startCommand(actor, reservation);
  e.syncTimeline();
  let reference: BattleDelta | null = null;
  if (skill.castTime > 0) {
    const ref = structuredClone(next);
    const re = new Engine(ref.content, ref.state, ref.log);
    re.activate(re.participant(actorId), reservation);
    re.syncTimeline();
    reference = getBattleDelta(next, ref);
  }
  const activationAt = session.state.now + skill.castTime;
  return {
    ok: true,
    kind: skill.castTime > 0 ? 'casting' : 'immediate',
    committed: getBattleDelta(session, next),
    reference,
    activationAt,
    command: structuredClone(command),
    cooldown: structuredClone(
      actor.cooldowns.find((c) => c.id === skill.cooldownId)?.timer ?? null,
    ),
    precedingEvents: structuredClone(
      skill.castTime > 0
        ? next.state.timeline.slice(
            0,
            next.state.timeline.findIndex(
              (event) =>
                event.participantId === actorId &&
                event.kind === 'cast-complete',
            ),
          )
        : [],
    ),
    expiringStatuses: next.state.participants.flatMap((p) =>
      p.statuses
        .filter(
          (s) => s.expires.kind === 'running' && s.expires.at <= activationAt,
        )
        .map((s) => ({
          participantId: p.id,
          statusId: s.id,
          at: s.expires.kind === 'running' ? s.expires.at : activationAt,
        })),
    ),
    warnings: getEffectWarnings(session, command),
    trapReferences: next.state.traps
      .filter(
        (t) => !session.state.traps.some((old) => old.sequence === t.sequence),
      )
      .map((t) => getTrapReference(next, t.sequence)!)
      .filter(Boolean),
  };
}

/** 効果が現在の対象へ成立しない理由。詠唱では現在状態の参考情報。 */
export interface EffectWarning {
  targetId: ParticipantId;
  code: 'immune-element' | 'immune-stop' | 'immune-cancel' | 'not-casting';
}
/** 属性無効と妨害耐性の不成立理由をロジックIDで返す。
 * @param session 照会する現在状態。
 * @param command 対象と属性を確定した候補。
 */
export function getEffectWarnings<T>(
  session: BattleSession<T>,
  command: PlayerCommand,
): EffectWarning[] {
  const e = new Engine(session.content, session.state, session.log);
  const check = e.checkCommand(command);
  if (!check.ok) return [];
  const actor = e.participant(command.actorId);
  const skill = e.skill(command.skillId);
  const warnings: EffectWarning[] = [];
  for (const effect of skill.effects) {
    const ids =
      effect.target === 'self'
        ? [actor.id]
        : effect.target === 'selected'
          ? command.selectedTargetId
            ? [command.selectedTargetId]
            : []
          : e.targetIds(actor, skill);
    for (const id of ids) {
      let target = e.participant(id);
      if (
        effect.kind === 'attack' &&
        skill.target !== 'enemy-all' &&
        skill.target !== 'ally-all'
      ) {
        const cover = target.statuses.find((s) => s.spec.familyId === 'cover');
        if (cover) {
          const source = e.participant(cover.sourceId);
          if (source.side === target.side && canReact(source)) target = source;
        }
      }
      const enemy = session.content.enemies.find(
        (enemy) => enemy.id === target.id,
      );
      if (effect.kind === 'attack') {
        const element =
          effect.element === 'chosen' ? command.chosenElement : effect.element;
        if (element && enemy?.immuneElements?.includes(element)) {
          warnings.push({ targetId: target.id, code: 'immune-element' });
          continue;
        }
      }
      const utilities = effect.kind === 'attack' ? effect.attached : [effect];
      for (const utility of utilities) {
        if (
          utility.kind === 'apply-status' &&
          utility.status.familyId === 'time-stop' &&
          enemy?.timeStopImmune
        )
          warnings.push({ targetId: target.id, code: 'immune-stop' });
        if (utility.kind === 'cancel-cast') {
          if (enemy?.cancelImmune)
            warnings.push({ targetId: target.id, code: 'immune-cancel' });
          else if (target.action.kind !== 'casting')
            warnings.push({ targetId: target.id, code: 'not-casting' });
        }
      }
    }
  }
  return warnings;
}
