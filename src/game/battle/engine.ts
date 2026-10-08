import type {
  ActorSnapshot,
  BattleParticipant,
  BattleState,
  CommandReservation,
  ParticipantId,
  StatusEffect,
  TimelineEvent,
  Timer,
} from '../data/battle';
import type {
  AttackPayload,
  Effect,
  EnemyDefinition,
  GameContent,
  HitEffect,
  SkillDefinition,
  SkillId,
  StatusSpec,
  TargetRule,
  UtilityPayload,
} from '../data/model';
import { getActiveSkillIds } from '../party/validation';
import {
  actorSnapshot,
  breakAmount,
  damageAmount,
  delayTU,
  effectiveStats,
  healAmount,
  initialWaitTU,
} from './calculations';
import type {
  BattleLogEntry,
  CommandCheck,
  EnemyForecast,
  PlayerCommand,
} from './types';
/** 全生存味方が無料で使う通常攻撃の固定定義。 */
const BASIC: SkillDefinition = {
  id: 'basic-attack',
  target: 'enemy-single',
  castTime: 0,
  delay: 100,
  cooldown: 0,
  cooldownId: 'basic-attack',
  actorSnapshot: 'before-activation',
  targetSnapshot: 'before-activation',
  elementChoices: [],
  effects: [
    {
      kind: 'attack',
      target: 'selected',
      damageType: 'physical',
      element: 'none',
      power: 100,
      breakDamage: 5,
      hits: 1,
      actorReference: 'before-activation',
      targetReference: 'before-effect',
      attached: [],
    },
  ],
};
/** 効果なし・基礎ディレイ20 TUの無料待機コマンド。 */
const WAIT: SkillDefinition = {
  ...BASIC,
  id: 'wait',
  target: 'self',
  delay: 20,
  cooldownId: 'wait',
  effects: [],
};
/** 同時刻イベントの処理優先度。小さい値から戦闘全体に適用する。 */
const priorities: Record<TimelineEvent['kind'], number> = {
  'time-stop-end': 0,
  'status-expiry': 1,
  'trap-expiry': 1,
  'break-recovery': 2,
  'poison-tick': 3,
  'cast-complete': 4,
  ready: 5,
};
/**
 * 通常タイマーが現在TUまでに到達しているかを判定する。凍結タイマーは未到達扱い。
 *
 * @param timer 絶対時刻または凍結残りTUを保持するタイマー。
 * @param now 戦闘の現在時刻（整数TU）。
 */
const due = (timer: Timer, now: number) =>
  timer.kind === 'running' && timer.at <= now;
/**
 * 生存・非ブレイク・非停止・未終了で、反応行動の資格があるかを判定する。
 *
 * @param p 処理対象の戦闘参加者。
 */
export const canReact = (p: BattleParticipant) =>
  p.hp > 0 &&
  p.action.kind !== 'broken' &&
  p.action.kind !== 'finished' &&
  p.timeStopUntil === null;
/**
 * 状態系統を解除判定用の強化または弱体へ分類する。
 *
 * @param spec 付与する状態効果の性能。
 */
const polarity = (spec: StatusSpec) =>
  ['atk-down', 'mag-down', 'spd-down', 'poison', 'taunt', 'time-stop'].includes(
    spec.familyId,
  )
    ? 'debuff'
    : 'buff';
/** 1処理単位内の自己蘇生予約、反応実行済みID、追撃候補を保持する内部状態。 */
interface Unit {
  /** 死亡時に保存し、処理単位の末尾で解決する自己蘇生率。 */
  revives: Map<ParticipantId, number>;
  /** 同じ反撃・追撃を1処理単位で再実行しないための状態ID集合。 */
  usedReactions: Set<number>;
  /** 最初にHPダメージを与えた敵へ束縛した追撃候補。 */
  follows: {
    actorId: ParticipantId;
    statusId: number;
    targetId: ParticipantId;
  }[];
  /** 基本行動が最初の敵HPダメージを既に記録したか。 */
  firstHit: boolean;
}
/** 1処理単位用の空の反応記録・蘇生予約・追撃候補を生成する。 */
const unit = (): Unit => ({
  revives: new Map(),
  usedReactions: new Set(),
  follows: [],
  firstHit: false,
});
/** コピー済みの戦闘状態だけを変更する内部エンジン。外部APIは更新前にセッションを複製する。 */
export class Engine {
  /**
   * 検証済みコンテンツと更新用のコピーを内部エンジンへ渡す。
   *
   * @param content 検証済みのゲームコンテンツ。
   * @param state 内部で更新するコピー済みの戦闘状態。
   * @param log 追記先の構造化戦闘ログ配列。
   */
  constructor(
    readonly content: GameContent,
    readonly state: BattleState,
    readonly log: BattleLogEntry[],
  ) {}
  /**
   * 参加者IDから現在の参加者を検索する。存在しないIDは例外にする。
   *
   * @param id 検索するID。
   */
  participant(id: ParticipantId): BattleParticipant {
    const found = this.state.participants.find((p) => p.id === id);
    if (!found) throw new Error(`Unknown participant: ${id}`);
    return found;
  }
  /**
   * 無料コマンドまたはコンテンツからスキル性能を取得する。未知のIDは例外にする。
   *
   * @param id 検索するID。
   */
  skill(id: SkillId): SkillDefinition {
    if (id === 'basic-attack') return BASIC;
    if (id === 'wait') return WAIT;
    const found = this.content.skills.find((s) => s.id === id);
    if (!found) throw new Error(`Unknown skill: ${id}`);
    return found;
  }
  /**
   * 参加者が敵なら敵定義、味方ならnullを返す。
   *
   * @param p 処理対象の戦闘参加者。
   */
  enemy(p: BattleParticipant): EnemyDefinition | null {
    return p.side === 'enemy'
      ? (this.content.enemies.find((e) => e.id === p.id) ?? null)
      : null;
  }
  /**
   * 現在TUとログ連番を付けて構造化ログを追記する。
   *
   * @param kind 記録するログまたは除去処理の種別。
   * @param actorId 処理元の参加者ID。該当しない場合はnull。
   * @param targetId 効果を受ける参加者ID。該当しないログではnull。
   * @param amount HP損失・回復量・TUなどの数値。該当しない場合はnull。
   * @param detail ログの補足情報。該当しない場合はnull。
   * @param skillId 記録対象のスキルID。該当しない場合はnull。
   */
  record(
    kind: BattleLogEntry['kind'],
    actorId: ParticipantId | null = null,
    targetId: ParticipantId | null = null,
    amount: number | null = null,
    detail: string | null = null,
    skillId: SkillId | null = null,
  ) {
    this.log.push({
      sequence: this.log.length,
      now: this.state.now,
      kind,
      actorId,
      targetId,
      amount,
      detail,
      skillId,
    });
  }
  /**
   * 対象の停止状態に応じて絶対時刻または凍結残りTUのタイマーを生成する。
   *
   * @param p 処理対象の戦闘参加者。
   * @param duration 現在時刻からの持続または待機TU。
   */
  timer(p: BattleParticipant, duration: number): Timer {
    return p.timeStopUntil === null
      ? { kind: 'running', at: this.state.now + duration }
      : { kind: 'frozen', remaining: duration };
  }
  /**
   * 待機・詠唱・ブレイクの有効な行動タイマーを取得する。予定なしならnull。
   *
   * @param p 処理対象の戦闘参加者。
   */
  actionTimer(p: BattleParticipant): Timer | null {
    const a = p.action;
    return a.kind === 'waiting'
      ? a.ready
      : a.kind === 'casting'
        ? a.cast.completes
        : a.kind === 'broken'
          ? a.break.recovers
          : null;
  }
  /**
   * 本人の行動・CD・通常状態・定期効果・罠へ同じ時間変換を適用する。停止自身の期限は除外する。
   *
   * @param p 処理対象の戦闘参加者。
   * @param transform 各タイマーに適用する変換関数。
   */
  transformTimers(p: BattleParticipant, transform: (timer: Timer) => Timer) {
    const a = p.action;
    if (a.kind === 'waiting') a.ready = transform(a.ready);
    if (a.kind === 'casting') a.cast.completes = transform(a.cast.completes);
    if (a.kind === 'broken') a.break.recovers = transform(a.break.recovers);
    for (const c of p.cooldowns) c.timer = transform(c.timer);
    for (const s of p.statuses)
      if (s.spec.familyId !== 'time-stop') {
        s.expires = transform(s.expires);
        if (s.nextTick) s.nextTick = transform(s.nextTick);
      }
    for (const t of this.state.traps)
      if (t.sourceId === p.id) t.expires = transform(t.expires);
  }
  /**
   * 時間停止を解除し、凍結した予定を現在TUからの絶対時刻へ復元する。
   *
   * @param p 処理対象の戦闘参加者。
   */
  thaw(p: BattleParticipant) {
    p.timeStopUntil = null;
    this.transformTimers(p, (t) =>
      t.kind === 'frozen'
        ? { kind: 'running', at: this.state.now + t.remaining }
        : t,
    );
  }
  /**
   * 指定状態を除去してログへ記録する。時間停止なら関連予定も凍結解除する。
   *
   * @param p 処理対象の戦闘参加者。
   * @param s 除去する付与済み状態。
   * @param kind 自然終了ならexpire、スキル解除ならdispel。
   */
  removeStatus(
    p: BattleParticipant,
    s: StatusEffect,
    kind: 'expire' | 'dispel',
  ) {
    p.statuses = p.statuses.filter((item) => item.id !== s.id);
    if (s.spec.familyId === 'time-stop') this.thaw(p);
    this.record(kind, s.sourceId, p.id, null, s.spec.familyId);
  }
  /**
   * 新規状態を付与する。同系統が残っていれば付与者・性能・周期・回数を保持して期限だけ更新する。
   *
   * @param source 状態を付与する参加者。
   * @param target 効果の対象。
   * @param spec 付与する状態効果の性能。
   * @param duration 現在時刻からの持続または待機TU。
   * @param dispellable 解除スキルで除去できるか。
   */
  applyStatus(
    source: BattleParticipant,
    target: BattleParticipant,
    spec: StatusSpec,
    duration: number,
    dispellable: boolean,
  ) {
    if (
      target.hp === 0 ||
      (spec.familyId === 'time-stop' && this.enemy(target)?.timeStopImmune)
    )
      return;
    const old = target.statuses.find((s) => s.spec.familyId === spec.familyId);
    if (old) {
      old.expires =
        spec.familyId === 'time-stop'
          ? { kind: 'running', at: this.state.now + duration }
          : this.timer(target, duration);
      if (spec.familyId === 'time-stop')
        target.timeStopUntil = this.state.now + duration;
      this.record(
        'status',
        old.sourceId,
        target.id,
        duration,
        `${spec.familyId}:extend`,
      );
      return;
    }
    const sequence = this.state.nextSequence++;
    const status: StatusEffect = {
      id: sequence,
      sourceId: source.id,
      sequence,
      spec: structuredClone(spec),
      dispellable,
      expires: this.timer(target, duration),
      nextTick: spec.familyId === 'poison' ? this.timer(target, 20) : null,
      remainingCharges: 'charges' in spec ? spec.charges : null,
    };
    if (spec.familyId === 'time-stop') {
      this.transformTimers(target, (t) =>
        t.kind === 'running'
          ? { kind: 'frozen', remaining: Math.max(0, t.at - this.state.now) }
          : t,
      );
      target.timeStopUntil = this.state.now + duration;
      status.expires = { kind: 'running', at: target.timeStopUntil };
    }
    target.statuses.push(status);
    this.record('status', source.id, target.id, duration, spec.familyId);
  }
  /**
   * 陣営・生死・自身除外・待機状態から対象の適格性を判定する。
   *
   * @param actor 効果の実行者。
   * @param target 効果の対象。
   * @param rule 対象選択と適格性を決める規則。
   */
  eligible(
    actor: BattleParticipant,
    target: BattleParticipant,
    rule: TargetRule,
  ): boolean {
    if (rule === 'dead-ally-other')
      return (
        target.side === actor.side && target.id !== actor.id && target.hp === 0
      );
    if (target.hp === 0) return false;
    if (rule === 'self') return target.id === actor.id;
    if (rule === 'enemy-single' || rule === 'enemy-all')
      return target.side !== actor.side;
    if (target.side !== actor.side) return false;
    if (rule === 'ally-other' || rule === 'waiting-ally-other') {
      if (target.id === actor.id) return false;
      if (rule === 'waiting-ally-other')
        return (
          target.action.kind === 'casting' ||
          (target.action.kind === 'waiting' &&
            (target.action.ready.kind === 'running'
              ? target.action.ready.at > this.state.now
              : target.action.ready.remaining > 0))
        );
    }
    return true;
  }
  /**
   * スキル対象規則に適合する参加者IDを参加者順で取得する。
   *
   * @param actor 効果の実行者。
   * @param skill 対象規則と性能を参照するスキル定義。
   */
  targetIds(actor: BattleParticipant, skill: SkillDefinition): ParticipantId[] {
    return this.state.participants
      .filter((p) => this.eligible(actor, p, skill.target))
      .map((p) => p.id);
  }
  /** 最優先の到達済みイベントが味方の入力待ちなら、その参加者を返す。 */
  inputActor(): Extract<BattleParticipant, { side: 'party' }> | null {
    if (this.state.result !== 'ongoing') return null;
    const event = this.state.timeline[0];
    if (event?.kind === 'ready' && event.at <= this.state.now) {
      const p = this.participant(event.participantId);
      return p.side === 'party' && p.action.kind === 'ready' && canReact(p)
        ? p
        : null;
    }
    return null;
  }
  /**
   * 手番、習得、上位置換、CD、属性、選択対象を検証して拒否理由を返す。
   *
   * @param command 使用スキル・予約対象・属性選択を含むコマンド。プレイヤー入力では行動者IDも含む。
   */
  checkCommand(command: PlayerCommand): CommandCheck {
    const actor = this.state.participants.find((p) => p.id === command.actorId);
    if (
      !actor ||
      actor.side !== 'party' ||
      actor.hp === 0 ||
      actor.action.kind !== 'ready' ||
      actor.timeStopUntil !== null ||
      this.inputActor()?.id !== actor.id
    )
      return { ok: false, reason: 'Actor is not awaiting input' };
    let skill: SkillDefinition;
    try {
      skill = this.skill(command.skillId);
    } catch {
      return { ok: false, reason: 'Unknown skill' };
    }
    if (skill.id !== 'basic-attack' && skill.id !== 'wait') {
      if (
        !actor.learnedSkills.some((id) => id === skill.id) ||
        !skill.id.startsWith(`${actor.jobId}-`)
      )
        return { ok: false, reason: 'Skill is not learned by this job' };
      if (!getActiveSkillIds(this.content, actor).includes(skill.id))
        return { ok: false, reason: 'Skill has been replaced' };
    }
    const cooldown = actor.cooldowns.find((c) => c.id === skill.cooldownId);
    if (
      cooldown &&
      (cooldown.timer.kind === 'frozen'
        ? cooldown.timer.remaining > 0
        : cooldown.timer.at > this.state.now)
    )
      return { ok: false, reason: 'Skill is on cooldown' };
    if (
      skill.elementChoices.length
        ? !skill.elementChoices.some((e) => e === command.chosenElement)
        : command.chosenElement !== null
    )
      return { ok: false, reason: 'Invalid element choice' };
    if (['self', 'ally-all', 'enemy-all'].includes(skill.target)) {
      if (command.selectedTargetId !== null)
        return { ok: false, reason: 'This skill does not select a target' };
    } else {
      const target = this.state.participants.find(
        (p) => p.id === command.selectedTargetId,
      );
      if (!target || !this.eligible(actor, target, skill.target))
        return { ok: false, reason: 'Invalid target' };
    }
    return { ok: true };
  }
  /**
   * 実HP損失を適用し、死亡時に自己蘇生資格を予約して行動・状態・罠を除去する。
   *
   * @param target 効果の対象。
   * @param amount 適用する非負のHPダメージ。
   * @param source 効果の付与者、またはHP損失を起こした参加者ID。
   * @param u 当該処理単位の反応実行記録と自己蘇生予約。
   * @param detail 通常攻撃・反応・毒・反射などのダメージ種別。
   * @returns 実際に失ったHP量。
   */
  loseHp(
    target: BattleParticipant,
    amount: number,
    source: ParticipantId,
    u: Unit,
    detail: string,
  ): number {
    if (target.hp === 0) return 0;
    const lost = Math.min(target.hp, amount);
    target.hp -= lost;
    this.record('damage', source, target.id, lost, detail);
    if (target.hp === 0) {
      const selfRevive = target.statuses.find(
        (s) =>
          s.spec.familyId === 'self-revive' && (s.remainingCharges ?? 0) > 0,
      );
      if (
        selfRevive?.spec.familyId === 'self-revive' &&
        target.side === 'party' &&
        target.jobId === 'berserker'
      )
        u.revives.set(target.id, selfRevive.spec.hpRatio);
      this.thaw(target);
      target.statuses = [];
      target.action = { kind: 'dead' };
      this.state.traps = this.state.traps.filter(
        (t) => t.sourceId !== target.id && t.targetId !== target.id,
      );
      this.record('death', source, target.id);
    }
    return lost;
  }
  /**
   * 戦闘不能味方を指定HP率で蘇生し、状態なしの固定50 TU待機を設定する。CDは維持する。
   *
   * @param target 効果の対象。
   * @param ratio 最大HPに対する蘇生率（10000が100%）。
   */
  revive(target: BattleParticipant, ratio: number) {
    if (target.hp !== 0 || target.side !== 'party') return;
    target.hp = Math.max(1, Math.floor((target.stats.maxHp * ratio) / 10000));
    target.statuses = [];
    target.timeStopUntil = null;
    target.action = {
      kind: 'waiting',
      ready: { kind: 'running', at: this.state.now + 50 },
    };
    this.record('revive', target.id, target.id, target.hp);
  }
  /**
   * 自己蘇生を参加者順に解決してから勝敗、続行時のHPフェーズ移行を確定する。
   *
   * @param u 当該処理単位の反応実行記録と自己蘇生予約。
   */
  finishUnit(u: Unit) {
    for (const p of this.state.participants) {
      const ratio = u.revives.get(p.id);
      if (ratio !== undefined) this.revive(p, ratio);
    }
    const aliveParty = this.state.participants.some(
      (p) => p.side === 'party' && p.hp > 0,
    );
    const aliveEnemy = this.state.participants.some(
      (p) => p.side === 'enemy' && p.hp > 0,
    );
    if (!aliveParty || !aliveEnemy) {
      this.state.result = aliveParty ? 'victory' : 'defeat';
      this.state.timeline = [];
      this.state.traps = [];
      // 終了後の予定はすべて破棄し、参加者の最終HPは結果表示用に保持する。
      for (const p of this.state.participants) {
        p.statuses = [];
        p.cooldowns = [];
        p.timeStopUntil = null;
        p.action = { kind: 'finished' };
      }
      this.record('result', null, null, null, this.state.result);
      return;
    }
    for (const p of this.state.participants)
      if (p.side === 'enemy') {
        const def = this.enemy(p)!;
        let phase = p.phaseIndex;
        def.phases.forEach((candidate, index) => {
          if (
            index > phase &&
            p.hp * 10000 <= p.stats.maxHp * candidate.hpThreshold
          )
            phase = index;
        });
        if (phase !== p.phaseIndex) {
          p.phaseIndex = phase;
          p.actionIndex = 0;
          this.record('phase', p.id, null, phase);
        }
      }
  }
  /**
   * 現在フェーズの行動列を1要素消費し、末尾から先頭へ循環させる。
   *
   * @param p 処理対象の戦闘参加者。
   */
  consumeEnemyAction(p: BattleParticipant) {
    if (p.side !== 'enemy') return;
    const phase = this.enemy(p)!.phases[p.phaseIndex]!;
    p.actionIndex = (p.actionIndex + 1) % phase.actions.length;
  }
  /**
   * 時間操作・キャンセル・状態付与・解除を現在の対象状態に適用する。
   *
   * @param actor 効果の実行者。
   * @param target 効果の対象。
   * @param effect 今回適用する効果データ。
   */
  utility(
    actor: BattleParticipant,
    target: BattleParticipant,
    effect: UtilityPayload,
  ) {
    if (target.hp === 0) return;
    if (effect.kind === 'apply-status') {
      this.applyStatus(
        actor,
        target,
        effect.status,
        effect.duration,
        effect.dispellable,
      );
      return;
    }
    if (effect.kind === 'dispel') {
      target.statuses
        .filter((s) => s.dispellable && polarity(s.spec) === effect.polarity)
        .sort((a, b) => a.sequence - b.sequence)
        .slice(0, effect.count)
        .forEach((s) => this.removeStatus(target, s, 'dispel'));
      return;
    }
    if (effect.kind === 'cancel-cast') {
      if (
        target.action.kind === 'casting' &&
        !this.enemy(target)?.cancelImmune
      ) {
        target.action = { kind: 'waiting', ready: this.timer(target, 30) };
        this.record('cancel', actor.id, target.id);
      }
      return;
    }
    let amount = effect.amount;
    if (effect.direction === 'delay')
      amount = Math.ceil(
        (amount * (10000 - (this.enemy(target)?.knockbackResistance ?? 0))) /
          10000,
      );
    if (amount === 0) return;
    const a = target.action;
    if (a.kind === 'acting') {
      if (effect.direction === 'delay') {
        a.pendingKnockback += amount;
        this.record('shift', actor.id, target.id, amount, 'delay');
      }
      return;
    }
    if (a.kind === 'ready') {
      if (effect.direction === 'delay') {
        target.action = { kind: 'waiting', ready: this.timer(target, amount) };
        this.record('shift', actor.id, target.id, amount, 'delay');
      }
      return;
    }
    const timer =
      a.kind === 'waiting'
        ? a.ready
        : a.kind === 'casting'
          ? a.cast.completes
          : null;
    if (!timer) return;
    if (timer.kind === 'running')
      timer.at =
        effect.direction === 'delay'
          ? timer.at + amount
          : Math.max(this.state.now + 1, timer.at - amount);
    else
      timer.remaining =
        effect.direction === 'delay'
          ? timer.remaining + amount
          : Math.max(1, timer.remaining - amount);
    this.record('shift', actor.id, target.id, amount, effect.direction);
  }
  /**
   * 1ヒットの被弾・付随効果・反射・反撃を解決し、必要な追撃候補を記録する。
   *
   * @param actor 効果の実行者。
   * @param original かばうを適用する前の攻撃対象。
   * @param payload 今回の1ヒットの攻撃性能。
   * @param attached 実際の被弾者に順序規則に従って適用する付随効果。
   * @param snapshot 基本行動または反応の発動直前に固定した能力。
   * @param command 確定済みコマンド。選択式攻撃の属性を参照する。
   * @param u 当該処理単位の反応実行記録と自己蘇生予約。
   * @param basic trueなら基本行動としてかばう・反射・反撃・追撃候補を処理する。反応攻撃ではfalse。
   * @param single trueなら単体攻撃としてかばうを判定する。
   */
  attack(
    actor: BattleParticipant,
    original: BattleParticipant,
    payload: AttackPayload,
    attached: HitEffect[],
    snapshot: ActorSnapshot,
    command: CommandReservation,
    u: Unit,
    basic: boolean,
    single: boolean,
  ) {
    if (original.hp === 0) return;
    let target = original;
    if (basic && single && original.side === 'party') {
      const cover = original.statuses.find((s) => s.spec.familyId === 'cover');
      if (cover) {
        const source = this.participant(cover.sourceId);
        if (source.side === original.side && canReact(source)) target = source;
      }
    }
    const reflect =
      payload.damageType === 'magic' && canReact(target)
        ? target.statuses.find(
            (s) =>
              s.spec.familyId === 'reflect' && (s.remainingCharges ?? 0) > 0,
          )
        : undefined;
    const element =
      payload.element === 'chosen' ? command.chosenElement! : payload.element;
    const def = this.enemy(target);
    const amount = damageAmount(payload, snapshot, target, element, def);
    if (amount === 0) return;
    const lost = this.loseHp(
      target,
      amount,
      actor.id,
      u,
      basic ? 'attack' : 'reaction',
    );
    if (
      target.hp > 0 &&
      target.side === 'enemy' &&
      target.action.kind !== 'broken'
    ) {
      target.breakGauge = Math.max(
        0,
        target.breakGauge - breakAmount(payload.breakDamage, element, def!),
      );
      if (target.breakGauge === 0) {
        // 詠唱中・処理中は開始時に行動列を消費済み。待機・未処理手番だけここで消費する。
        if (target.action.kind !== 'casting' && target.action.kind !== 'acting')
          this.consumeEnemyAction(target);
        target.action = {
          kind: 'broken',
          break: { recovers: this.timer(target, 60) },
        };
        this.record('break', actor.id, target.id);
      }
    }
    const order = { shift: 0, 'cancel-cast': 1, 'apply-status': 2, dispel: 3 };
    [...attached]
      .sort((a, b) => order[a.kind] - order[b.kind])
      .forEach((e) => this.utility(actor, target, e));
    if (!basic || lost === 0) return;
    if (!u.firstHit && target.side === 'enemy') {
      u.firstHit = true;
      for (const follower of this.state.participants)
        if (follower.side === actor.side && follower.id !== actor.id) {
          const follow = follower.statuses.find(
            (s) => s.spec.familyId === 'follow',
          );
          if (follow)
            u.follows.push({
              actorId: follower.id,
              statusId: follow.id,
              targetId: target.id,
            });
        }
    }
    if (reflect?.spec.familyId === 'reflect') {
      reflect.remainingCharges = (reflect.remainingCharges ?? 0) - 1;
      if (reflect.remainingCharges === 0)
        target.statuses = target.statuses.filter((s) => s.id !== reflect.id);
      const reflected = Math.floor((lost * reflect.spec.ratio) / 10000);
      this.record('reflect', target.id, actor.id, reflected);
      if (reflected > 0) this.loseHp(actor, reflected, target.id, u, 'reflect');
    }
    if (canReact(target) && actor.hp > 0) {
      const counter = target.statuses.find(
        (s) => s.spec.familyId === 'counter',
      );
      if (
        counter?.spec.familyId === 'counter' &&
        !u.usedReactions.has(counter.id)
      ) {
        u.usedReactions.add(counter.id);
        this.record('counter', target.id, actor.id);
        this.attack(
          target,
          actor,
          counter.spec.attack,
          [],
          actorSnapshot(target),
          command,
          u,
          false,
          true,
        );
      }
    }
  }
  /**
   * 発動時の能力と対象集合を固定し、全Effect・追撃・蘇生・勝敗・終了待機を解決する。
   *
   * @param actor 効果の実行者。
   * @param command 確定済みまたは詠唱予約済みのコマンド。
   */
  activate(actor: BattleParticipant, command: CommandReservation) {
    const skill = this.skill(command.skillId);
    const snapshot = actorSnapshot(actor);
    const u = unit();
    actor.action = { kind: 'acting', pendingKnockback: 0 };
    const selected =
      command.selectedTargetId === null
        ? null
        : this.participant(command.selectedTargetId);
    const valid =
      selected === null
        ? ['self', 'ally-all', 'enemy-all'].includes(skill.target)
        : this.eligible(actor, selected, skill.target);
    const allies = this.state.participants.filter(
      (p) => p.side === actor.side && p.hp > 0,
    );
    const enemies = this.state.participants.filter(
      (p) => p.side !== actor.side && p.hp > 0,
    );
    if (!valid)
      this.record(
        'fizzle',
        actor.id,
        command.selectedTargetId,
        null,
        null,
        skill.id,
      );
    else {
      for (const effect of skill.effects) {
        const targets =
          effect.target === 'self'
            ? [actor]
            : effect.target === 'selected'
              ? selected
                ? [selected]
                : []
              : effect.target === 'all-allies'
                ? allies
                : enemies;
        for (const target of targets) {
          if (effect.kind === 'revive') {
            if (
              actor.side === 'party' &&
              actor.jobId === 'cleric' &&
              skill.id === 'cleric-a3' &&
              target.id !== actor.id &&
              target.side === actor.side
            ) {
              this.revive(target, effect.hpRatio);
              u.revives.delete(target.id);
            }
          } else if (target.hp > 0)
            this.effect(actor, target, effect, snapshot, command, u);
        }
      }
      for (const candidate of u.follows) {
        const follower = this.participant(candidate.actorId);
        const target = this.participant(candidate.targetId);
        const status = follower.statuses.find(
          (s) => s.id === candidate.statusId,
        );
        if (
          actor.hp > 0 &&
          target.hp > 0 &&
          canReact(follower) &&
          status?.spec.familyId === 'follow' &&
          !u.usedReactions.has(status.id)
        ) {
          u.usedReactions.add(status.id);
          this.record('follow', follower.id, target.id);
          this.attack(
            follower,
            target,
            status.spec.attack,
            [],
            actorSnapshot(follower),
            command,
            u,
            false,
            true,
          );
        }
      }
    }
    this.finishUnit(u);
    if (this.state.result === 'ongoing' && actor.action.kind === 'acting')
      actor.action = {
        kind: 'waiting',
        ready: this.timer(
          actor,
          delayTU(skill.delay, snapshot.spd) + actor.action.pendingKnockback,
        ),
      };
  }
  /**
   * 現在の1対象に攻撃・回復・罠・補助効果を適用する。蘇生は呼び出し元で扱う。
   *
   * @param actor 効果の実行者。
   * @param target 効果の対象。
   * @param effect 今回適用する効果データ。
   * @param snapshot 発動直前に固定した行動者の能力とHP。
   * @param command 使用スキル・予約対象・属性選択を含むコマンド。プレイヤー入力では行動者IDも含む。
   * @param u 当該処理単位の反応実行記録と自己蘇生予約。
   */
  effect(
    actor: BattleParticipant,
    target: BattleParticipant,
    effect: Effect,
    snapshot: ActorSnapshot,
    command: CommandReservation,
    u: Unit,
  ) {
    if (effect.kind === 'attack')
      this.attack(
        actor,
        target,
        effect,
        effect.attached,
        snapshot,
        command,
        u,
        true,
        effect.target === 'selected',
      );
    else if (effect.kind === 'heal') {
      const amount = Math.min(
        target.stats.maxHp - target.hp,
        healAmount(effect.power, snapshot),
      );
      target.hp += amount;
      this.record('heal', actor.id, target.id, amount);
    } else if (effect.kind === 'trap') {
      if (target.side !== 'enemy') return;
      this.state.traps = this.state.traps.filter(
        (t) => t.sourceId !== actor.id,
      );
      this.state.traps.push({
        sourceId: actor.id,
        targetId: target.id,
        sequence: this.state.nextSequence++,
        expires: this.timer(actor, effect.duration),
        attack: structuredClone(effect.attack),
        attached: structuredClone(effect.attached),
        snapshot: 'on-trigger',
      });
      this.record('trap', actor.id, target.id, effect.duration, 'set');
    } else if (effect.kind !== 'revive') this.utility(actor, target, effect);
  }
  /**
   * CDを確定時刻から開始し、詠唱を予約するか即時効果を発動する。
   *
   * @param actor 効果の実行者。
   * @param command 使用スキル・予約対象・属性選択を含むコマンド。プレイヤー入力では行動者IDも含む。
   */
  startCommand(actor: BattleParticipant, command: CommandReservation) {
    const skill = this.skill(command.skillId);
    actor.cooldowns = actor.cooldowns.filter((c) => c.id !== skill.cooldownId);
    if (skill.cooldown > 0)
      actor.cooldowns.push({
        id: skill.cooldownId,
        timer: this.timer(actor, skill.cooldown),
      });
    this.record(
      'command',
      actor.id,
      command.selectedTargetId,
      null,
      null,
      skill.id,
    );
    if (skill.castTime > 0) {
      actor.action = {
        kind: 'casting',
        cast: {
          command: structuredClone(command),
          completes: this.timer(actor, skill.castTime),
        },
      };
      this.record(
        'cast',
        actor.id,
        command.selectedTargetId,
        skill.castTime,
        null,
        skill.id,
      );
    } else this.activate(actor, command);
  }
  /**
   * 現在フェーズと行動列からコマンドを作り、公開規則と挑発で単体対象を確定する。
   *
   * @param p 処理対象の戦闘参加者。
   */
  enemyCommand(p: BattleParticipant): CommandReservation {
    if (p.side !== 'enemy') throw new Error('Expected enemy');
    const action = this.enemy(p)!.phases[p.phaseIndex]!.actions[p.actionIndex]!;
    const skill = this.skill(action.skillId);
    let selected: ParticipantId | null = null;
    if (!['self', 'ally-all', 'enemy-all'].includes(skill.target)) {
      const targets = this.state.participants.filter((target) =>
        this.eligible(p, target, skill.target),
      );
      /**
       * 敵AIの公開された対象規則に対応するHPまたは最終能力を取得する。
       *
       * @param target 効果の対象。
       */
      const metric = (target: BattleParticipant) =>
        action.selection === 'lowest-hp'
          ? target.hp
          : effectiveStats(target)[
              action.selection === 'highest-atk'
                ? 'atk'
                : action.selection === 'highest-mag'
                  ? 'mag'
                  : 'spd'
            ];
      targets.sort((a, b) =>
        action.selection === 'lowest-hp'
          ? metric(a) - metric(b)
          : metric(b) - metric(a),
      );
      selected = targets[0]?.id ?? null;
      const taunt = p.statuses.find((s) => s.spec.familyId === 'taunt');
      if (taunt) {
        const source = this.participant(taunt.sourceId);
        if (source.hp > 0 && source.side !== p.side) selected = source.id;
      }
    }
    return {
      skillId: skill.id,
      selectedTargetId: selected,
      chosenElement: skill.elementChoices[0] ?? null,
    };
  }
  /**
   * 敵の行動開始前に罠を設置順で解決し、開始可能なら行動列を消費してコマンドを確定する。
   *
   * @param p 処理対象の戦闘参加者。
   * @param stopAfterUnit trueなら1処理単位の解決後に停止する。既定は次の入力または終了まで進める。
   */
  startEnemy(p: BattleParticipant, stopAfterUnit = false) {
    const traps = this.state.traps
      .filter((t) => t.targetId === p.id)
      .sort((a, b) => a.sequence - b.sequence);
    for (const trap of traps) {
      const source = this.participant(trap.sourceId);
      if (!canReact(source)) continue;
      this.state.traps = this.state.traps.filter(
        (t) => t.sequence !== trap.sequence,
      );
      this.record('trap', source.id, p.id, null, 'trigger');
      const u = unit();
      this.attack(
        source,
        p,
        trap.attack,
        trap.attached,
        actorSnapshot(source),
        {
          skillId: 'basic-attack',
          selectedTargetId: p.id,
          chosenElement: null,
        },
        u,
        false,
        true,
      );
      this.finishUnit(u);
      if (stopAfterUnit) return;
      if (
        this.state.result !== 'ongoing' ||
        !canReact(p) ||
        p.action.kind !== 'ready'
      )
        return;
    }
    const command = this.enemyCommand(p);
    this.consumeEnemyAction(p);
    this.startCommand(p, command);
  }
  /** 現在の有効タイマーから予定を再構築する。既存予定のIDを維持し、消えた予定を除去する。 */
  syncTimeline() {
    if (this.state.result !== 'ongoing') {
      this.state.timeline = [];
      return;
    }
    const previous = this.state.timeline;
    const next: TimelineEvent[] = [];
    /**
     * 凍結していないタイマーからイベントを生成し、同じ予定の既存IDを引き継ぐ。
     *
     * @param p 処理対象の戦闘参加者。
     * @param timer 絶対時刻または凍結残りTUを保持するタイマー。
     * @param details イベント種別と、必要に応じた状態IDまたは罠連番。
     * @param sequence 同じ参加者・優先度内の付与順。
     */
    const add = (
      p: BattleParticipant,
      timer: Timer,
      details: Pick<TimelineEvent, 'kind'> & {
        statusId?: number;
        trapSequence?: number;
      },
      sequence: number,
    ) => {
      if (timer.kind === 'frozen') return;
      const old = previous.find(
        (e) =>
          e.participantId === p.id &&
          e.kind === details.kind &&
          ('statusId' in e ? e.statusId : null) ===
            (details.statusId ?? null) &&
          ('trapSequence' in e ? e.trapSequence : null) ===
            (details.trapSequence ?? null),
      );
      next.push({
        id: old?.id ?? this.state.nextSequence++,
        participantId: p.id,
        at: timer.at,
        sequence,
        ...details,
      } as TimelineEvent);
    };
    this.state.participants.forEach((p) => {
      if (p.hp === 0) return;
      if (p.timeStopUntil !== null)
        add(
          p,
          { kind: 'running', at: p.timeStopUntil },
          { kind: 'time-stop-end' },
          0,
        );
      for (const s of p.statuses)
        if (s.spec.familyId !== 'time-stop') {
          add(
            p,
            s.expires,
            { kind: 'status-expiry', statusId: s.id },
            s.sequence,
          );
          if (s.nextTick)
            add(
              p,
              s.nextTick,
              { kind: 'poison-tick', statusId: s.id },
              s.sequence,
            );
        }
      for (const t of this.state.traps)
        if (t.sourceId === p.id)
          add(
            p,
            t.expires,
            { kind: 'trap-expiry', trapSequence: t.sequence },
            t.sequence,
          );
      const a = p.action;
      if (a.kind === 'ready' && p.timeStopUntil === null)
        add(p, { kind: 'running', at: this.state.now }, { kind: 'ready' }, 0);
      if (a.kind === 'waiting') add(p, a.ready, { kind: 'ready' }, 0);
      if (a.kind === 'casting')
        add(p, a.cast.completes, { kind: 'cast-complete' }, 0);
      if (a.kind === 'broken')
        add(p, a.break.recovers, { kind: 'break-recovery' }, 0);
    });
    /**
     * 同着解決用の固定参加者順を取得する。
     *
     * @param id 検索するID。
     */
    const position = (id: ParticipantId) =>
      this.state.participants.findIndex((p) => p.id === id);
    next.sort(
      (a, b) =>
        a.at - b.at ||
        priorities[a.kind] - priorities[b.kind] ||
        position(a.participantId) - position(b.participantId) ||
        a.sequence - b.sequence,
    );
    this.state.timeline = next;
  }
  /**
   * 時刻・種別・参加者・付与順で予定を再評価し、味方入力または終了まで進める。
   *
   * @param stopAfterUnit trueなら1処理単位の解決後に停止する。既定は次の入力または終了まで進める。
   */
  advance(stopAfterUnit = false) {
    // 各処理で現在の有効タイマーから予定を再構築し、削除・延期された古い予定を実行しない。
    while (this.state.result === 'ongoing') {
      this.syncTimeline();
      const event = this.state.timeline[0];
      if (!event) throw new Error('Ongoing battle has no scheduled events');
      this.state.now = Math.max(this.state.now, event.at);
      const p = this.participant(event.participantId);
      if (event.kind === 'time-stop-end') {
        const status = p.statuses.find((s) => s.spec.familyId === 'time-stop');
        if (status) this.removeStatus(p, status, 'expire');
        else this.thaw(p);
      } else if (event.kind === 'status-expiry') {
        const status = p.statuses.find((s) => s.id === event.statusId);
        if (status) this.removeStatus(p, status, 'expire');
      } else if (event.kind === 'trap-expiry') {
        this.state.traps = this.state.traps.filter(
          (t) => t.sequence !== event.trapSequence,
        );
        this.record('expire', p.id, null, null, 'trap');
      } else if (event.kind === 'break-recovery') {
        if (p.side === 'enemy' && p.action.kind === 'broken') {
          p.breakGauge = p.maxBreakGauge;
          p.action = {
            kind: 'waiting',
            ready: this.timer(p, initialWaitTU(effectiveStats(p).spd)),
          };
          this.record('recover', p.id);
        }
      } else if (event.kind === 'poison-tick') {
        const u = unit();
        for (const target of this.state.participants) {
          for (const status of [...target.statuses].sort(
            (a, b) => a.sequence - b.sequence,
          )) {
            if (
              target.hp > 0 &&
              status.spec.familyId === 'poison' &&
              status.nextTick &&
              due(status.nextTick, this.state.now)
            ) {
              status.nextTick = { kind: 'running', at: this.state.now + 20 };
              this.loseHp(
                target,
                status.spec.damage,
                status.sourceId,
                u,
                'poison',
              );
            }
          }
        }
        this.finishUnit(u);
      } else if (event.kind === 'cast-complete') {
        if (p.action.kind === 'casting')
          this.activate(p, p.action.cast.command);
      } else {
        p.action = { kind: 'ready' };
        if (p.side === 'party') {
          this.syncTimeline();
          return;
        }
        this.startEnemy(p, stopAfterUnit);
      }
      if (
        stopAfterUnit &&
        ['poison-tick', 'cast-complete', 'ready'].includes(event.kind)
      ) {
        this.syncTimeline();
        return;
      }
    }
    this.syncTimeline();
  }
  /**
   * 現在の敵予定を表示用の予告へ変換する。停止中は絶対時刻を示さず残りTUを返す。
   *
   * @param p 処理対象の戦闘参加者。
   */
  forecast(p: BattleParticipant): EnemyForecast {
    if (p.side !== 'enemy') throw new Error('Expected enemy');
    const isCasting = p.action.kind === 'casting';
    const command =
      p.action.kind === 'casting'
        ? p.action.cast.command
        : this.enemyCommand(p);
    const timer = this.actionTimer(p);
    const startsAt =
      !isCasting &&
      p.action.kind !== 'broken' &&
      p.action.kind !== 'finished' &&
      p.hp > 0 &&
      p.timeStopUntil === null
        ? timer?.kind === 'running'
          ? timer.at
          : this.state.now
        : null;
    const activatesAt = isCasting
      ? timer?.kind === 'running'
        ? timer.at
        : null
      : startsAt === null
        ? null
        : startsAt + this.skill(command.skillId).castTime;
    const targets = command.selectedTargetId
      ? [command.selectedTargetId]
      : this.targetIds(p, this.skill(command.skillId));
    return {
      enemyId: p.id,
      command: structuredClone(command),
      targets,
      startsAt,
      activatesAt,
      frozenRemaining: timer?.kind === 'frozen' ? timer.remaining : null,
      isCasting,
      blocked: !canReact(p),
      phaseIndex: p.phaseIndex,
      actionIndex: p.actionIndex,
    };
  }
}
