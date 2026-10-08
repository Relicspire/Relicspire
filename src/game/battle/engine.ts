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
const WAIT: SkillDefinition = {
  ...BASIC,
  id: 'wait',
  target: 'self',
  delay: 20,
  cooldownId: 'wait',
  effects: [],
};
const priorities: Record<TimelineEvent['kind'], number> = {
  'time-stop-end': 0,
  'status-expiry': 1,
  'trap-expiry': 1,
  'break-recovery': 2,
  'poison-tick': 3,
  'cast-complete': 4,
  ready: 5,
};
const due = (timer: Timer, now: number) =>
  timer.kind === 'running' && timer.at <= now;
export const canReact = (p: BattleParticipant) =>
  p.hp > 0 &&
  p.action.kind !== 'broken' &&
  p.action.kind !== 'finished' &&
  p.timeStopUntil === null;
const polarity = (spec: StatusSpec) =>
  ['atk-down', 'mag-down', 'spd-down', 'poison', 'taunt', 'time-stop'].includes(
    spec.familyId,
  )
    ? 'debuff'
    : 'buff';
interface Unit {
  revives: Map<ParticipantId, number>;
  usedReactions: Set<number>;
  follows: {
    actorId: ParticipantId;
    statusId: number;
    targetId: ParticipantId;
  }[];
  firstHit: boolean;
}
const unit = (): Unit => ({
  revives: new Map(),
  usedReactions: new Set(),
  follows: [],
  firstHit: false,
});
/** Internal mutation is confined to a cloned session by the public functional API. */
export class Engine {
  constructor(
    readonly content: GameContent,
    readonly state: BattleState,
    readonly log: BattleLogEntry[],
  ) {}
  participant(id: ParticipantId): BattleParticipant {
    const found = this.state.participants.find((p) => p.id === id);
    if (!found) throw new Error(`Unknown participant: ${id}`);
    return found;
  }
  skill(id: SkillId): SkillDefinition {
    if (id === 'basic-attack') return BASIC;
    if (id === 'wait') return WAIT;
    const found = this.content.skills.find((s) => s.id === id);
    if (!found) throw new Error(`Unknown skill: ${id}`);
    return found;
  }
  enemy(p: BattleParticipant): EnemyDefinition | null {
    return p.side === 'enemy'
      ? (this.content.enemies.find((e) => e.id === p.id) ?? null)
      : null;
  }
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
  timer(p: BattleParticipant, duration: number): Timer {
    return p.timeStopUntil === null
      ? { kind: 'running', at: this.state.now + duration }
      : { kind: 'frozen', remaining: duration };
  }
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
  thaw(p: BattleParticipant) {
    p.timeStopUntil = null;
    this.transformTimers(p, (t) =>
      t.kind === 'frozen'
        ? { kind: 'running', at: this.state.now + t.remaining }
        : t,
    );
  }
  removeStatus(
    p: BattleParticipant,
    s: StatusEffect,
    kind: 'expire' | 'dispel',
  ) {
    p.statuses = p.statuses.filter((item) => item.id !== s.id);
    if (s.spec.familyId === 'time-stop') this.thaw(p);
    this.record(kind, s.sourceId, p.id, null, s.spec.familyId);
  }
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
  targetIds(actor: BattleParticipant, skill: SkillDefinition): ParticipantId[] {
    return this.state.participants
      .filter((p) => this.eligible(actor, p, skill.target))
      .map((p) => p.id);
  }
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
      const job = this.content.jobs.find((j) => j.id === actor.jobId);
      const nodes = job ? [...job.routes.a, ...job.routes.b] : [];
      const node = nodes.find((n) => n.skillId === skill.id);
      if (
        !node ||
        nodes.some(
          (n) =>
            actor.learnedSkills.includes(n.id) &&
            n.replacementGroup === node.replacementGroup &&
            n.rank > node.rank,
        )
      )
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
      // No scheduled timer survives a finished battle; participant HP remains available in the result.
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
  consumeEnemyAction(p: BattleParticipant) {
    if (p.side !== 'enemy') return;
    const phase = this.enemy(p)!.phases[p.phaseIndex]!;
    p.actionIndex = (p.actionIndex + 1) % phase.actions.length;
  }
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
        // casting/acting already consumed this column; waiting/ready have not.
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
  enemyCommand(p: BattleParticipant): CommandReservation {
    if (p.side !== 'enemy') throw new Error('Expected enemy');
    const action = this.enemy(p)!.phases[p.phaseIndex]!.actions[p.actionIndex]!;
    const skill = this.skill(action.skillId);
    let selected: ParticipantId | null = null;
    if (!['self', 'ally-all', 'enemy-all'].includes(skill.target)) {
      const targets = this.state.participants.filter((target) =>
        this.eligible(p, target, skill.target),
      );
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
  syncTimeline() {
    if (this.state.result !== 'ongoing') {
      this.state.timeline = [];
      return;
    }
    const previous = this.state.timeline;
    const next: TimelineEvent[] = [];
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
  advance(stopAfterUnit = false) {
    // Each dispatch re-derives the queue from authoritative timers. Removed/delayed events cannot run stale.
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
