import type {
  BattleParticipant,
  BattleState,
  ParticipantId,
} from '../data/battle';
import type {
  CharacterId,
  EnemyId,
  GameContent,
  SkillId,
  Stats,
} from '../data/model';
import { parseGameContent } from '../data/validation';
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
export type * from './types';
export { effectiveStats } from './calculations';
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
  const stats: Stats = { ...definition.baseStats };
  for (const id of build.equipment)
    if (id !== null) {
      const item = content.equipment.find((e) => e.id === id);
      if (!item) throw new Error(`Unknown equipment: ${id}`);
      for (const key of Object.keys(stats) as (keyof Stats)[])
        stats[key] += item.stats[key] ?? 0;
    }
  const finalStats = clampStats(stats);
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
      ready: { kind: 'running', at: initialWaitTU(finalStats.spd) },
    },
    statuses: [],
    cooldowns: [],
    timeStopUntil: null,
  };
}
/** Initialize at TU0, then stop at the first party input (enemy events may precede it). */
export function createBattle<T = null>(
  input: GameContent,
  setup: BattleSetup,
  preBattle: T = null as T,
): BattleSession<T> {
  const content = parseGameContent(input);
  if (
    setup.party.length !== 3 ||
    setup.party.some((p, i) => p.id !== `party-${i + 1}`)
  )
    throw new Error('Party slots must be party-1, party-2, party-3');
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
export function checkCommand<T>(
  session: BattleSession<T>,
  command: PlayerCommand,
) {
  return new Engine(session.content, session.state, session.log).checkCommand(
    command,
  );
}
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
export function getInputActor<T>(
  session: BattleSession<T>,
): CharacterId | null {
  return (
    new Engine(session.content, session.state, session.log).inputActor()?.id ??
    null
  );
}
export function getSkillTargets<T>(
  session: BattleSession<T>,
  actorId: ParticipantId,
  skillId: SkillId,
): ParticipantId[] {
  const engine = new Engine(session.content, session.state, session.log);
  return engine.targetIds(engine.participant(actorId), engine.skill(skillId));
}
export function getEnemyForecast<T>(
  session: BattleSession<T>,
  enemyId: EnemyId = session.setup.enemyId,
) {
  const engine = new Engine(session.content, session.state, session.log);
  return engine.forecast(engine.participant(enemyId));
}
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
/** Returns a pure reward candidate; the persistence layer must commit it atomically once. */
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
export function getDebugSnapshot<T>(session: BattleSession<T>) {
  return structuredClone({ state: session.state, log: session.log });
}
