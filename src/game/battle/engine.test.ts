import { describe, expect, it, vi } from 'vitest';
import type {
  BattleParticipant,
  CommandReservation,
  StatusEffect,
} from '../data/battle';
import type { Effect, StatusSpec } from '../data/model';
import { actorSnapshot, damageAmount, effectiveStats } from './calculations';
import { Engine } from './engine';
import { attackPayload, fixture, skill } from './fixtures.test-support';
import {
  advanceBattle,
  checkCommand,
  createBattle,
  escapeBattle,
  getBattleOutcome,
  getDebugSnapshot,
  getEnemyForecast,
  getInputActor,
  getSkillTargets,
  retryBattle,
  submitCommand,
} from './index';
import type { BattleSession, PlayerCommand } from './types';
/**
 * テストセッションの固定敵枠を取得する。
 *
 * @param s テスト用の戦闘セッション。
 */
const enemy = (s: BattleSession) => s.state.participants[3];
/**
 * テストセッションの味方1を取得する。
 *
 * @param s テスト用の戦闘セッション。
 */
const actor = (s: BattleSession) => s.state.participants[0];
/**
 * 味方1が入力する属性選択なしのテストコマンドを生成する。
 *
 * @param skillId 使用または照会するスキルID。
 * @param selectedTargetId 予約する単体対象ID。自身・全体の場合はnull。
 */
const command = (
  skillId: PlayerCommand['skillId'] = 'basic-attack',
  selectedTargetId: PlayerCommand['selectedTargetId'] = 'boss-01',
): PlayerCommand => ({
  actorId: 'party-1',
  skillId,
  selectedTargetId,
  chosenElement: null,
});
/**
 * 行動者IDを含まないテスト用の予約コマンドを生成する。
 *
 * @param skillId 使用または照会するスキルID。
 * @param selectedTargetId 予約する単体対象ID。自身・全体の場合はnull。
 */
const reservation = (
  skillId: CommandReservation['skillId'],
  selectedTargetId: CommandReservation['selectedTargetId'] = null,
): CommandReservation => ({ skillId, selectedTargetId, chosenElement: null });
/**
 * テストでコマンドを確定し、成功した更新セッションを取得する。不正入力はテストを失敗させる。
 *
 * @param s テスト用の戦闘セッション。
 * @param c テストで確定するプレイヤーコマンド。
 */
function submit(s: BattleSession, c: PlayerCommand): BattleSession {
  const result = submitCommand(s, c);
  if (!result.ok) throw new Error(result.reason);
  return result.session;
}
/**
 * テスト内で境界状態を操作する内部エンジンを生成する。
 *
 * @param s テスト用の戦闘セッション。
 */
function engine(s: BattleSession) {
  return new Engine(s.content, s.state, s.log);
}
/**
 * 指定TUで味方1が到達する境界テスト状態へ組み替え、予定を同期する。
 *
 * @param s テスト用の戦闘セッション。
 * @param now テスト開始の論理時刻。既定は100 TU。
 */
function prepare(s: BattleSession, now = 100) {
  s.state.now = now;
  for (const p of s.state.participants)
    p.action = { kind: 'waiting', ready: { kind: 'running', at: now + 400 } };
  actor(s).action = { kind: 'waiting', ready: { kind: 'running', at: now } };
  s.state.timeline = [];
  engine(s).syncTimeline();
  return s;
}
/**
 * 付与順と期限を持つ状態をテスト参加者へ直接設定する。
 *
 * @param s テスト用の戦闘セッション。
 * @param target 効果の対象。
 * @param spec 付与する状態効果の性能。
 * @param expires 状態の期限を示す絶対TU。
 * @param sourceId 付与者として記録する参加者ID。
 */
function status(
  s: BattleSession,
  target: BattleParticipant,
  spec: StatusSpec,
  expires = 500,
  sourceId: StatusEffect['sourceId'] = 'party-1',
): StatusEffect {
  const seq = s.state.nextSequence++;
  const item: StatusEffect = {
    id: seq,
    sequence: seq,
    sourceId,
    spec,
    expires: { kind: 'running', at: expires },
    dispellable: true,
    nextTick:
      spec.familyId === 'poison'
        ? { kind: 'running', at: s.state.now + 20 }
        : null,
    remainingCharges: 'charges' in spec ? spec.charges : null,
  };
  target.statuses.push(item);
  return item;
}
/**
 * テスト用攻撃Effectを指定の対象束縛で生成する。
 *
 * @param target Effectの対象束縛。既定はselected。
 * @param overrides 既定のテストデータから上書きする項目。
 */
function atk(
  target: Effect['target'] = 'selected',
  overrides: Partial<ReturnType<typeof attackPayload>> = {},
): Effect {
  return { ...attackPayload(overrides), kind: 'attack', target, attached: [] };
}

describe('initialization and functional command API', () => {
  it('starts full HP at the deterministic first slot and pauses TU during input', () => {
    const s = fixture();
    expect(s.state.now).toBe(100);
    expect(getInputActor(s)).toBe('party-1');
    expect(
      s.state.participants.every(
        (p) =>
          p.hp === p.stats.maxHp &&
          p.statuses.length === 0 &&
          p.cooldowns.length === 0,
      ),
    ).toBe(true);
    expect(s.initialState.now).toBe(0);
    expect(advanceBattle(s)).toEqual(s);
    expect(getEnemyForecast(s)).toMatchObject({
      startsAt: 125,
      activatesAt: 125,
      command: { selectedTargetId: 'party-1' },
    });
  });
  it('uses equipment and clamps initial stats', () => {
    const s = fixture();
    s.content.equipment.push({
      id: 'starter-boots',
      kind: 'starter',
      stats: { spd: 999 },
      maxOwned: 3,
    });
    s.setup.party[0].equipment[0] = 'starter-boots';
    const next = createBattle(s.content, s.setup);
    expect(effectiveStats(actor(next)).spd).toBe(400);
    expect(next.state.now).toBe(25);
    status(next, actor(next), { familyId: 'spd-down', magnitude: 10000 });
    expect(effectiveStats(actor(next)).spd).toBe(274);
  });
  it('processes enemy actions and slot ties in order', () => {
    let s = fixture();
    s = submit(s, command('wait', null));
    expect(getInputActor(s)).toBe('party-2');
    expect(s.state.now).toBe(100);
    s = submit(s, { ...command('wait', null), actorId: 'party-2' });
    expect(getInputActor(s)).toBe('party-3');
    s = submit(s, { ...command('wait', null), actorId: 'party-3' });
    expect(s.state.now).toBe(120);
    expect(getInputActor(s)).toBe('party-1');
    s = submit(s, command('wait', null));
    s = submit(s, { ...command('wait', null), actorId: 'party-2' });
    s = submit(s, { ...command('wait', null), actorId: 'party-3' });
    expect(actor(s).hp).toBe(270);
    expect(
      s.log.find((e) => e.kind === 'command' && e.actorId === 'boss-01')?.now,
    ).toBe(125);
  });
  it.each([
    { ...command(), actorId: 'party-2' as const },
    command('wizard-a3'),
    command('knight-a1', null),
    command('basic-attack', 'party-2'),
    { ...command(), chosenElement: 'ice' as const },
    command('knight-a2', 'boss-01'),
  ])('rejects invalid input atomically', (c) => {
    const s = fixture();
    const before = structuredClone(s);
    const result = submitCommand(s, c);
    expect(result.ok).toBe(false);
    expect(result.session).toBe(s);
    expect(s).toEqual(before);
  });
  it('hides lower ranks and shares their cooldown', () => {
    const s = fixture();
    expect(checkCommand(s, command('knight-a1', null)).ok).toBe(false);
    actor(s).cooldowns.push({
      id: 'knight-a',
      timer: { kind: 'running', at: 101 },
    });
    expect(checkCommand(s, command('knight-a2', null))).toEqual({
      ok: false,
      reason: 'Skill is on cooldown',
    });
    actor(s).cooldowns[0]!.timer = { kind: 'running', at: 100 };
    expect(checkCommand(s, command('knight-a2', null)).ok).toBe(true);
  });
  it('chooses and preserves an element through casting', () => {
    const s = fixture({
      jobs: ['wizard', 'knight', 'cleric'],
      skills: [
        skill('wizard-a3', {
          target: 'enemy-single',
          castTime: 30,
          elementChoices: ['ice', 'lightning'],
          effects: [atk('selected', { element: 'chosen' })],
        }),
      ],
    });
    expect(checkCommand(s, command('wizard-a3')).ok).toBe(false);
    const next = submit(s, {
      ...command('wizard-a3'),
      chosenElement: 'lightning',
    });
    expect(actor(next).action).toMatchObject({
      kind: 'casting',
      cast: {
        command: { chosenElement: 'lightning', selectedTargetId: 'boss-01' },
        completes: { at: 130 },
      },
    });
    expect(s.state.now).toBe(100);
    expect(actor(s).action.kind).toBe('ready');
  });
  it('excludes already-arrived waiting allies from advance targets', () => {
    const s = fixture({
      jobs: ['time-mage', 'wizard', 'cleric'],
      skills: [
        skill('time-mage-a3', {
          target: 'waiting-ally-other',
          effects: [
            {
              kind: 'shift',
              target: 'selected',
              direction: 'advance',
              amount: 20,
            },
          ],
        }),
      ],
    });
    expect(getSkillTargets(s, 'party-1', 'time-mage-a3')).toEqual([]);
    s.state.participants[1].action = {
      kind: 'casting',
      cast: {
        command: reservation('wizard-a3'),
        completes: { kind: 'running', at: 100 },
      },
    };
    expect(getSkillTargets(s, 'party-1', 'time-mage-a3')).toEqual(['party-2']);
  });
});

describe('damage, healing, snapshots and end conditions', () => {
  it('uses current target defense, weakness and gauge resistance', () => {
    const s = fixture({
      jobs: ['wizard', 'knight', 'cleric'],
      skills: [
        skill('wizard-a3', {
          target: 'enemy-single',
          effects: [
            atk('selected', {
              damageType: 'magic',
              element: 'lightning',
              power: 180,
              breakDamage: 35,
            }),
          ],
        }),
      ],
      enemy: { breakResistance: 5000 },
      enemyStats: { mdef: 12 },
    });
    const next = submit(s, command('wizard-a3'));
    expect(enemy(next).hp).toBe(9910);
    expect(enemy(next)).toMatchObject({ breakGauge: 465 });
  });
  it('rounds only once using exact rational arithmetic', () => {
    const s = fixture({ enemyStats: { def: 0 } });
    actor(s).stats.atk = 30;
    status(s, enemy(s), { familyId: 'physical-guard', magnitude: 3000 });
    expect(
      damageAmount(
        attackPayload({ power: 100, element: 'lightning' }),
        actorSnapshot(actor(s)),
        enemy(s),
        'lightning',
        s.content.enemies[0]!,
      ),
    ).toBe(31);
    actor(s).stats.atk = 20;
    expect(
      damageAmount(
        attackPayload({ power: 105 }),
        actorSnapshot(actor(s)),
        enemy(s),
        'lightning',
        s.content.enemies[0]!,
      ),
    ).toBe(22);
  });
  it('B15: computes delay from SPD saved before self buff', () => {
    const s = fixture({
      jobs: ['time-mage', 'wizard', 'cleric'],
      skills: [
        skill('time-mage-a3', {
          target: 'ally-all',
          effects: [
            {
              kind: 'apply-status',
              target: 'all-allies',
              status: { familyId: 'spd-up', magnitude: 2500 },
              duration: 180,
              dispellable: true,
            },
          ],
        }),
      ],
    });
    const next = submit(s, command('time-mage-a3', null));
    expect(actor(next).action).toMatchObject({
      kind: 'waiting',
      ready: { at: 190 },
    });
    expect(effectiveStats(actor(next)).spd).toBe(125);
  });
  it('B14: finishes self healing after killing the required enemy', () => {
    const s = fixture({
      jobs: ['paladin', 'wizard', 'cleric'],
      skills: [
        skill('paladin-a3', {
          target: 'enemy-single',
          effects: [
            atk(),
            {
              kind: 'heal',
              target: 'self',
              power: 100,
              actorReference: 'before-activation',
              targetReference: 'before-effect',
            },
          ],
        }),
      ],
      enemyStats: { maxHp: 20 },
    });
    actor(s).hp = 50;
    const next = submit(s, command('paladin-a3'));
    expect(next.state.result).toBe('victory');
    expect(actor(next).hp).toBe(90);
    expect(next.state.timeline).toEqual([]);
    expect(() => retryBattle(next)).toThrow();
    expect(getBattleOutcome(next).reward).not.toBeNull();
  });
  it('uses the pre-heal HP condition for all effects of a low-HP action', () => {
    const s = fixture({
      jobs: ['berserker', 'wizard', 'cleric'],
      skills: [
        skill('berserker-b3', {
          target: 'enemy-single',
          effects: [
            {
              kind: 'heal',
              target: 'self',
              power: 200,
              actorReference: 'before-activation',
              targetReference: 'before-effect',
            },
            atk('selected', {
              power: {
                kind: 'low-hp',
                normal: 100,
                lowHp: 200,
                snapshot: 'before-activation',
              },
            }),
          ],
        }),
      ],
    });
    actor(s).hp = 140;
    const next = submit(s, command('berserker-b3'));
    expect(enemy(next).hp).toBe(9930);
    expect(actor(next).hp).toBe(220);
  });
  it('B18: immune damage also suppresses all attached effects and gauge damage', () => {
    const effect: Effect = {
      ...attackPayload({ element: 'dark', breakDamage: 300 }),
      kind: 'attack',
      target: 'selected',
      attached: [
        {
          kind: 'shift',
          target: 'hit-recipient',
          direction: 'delay',
          amount: 20,
        },
        {
          kind: 'apply-status',
          target: 'hit-recipient',
          status: { familyId: 'poison', damage: 8, interval: 20 },
          duration: 100,
          dispellable: true,
        },
      ],
    };
    const s = fixture({
      skills: [
        skill('knight-a3', { target: 'enemy-single', effects: [effect] }),
      ],
      enemy: { immuneElements: ['dark'] },
    });
    const next = submit(s, command('knight-a3'));
    expect(enemy(next).hp).toBe(10000);
    expect(enemy(next).statuses).toEqual([]);
    expect(enemy(next)).toMatchObject({
      breakGauge: 500,
      action: { ready: { at: 125 } },
    });
  });
  it('caps healing and ordinary healing cannot resurrect', () => {
    const s = fixture({
      jobs: ['cleric', 'wizard', 'knight'],
      skills: [
        skill('cleric-b3', {
          target: 'ally-all',
          effects: [
            {
              kind: 'heal',
              target: 'all-allies',
              power: 1000,
              actorReference: 'before-activation',
              targetReference: 'before-effect',
            },
          ],
        }),
      ],
    });
    actor(s).hp = 299;
    s.state.participants[1].hp = 0;
    s.state.participants[1].action = { kind: 'dead' };
    const next = submit(s, command('cleric-b3', null));
    expect(actor(next).hp).toBe(300);
    expect(next.state.participants[1].hp).toBe(0);
  });
  it('B07: self revival preserves fixed 50 TU and cooldown after reflection death', () => {
    const s = fixture({
      jobs: ['berserker', 'wizard', 'cleric'],
      skills: [
        skill('berserker-b3', {
          target: 'enemy-single',
          effects: [atk('selected', { damageType: 'magic', power: 100 })],
        }),
      ],
    });
    actor(s).hp = 5;
    status(s, actor(s), { familyId: 'self-revive', hpRatio: 4000, charges: 1 });
    status(s, enemy(s), { familyId: 'reflect', ratio: 5000, charges: 1 });
    const next = submit(s, command('berserker-b3'));
    expect(actor(next).hp).toBe(120);
    expect(actor(next).action).toMatchObject({
      kind: 'waiting',
      ready: { at: 150 },
    });
    expect(actor(next).cooldowns[0]?.timer).toEqual({
      kind: 'running',
      at: 220,
    });
    expect(actor(next).statuses).toEqual([]);
  });
  it('only cleric-a3 revives another dead ally and retains their CD', () => {
    const s = fixture({
      jobs: ['cleric', 'wizard', 'knight'],
      skills: [
        skill('cleric-a3', {
          target: 'dead-ally-other',
          effects: [{ kind: 'revive', target: 'selected', hpRatio: 5000 }],
        }),
      ],
    });
    const dead = s.state.participants[1];
    dead.hp = 0;
    dead.action = { kind: 'dead' };
    dead.cooldowns = [{ id: 'wizard-a', timer: { kind: 'running', at: 300 } }];
    const next = submit(s, command('cleric-a3', 'party-2'));
    expect(next.state.participants[1]).toMatchObject({
      hp: 150,
      action: { ready: { at: 150 } },
      cooldowns: [{ timer: { at: 300 } }],
    });
    expect(checkCommand(s, command('cleric-a3', 'party-1')).ok).toBe(false);
  });
  it('counts a reflection double KO as defeat after the whole unit', () => {
    const s = fixture({
      jobs: ['wizard', 'knight', 'cleric'],
      skills: [
        skill('wizard-a3', {
          target: 'enemy-single',
          effects: [atk('selected', { damageType: 'magic' })],
        }),
      ],
      enemyStats: { maxHp: 20 },
    });
    actor(s).hp = 5;
    s.state.participants.slice(1, 3).forEach((p) => {
      p.hp = 0;
      p.action = { kind: 'dead' };
    });
    status(s, enemy(s), { familyId: 'reflect', ratio: 5000, charges: 1 });
    const next = submit(s, command('wizard-a3'));
    expect(next.state.result).toBe('defeat');
    expect(getBattleOutcome(next).reward).toBeNull();
  });
  it('restores caller snapshots without modifying progression and replays deterministically', () => {
    const source = fixture();
    const progress = {
      points: 3,
      inventory: ['starter-sword'],
      position: 'floor-01-hall-3',
    };
    const s = createBattle(source.content, source.setup, progress);
    const next = submitCommand(s, command());
    expect(next.ok).toBe(true);
    expect(getBattleOutcome(escapeBattle(s))).toEqual({
      result: 'escaped',
      reward: null,
      preBattle: progress,
    });
    expect(retryBattle(escapeBattle(s))).toEqual(s);
    expect(submitCommand(retryBattle(s), command())).toEqual(next);
    const snapshot = getDebugSnapshot(s);
    snapshot.state.now = 999;
    expect(s.state.now).toBe(100);
    expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
  });
});

describe('casting, break and time manipulation', () => {
  it('B09: a dead reserved target fizzles with delay and retained cooldown', () => {
    const s = prepare(
      fixture({
        skills: [
          skill('knight-a3', {
            target: 'ally-single',
            castTime: 40,
            effects: [
              {
                kind: 'heal',
                target: 'selected',
                power: 100,
                actorReference: 'before-activation',
                targetReference: 'before-effect',
              },
            ],
          }),
        ],
      }),
    );
    actor(s).action = {
      kind: 'casting',
      cast: {
        command: reservation('knight-a3', 'party-2'),
        completes: { kind: 'running', at: 100 },
      },
    };
    actor(s).cooldowns = [
      { id: 'knight-a3', timer: { kind: 'running', at: 200 } },
    ];
    s.state.participants[1].hp = 0;
    s.state.participants[1].action = { kind: 'dead' };
    s.state.participants[2].action = {
      kind: 'waiting',
      ready: { kind: 'running', at: 100 },
    };
    const next = advanceBattle(s);
    expect(actor(next).action).toMatchObject({
      kind: 'waiting',
      ready: { at: 190 },
    });
    expect(actor(next).cooldowns[0]?.timer).toMatchObject({ at: 200 });
    expect(next.log.some((e) => e.kind === 'fizzle')).toBe(true);
  });
  it('B04: delays an unprocessed same-TU enemy without consuming its rotation', () => {
    const s = fixture({
      jobs: ['time-mage', 'wizard', 'cleric'],
      skills: [
        skill('time-mage-b3', {
          target: 'enemy-single',
          effects: [
            {
              kind: 'shift',
              target: 'selected',
              direction: 'delay',
              amount: 20,
            },
          ],
        }),
      ],
    });
    enemy(s).action = { kind: 'waiting', ready: { kind: 'running', at: 100 } };
    const next = submit(s, command('time-mage-b3'));
    expect(enemy(next)).toMatchObject({
      action: { ready: { at: 120 } },
      actionIndex: 0,
      cooldowns: [],
    });
  });
  it('B06: accumulates knockback into the acting participant final wait', () => {
    const s = prepare(
      fixture({
        skills: [
          skill('knight-a3', { target: 'enemy-single', effects: [atk()] }),
        ],
      }),
    );
    const e = engine(s);
    const original = e.attack.bind(e);
    // 汎用的な境界検証として、行動の処理中に時間操作を差し込む。
    vi.spyOn(e, 'attack').mockImplementation((...args) => {
      original(...args);
      e.utility(enemy(s), actor(s), {
        kind: 'shift',
        direction: 'delay',
        amount: 20,
      });
    });
    e.activate(actor(s), reservation('knight-a3', 'boss-01'));
    expect(actor(s).action).toEqual({
      kind: 'waiting',
      ready: { kind: 'running', at: 210 },
    });
  });
  it('canceling a cast makes fixed 30 TU wait and keeps cooldown', () => {
    const s = prepare(fixture());
    const p = s.state.participants[1];
    p.action = {
      kind: 'casting',
      cast: {
        command: reservation('wizard-a3'),
        completes: { kind: 'running', at: 180 },
      },
    };
    p.cooldowns = [{ id: 'wizard-a3', timer: { kind: 'running', at: 300 } }];
    engine(s).utility(actor(s), p, { kind: 'cancel-cast' });
    expect(p.action).toMatchObject({ kind: 'waiting', ready: { at: 130 } });
    expect(p.cooldowns[0]?.timer).toMatchObject({ at: 300 });
    actor(s).action = { kind: 'acting', pendingKnockback: 0 };
    engine(s).utility(p, actor(s), { kind: 'cancel-cast' });
    expect(actor(s).action.kind).toBe('acting');
  });
  it('break cancels casting, consumes one column, recovers before future readiness', () => {
    const s = fixture({
      skills: [
        skill('knight-a3', {
          target: 'enemy-single',
          effects: [atk('selected', { breakDamage: 100 })],
        }),
      ],
      enemy: { maxBreakGauge: 50 },
    });
    enemy(s).action = {
      kind: 'casting',
      cast: {
        command: reservation('boss-01-s1', 'party-1'),
        completes: { kind: 'running', at: 100 },
      },
    };
    const next = submit(s, command('knight-a3'));
    expect(enemy(next)).toMatchObject({
      breakGauge: 0,
      action: { kind: 'broken', break: { recovers: { at: 160 } } },
    });
    expect(next.state.timeline.some((e) => e.kind === 'cast-complete')).toBe(
      false,
    );
    const recovery = structuredClone(enemy(next).action);
    const prepared = prepare(next, 160);
    enemy(prepared).action = recovery;
    actor(prepared).action = {
      kind: 'waiting',
      ready: { kind: 'running', at: 160 },
    };
    const recovered = advanceBattle(prepared);
    expect(enemy(recovered)).toMatchObject({
      breakGauge: 50,
      action: { kind: 'waiting', ready: { at: 285 } },
    });
  });
  it('B08: reaction break preserves recovery and does not consume an acting column twice', () => {
    const s = prepare(
      fixture({
        skills: [
          skill('boss-01-s2', {
            target: 'enemy-single',
            effects: [atk()],
            cooldownId: 'boss-01-s2',
          }),
        ],
        enemy: {
          maxBreakGauge: 5,
          phases: [
            {
              id: 'phase-1',
              hpThreshold: 10000,
              actions: [
                { skillId: 'boss-01-s1', selection: 'lowest-hp' },
                { skillId: 'boss-01-s2', selection: 'lowest-hp' },
              ],
            },
          ],
        },
        enemyStats: { spd: 100 },
      }),
    );
    status(s, actor(s), {
      familyId: 'counter',
      attack: attackPayload({ breakDamage: 5 }),
    });
    enemy(s).action = { kind: 'ready' };
    engine(s).startEnemy(enemy(s));
    expect(enemy(s)).toMatchObject({
      actionIndex: 1,
      action: { kind: 'broken', break: { recovers: { at: 160 } } },
    });
  });
  it('knockback resistance rounds each application up, advance has now+1 floor', () => {
    const s = prepare(fixture({ enemy: { knockbackResistance: 5000 } }));
    enemy(s).action = { kind: 'waiting', ready: { kind: 'running', at: 110 } };
    engine(s).utility(actor(s), enemy(s), {
      kind: 'shift',
      direction: 'delay',
      amount: 1,
    });
    engine(s).utility(actor(s), enemy(s), {
      kind: 'shift',
      direction: 'delay',
      amount: 1,
    });
    expect(enemy(s).action).toMatchObject({ ready: { at: 112 } });
    engine(s).utility(actor(s), enemy(s), {
      kind: 'shift',
      direction: 'advance',
      amount: 500,
    });
    expect(enemy(s).action).toMatchObject({ ready: { at: 101 } });
  });
});

describe('state lifetimes, freezing and simultaneous events', () => {
  it('B01: thawed zero-TU poison expiry precedes its zero-TU tick', () => {
    const s = prepare(fixture());
    const p = s.state.participants[1];
    const poison = status(s, p, {
      familyId: 'poison',
      damage: 8,
      interval: 20,
    });
    poison.expires = { kind: 'frozen', remaining: 0 };
    poison.nextTick = { kind: 'frozen', remaining: 0 };
    status(s, p, { familyId: 'time-stop' }, 100);
    p.timeStopUntil = 100;
    p.action = { kind: 'waiting', ready: { kind: 'frozen', remaining: 50 } };
    const next = advanceBattle(s);
    expect(next.state.now).toBe(100);
    expect(next.state.participants[1].statuses).toEqual([]);
    expect(next.state.participants[1].hp).toBe(300);
  });
  it('B02: thawed zero-TU cast activates once before same-TU party input', () => {
    const s = prepare(
      fixture({
        skills: [
          skill('wizard-a3', { target: 'enemy-single', effects: [atk()] }),
        ],
      }),
    );
    const p = s.state.participants[1];
    p.action = {
      kind: 'casting',
      cast: {
        command: reservation('wizard-a3', 'boss-01'),
        completes: { kind: 'frozen', remaining: 0 },
      },
    };
    status(s, p, { familyId: 'time-stop' }, 100);
    p.timeStopUntil = 100;
    const next = advanceBattle(s);
    expect(enemy(next).hp).toBe(9970);
    expect(
      next.log.filter((e) => e.kind === 'damage' && e.actorId === 'party-2'),
    ).toHaveLength(1);
    expect(getInputActor(next)).toBe('party-1');
    expect(advanceBattle(next)).toEqual(next);
  });
  it('B03: all simultaneous poison ticks resolve before phase transition and input', () => {
    const s = prepare(
      fixture({
        enemyStats: { maxHp: 760 },
        enemy: {
          phases: [
            {
              id: 'phase-1',
              hpThreshold: 10000,
              actions: [{ skillId: 'boss-01-s1', selection: 'lowest-hp' }],
            },
            {
              id: 'phase-2',
              hpThreshold: 5000,
              actions: [{ skillId: 'boss-01-s1', selection: 'lowest-hp' }],
            },
          ],
        },
      }),
    );
    enemy(s).hp = 384;
    status(s, enemy(s), {
      familyId: 'poison',
      damage: 8,
      interval: 20,
    }).nextTick = { kind: 'running', at: 100 };
    status(s, s.state.participants[1], {
      familyId: 'poison',
      damage: 3,
      interval: 20,
    }).nextTick = { kind: 'running', at: 100 };
    const next = advanceBattle(s);
    expect(enemy(next)).toMatchObject({
      hp: 376,
      phaseIndex: 1,
      actionIndex: 0,
    });
    expect(
      next.log
        .filter((e) => e.now === 100 && ['damage', 'phase'].includes(e.kind))
        .map((e) => e.kind),
    ).toEqual(['damage', 'damage', 'phase']);
  });
  it('simultaneous poison deaths form one unit and defeat wins the tie', () => {
    const s = prepare(fixture());
    s.state.participants.forEach((p) => {
      p.hp = 1;
      status(s, p, { familyId: 'poison', damage: 1, interval: 20 }).nextTick = {
        kind: 'running',
        at: 100,
      };
    });
    const next = advanceBattle(s);
    expect(next.state.result).toBe('defeat');
    expect(next.state.participants.every((p) => p.hp === 0)).toBe(true);
    expect(next.log.filter((e) => e.kind === 'damage')).toHaveLength(4);
  });
  it('B10/B16: frozen reapplication preserves strength, author and tick period', () => {
    const s = prepare(fixture());
    const target = enemy(s);
    const e = engine(s);
    target.action = { kind: 'waiting', ready: { kind: 'running', at: 180 } };
    target.cooldowns = [
      { id: 'boss-01-s1', timer: { kind: 'running', at: 180 } },
    ];
    const original = status(
      s,
      target,
      { familyId: 'poison', damage: 8, interval: 20 },
      160,
    );
    e.applyStatus(actor(s), target, { familyId: 'time-stop' }, 30, true);
    s.state.now = 110;
    e.applyStatus(
      s.state.participants[1],
      target,
      { familyId: 'poison', damage: 99, interval: 20 },
      80,
      true,
    );
    s.state.now = 130;
    actor(s).action = { kind: 'waiting', ready: { kind: 'running', at: 130 } };
    const next = advanceBattle(s);
    expect(enemy(next).statuses[0]).toMatchObject({
      id: original.id,
      sourceId: 'party-1',
      spec: { damage: 8 },
      expires: { at: 210 },
      nextTick: { at: 150 },
    });
    expect(enemy(next).cooldowns[0]?.timer).toEqual({
      kind: 'running',
      at: 210,
    });
    expect(enemy(next).action).toMatchObject({ ready: { at: 210 } });
  });
  it('reapplying stop only changes its end and freezes newly added statuses', () => {
    const s = prepare(fixture());
    const p = enemy(s);
    p.action = { kind: 'waiting', ready: { kind: 'running', at: 150 } };
    const e = engine(s);
    e.applyStatus(actor(s), p, { familyId: 'time-stop' }, 30, true);
    s.state.now = 110;
    e.applyStatus(
      s.state.participants[1],
      p,
      { familyId: 'time-stop' },
      40,
      true,
    );
    e.applyStatus(
      actor(s),
      p,
      { familyId: 'spd-down', magnitude: 2500 },
      80,
      true,
    );
    expect(p.action).toMatchObject({
      ready: { kind: 'frozen', remaining: 50 },
    });
    expect(p.timeStopUntil).toBe(150);
    expect(p.statuses[0]?.sourceId).toBe('party-1');
    expect(p.statuses[1]?.expires).toEqual({ kind: 'frozen', remaining: 80 });
    s.state.now = 150;
    actor(s).action = { kind: 'waiting', ready: { kind: 'running', at: 150 } };
    const next = advanceBattle(s);
    expect(enemy(next).action).toMatchObject({ ready: { at: 200 } });
    expect(enemy(next).statuses[0]?.expires).toEqual({
      kind: 'running',
      at: 230,
    });
  });
  it('B11: death thaws CD at death time, later resurrection does not reset it', () => {
    const s = prepare(fixture());
    const p = s.state.participants[1];
    const e = engine(s);
    p.hp = 1;
    p.cooldowns = [{ id: 'wizard-a3', timer: { kind: 'running', at: 180 } }];
    e.applyStatus(actor(s), p, { familyId: 'time-stop' }, 30, true);
    s.state.now = 110;
    e.startCommand(enemy(s), reservation('boss-01-s1', 'party-2'));
    expect(p.hp).toBe(0);
    expect(p.timeStopUntil).toBeNull();
    expect(p.cooldowns[0]?.timer).toEqual({ kind: 'running', at: 190 });
    s.state.now = 150;
    e.revive(p, 5000);
    expect(p.cooldowns[0]?.timer).toEqual({ kind: 'running', at: 190 });
    expect(p.action).toMatchObject({ ready: { at: 200 } });
  });
  it('B12: canceling a stopped cast freezes its 30 TU recovery', () => {
    const s = prepare(fixture());
    const p = s.state.participants[1];
    const e = engine(s);
    p.action = {
      kind: 'casting',
      cast: {
        command: reservation('wizard-a3'),
        completes: { kind: 'running', at: 180 },
      },
    };
    p.cooldowns = [{ id: 'wizard-a3', timer: { kind: 'running', at: 200 } }];
    e.applyStatus(actor(s), p, { familyId: 'time-stop' }, 30, true);
    s.state.now = 110;
    e.utility(actor(s), p, { kind: 'cancel-cast' });
    expect(p.action).toMatchObject({
      ready: { kind: 'frozen', remaining: 30 },
    });
    s.state.now = 130;
    actor(s).action = { kind: 'waiting', ready: { kind: 'running', at: 130 } };
    const next = advanceBattle(s);
    expect(next.state.participants[1].action).toMatchObject({
      ready: { at: 160 },
    });
    expect(next.state.participants[1].cooldowns[0]?.timer).toMatchObject({
      at: 230,
    });
  });
  it('stopped break freezes 60 TU recovery and stop immunity rejects freezing', () => {
    const s = fixture({
      skills: [
        skill('knight-a3', {
          target: 'enemy-single',
          effects: [atk('selected', { breakDamage: 500 })],
        }),
      ],
    });
    const e = engine(s);
    e.applyStatus(actor(s), enemy(s), { familyId: 'time-stop' }, 40, true);
    const next = submit(s, command('knight-a3'));
    expect(enemy(next).action).toMatchObject({
      kind: 'broken',
      break: { recovers: { kind: 'frozen', remaining: 60 } },
    });
    const immune = fixture({ enemy: { timeStopImmune: true } });
    engine(immune).applyStatus(
      actor(immune),
      enemy(immune),
      { familyId: 'time-stop' },
      40,
      true,
    );
    expect(enemy(immune).timeStopUntil).toBeNull();
  });
  it('dispelling stop thaws timers; removed frozen poison never comes back', () => {
    const s = prepare(fixture());
    const p = enemy(s);
    const e = engine(s);
    status(s, p, { familyId: 'poison', damage: 8, interval: 20 });
    e.applyStatus(actor(s), p, { familyId: 'time-stop' }, 40, true);
    e.utility(actor(s), p, { kind: 'dispel', polarity: 'debuff', count: 1 });
    expect(p.statuses.map((x) => x.spec.familyId)).toEqual(['time-stop']);
    e.utility(actor(s), p, { kind: 'dispel', polarity: 'debuff', count: 1 });
    expect(p.statuses).toEqual([]);
    expect(p.action).toMatchObject({ ready: { kind: 'running', at: 500 } });
  });
  it('normal same-family reapplication only refreshes expiry and dispels use grant order', () => {
    const s = prepare(fixture());
    const e = engine(s);
    const p = s.state.participants[1];
    e.applyStatus(
      actor(s),
      p,
      { familyId: 'atk-up', magnitude: 2000 },
      60,
      true,
    );
    const first = structuredClone(p.statuses[0]);
    s.state.now = 130;
    e.applyStatus(
      s.state.participants[2],
      p,
      { familyId: 'atk-up', magnitude: 4000 },
      80,
      true,
    );
    e.applyStatus(
      actor(s),
      p,
      { familyId: 'mag-up', magnitude: 2000 },
      60,
      false,
    );
    expect(p.statuses[0]).toEqual({
      ...first,
      expires: { kind: 'running', at: 210 },
    });
    expect(effectiveStats(p).atk).toBe(48);
    e.utility(actor(s), p, { kind: 'dispel', polarity: 'buff', count: 10 });
    expect(p.statuses.map((x) => x.spec.familyId)).toEqual(['mag-up']);
  });
});

describe('taunt, cover, reflection, retaliation, follow and traps', () => {
  it('taunt overrides live selection only at cast start and remains bound after death', () => {
    const s = prepare(
      fixture({
        skills: [
          skill('boss-01-s1', {
            target: 'enemy-single',
            castTime: 30,
            effects: [atk()],
          }),
        ],
      }),
    );
    const e = engine(s);
    s.state.participants[2].hp = 1;
    status(s, enemy(s), { familyId: 'taunt' }, 500, 'party-2');
    enemy(s).action = { kind: 'ready' };
    e.startEnemy(enemy(s));
    expect(getEnemyForecast(s)).toMatchObject({
      isCasting: true,
      command: { selectedTargetId: 'party-2' },
      activatesAt: 130,
    });
    s.state.participants[1].hp = 0;
    s.state.participants[1].action = { kind: 'dead' };
    e.applyStatus(actor(s), enemy(s), { familyId: 'taunt' }, 600, true);
    expect(enemy(s).statuses[0]?.sourceId).toBe('party-2');
    actor(s).action = { kind: 'waiting', ready: { kind: 'running', at: 130 } };
    const next = advanceBattle(s);
    expect(
      next.log.some((x) => x.kind === 'fizzle' && x.actorId === 'boss-01'),
    ).toBe(true);
    expect(next.state.participants[2].hp).toBe(1);
  });
  it('B13: cover moves damage and attached poison, with no cover chain', () => {
    const hit: Effect = {
      ...attackPayload(),
      kind: 'attack',
      target: 'selected',
      attached: [
        {
          kind: 'apply-status',
          target: 'hit-recipient',
          status: { familyId: 'poison', damage: 8, interval: 20 },
          duration: 120,
          dispellable: true,
        },
      ],
    };
    const s = prepare(
      fixture({
        skills: [
          skill('boss-01-s1', { target: 'enemy-single', effects: [hit] }),
        ],
      }),
    );
    const e = engine(s);
    status(s, actor(s), { familyId: 'cover' }, 500, 'party-2');
    status(s, s.state.participants[1], { familyId: 'cover' }, 500, 'party-3');
    e.startCommand(enemy(s), reservation('boss-01-s1', 'party-1'));
    expect(actor(s).hp).toBe(300);
    expect(s.state.participants[1].hp).toBe(270);
    expect(s.state.participants[2].hp).toBe(300);
    expect(
      s.state.participants[1].statuses.some(
        (x) => x.spec.familyId === 'poison',
      ),
    ).toBe(true);
    expect(actor(s).statuses.some((x) => x.spec.familyId === 'poison')).toBe(
      false,
    );
  });
  it('B13: poison does not attach to a cover recipient killed by the hit', () => {
    const hit: Effect = {
      ...attackPayload(),
      kind: 'attack',
      target: 'selected',
      attached: [
        {
          kind: 'apply-status',
          target: 'hit-recipient',
          status: { familyId: 'poison', damage: 8, interval: 20 },
          duration: 120,
          dispellable: true,
        },
      ],
    };
    const s = prepare(
      fixture({
        skills: [
          skill('boss-01-s1', { target: 'enemy-single', effects: [hit] }),
        ],
      }),
    );
    status(s, actor(s), { familyId: 'cover' }, 500, 'party-2');
    s.state.participants[1].hp = 1;
    engine(s).startCommand(enemy(s), reservation('boss-01-s1', 'party-1'));
    expect(s.state.participants[1].hp).toBe(0);
    expect(s.state.participants[1].statuses).toEqual([]);
    expect(actor(s).hp).toBe(300);
  });
  it('all-target hits ignore cover and freeze their target set before any effect', () => {
    const s = prepare(
      fixture({
        skills: [
          skill('boss-01-s1', {
            target: 'enemy-all',
            effects: [atk('all-enemies')],
          }),
        ],
        enemy: {
          phases: [
            {
              id: 'phase-1',
              hpThreshold: 10000,
              actions: [{ skillId: 'boss-01-s1', selection: 'all' }],
            },
          ],
        },
      }),
    );
    status(s, actor(s), { familyId: 'cover' }, 500, 'party-2');
    engine(s).startCommand(enemy(s), reservation('boss-01-s1'));
    expect(s.state.participants.slice(0, 3).map((p) => p.hp)).toEqual([
      270, 270, 270,
    ]);
  });
  it('reflection saved before the hit survives same-hit stop and dispel; counter is blocked', () => {
    const hit: Effect = {
      ...attackPayload({ damageType: 'magic' }),
      kind: 'attack',
      target: 'selected',
      attached: [
        {
          kind: 'apply-status',
          target: 'hit-recipient',
          status: { familyId: 'time-stop' },
          duration: 40,
          dispellable: true,
        },
        { kind: 'dispel', target: 'hit-recipient', polarity: 'buff', count: 1 },
      ],
    };
    const s = fixture({
      skills: [skill('knight-a3', { target: 'enemy-single', effects: [hit] })],
    });
    status(s, enemy(s), { familyId: 'reflect', ratio: 5000, charges: 1 });
    status(s, enemy(s), { familyId: 'counter', attack: attackPayload() });
    const next = submit(s, command('knight-a3'));
    expect(actor(next).hp).toBe(285);
    expect(next.log.some((x) => x.kind === 'reflect')).toBe(true);
    expect(next.log.some((x) => x.kind === 'counter')).toBe(false);
  });
  it('B20: one HP loss consumes reflect even when reflected amount is zero', () => {
    const s = fixture({
      skills: [
        skill('knight-a3', {
          target: 'enemy-single',
          effects: [atk('selected', { damageType: 'magic', power: 0 })],
        }),
      ],
    });
    status(s, enemy(s), { familyId: 'reflect', ratio: 5000, charges: 1 });
    const next = submit(s, command('knight-a3'));
    expect(actor(next).hp).toBe(300);
    expect(enemy(next).statuses).toEqual([]);
    expect(next.log.find((x) => x.kind === 'reflect')?.amount).toBe(0);
  });
  it('B21: reflection killing the attacker suppresses counter before self revival', () => {
    const s = fixture({
      jobs: ['berserker', 'wizard', 'cleric'],
      skills: [
        skill('berserker-b3', {
          target: 'enemy-single',
          effects: [atk('selected', { damageType: 'magic' })],
        }),
      ],
    });
    actor(s).hp = 1;
    status(s, actor(s), { familyId: 'self-revive', hpRatio: 4000, charges: 1 });
    status(s, enemy(s), { familyId: 'reflect', ratio: 5000, charges: 1 });
    status(s, enemy(s), { familyId: 'counter', attack: attackPayload() });
    const next = submit(s, command('berserker-b3'));
    expect(actor(next).hp).toBe(120);
    expect(next.log.some((x) => x.kind === 'counter')).toBe(false);
    expect(
      next.log
        .filter((x) => ['reflect', 'death', 'revive'].includes(x.kind))
        .map((x) => x.kind),
    ).toEqual(['reflect', 'death', 'revive']);
  });
  it('counter and follow use their own actor values and never chain reactions', () => {
    const s = fixture();
    const follower = s.state.participants[1];
    follower.stats.atk = 80;
    status(s, enemy(s), { familyId: 'counter', attack: attackPayload() });
    status(s, actor(s), { familyId: 'counter', attack: attackPayload() });
    status(s, follower, { familyId: 'follow', attack: attackPayload() });
    status(s, follower, { familyId: 'counter', attack: attackPayload() });
    const next = submit(s, command());
    expect(actor(next).hp).toBe(270);
    expect(enemy(next).hp).toBe(9900);
    expect(next.log.filter((x) => x.kind === 'counter')).toHaveLength(1);
    expect(next.log.filter((x) => x.kind === 'follow')).toHaveLength(1);
    expect(next.state.participants[1].action).toEqual({ kind: 'ready' });
    expect(next.state.participants[1].cooldowns).toEqual([]);
  });
  it('follow does not target a dead enemy or run for waits and heals', () => {
    const s = fixture({ enemyStats: { maxHp: 20 } });
    status(s, s.state.participants[1], {
      familyId: 'follow',
      attack: attackPayload(),
    });
    expect(submit(s, command()).log.some((x) => x.kind === 'follow')).toBe(
      false,
    );
    const waiting = fixture();
    status(waiting, waiting.state.participants[1], {
      familyId: 'follow',
      attack: attackPayload(),
    });
    expect(
      submit(waiting, command('wait', null)).log.some(
        (x) => x.kind === 'follow',
      ),
    ).toBe(false);
  });
  it('B05: trap postpones enemy start without consuming its column or remaining traps', () => {
    const s = prepare(fixture());
    const e = engine(s);
    enemy(s).action = { kind: 'ready' };
    for (const source of [actor(s), s.state.participants[1]])
      s.state.traps.push({
        sourceId: source.id,
        targetId: 'boss-01',
        sequence: s.state.nextSequence++,
        expires: { kind: 'running', at: 300 },
        attack: attackPayload(),
        attached: [
          {
            kind: 'shift',
            target: 'hit-recipient',
            direction: 'delay',
            amount: 20,
          },
        ],
        snapshot: 'on-trigger',
      });
    e.startEnemy(enemy(s));
    expect(enemy(s)).toMatchObject({
      action: { kind: 'waiting', ready: { at: 120 } },
      actionIndex: 0,
      cooldowns: [],
    });
    expect(s.state.traps).toHaveLength(1);
    expect(s.state.traps[0]?.sourceId).toBe('party-2');
    expect(
      s.log.some((x) => x.kind === 'command' && x.actorId === 'boss-01'),
    ).toBe(false);
  });
  it('trap uses trigger-time ATK and reinstallation replaces the old trap', () => {
    const s = fixture({
      jobs: ['ranger', 'wizard', 'cleric'],
      skills: [
        skill('ranger-b3', {
          target: 'enemy-single',
          effects: [
            {
              kind: 'trap',
              target: 'selected',
              duration: 200,
              attack: attackPayload(),
              attached: [],
              snapshot: 'on-trigger',
            },
          ],
        }),
      ],
    });
    const e = engine(s);
    e.startCommand(actor(s), reservation('ranger-b3', 'boss-01'));
    const old = s.state.traps[0]!.sequence;
    e.startCommand(actor(s), reservation('ranger-b3', 'boss-01'));
    expect(s.state.traps).toHaveLength(1);
    expect(s.state.traps[0]!.sequence).toBeGreaterThan(old);
    actor(s).stats.atk = 80;
    enemy(s).action = { kind: 'ready' };
    e.startEnemy(enemy(s));
    expect(enemy(s).hp).toBe(9930);
    expect(s.state.traps).toHaveLength(0);
  });
  it('stopped trap owners retain their trap; cast completion never triggers it', () => {
    const s = prepare(fixture());
    const e = engine(s);
    s.state.traps.push({
      sourceId: 'party-1',
      targetId: 'boss-01',
      sequence: s.state.nextSequence++,
      expires: { kind: 'running', at: 300 },
      attack: attackPayload(),
      attached: [],
      snapshot: 'on-trigger',
    });
    e.applyStatus(
      s.state.participants[1],
      actor(s),
      { familyId: 'time-stop' },
      40,
      true,
    );
    enemy(s).action = { kind: 'ready' };
    e.startEnemy(enemy(s));
    expect(s.state.traps).toHaveLength(1);
    expect(enemy(s).hp).toBe(10000);
    enemy(s).action = {
      kind: 'casting',
      cast: {
        command: reservation('boss-01-s1', 'party-2'),
        completes: { kind: 'running', at: 100 },
      },
    };
    s.state.participants[1].action = {
      kind: 'waiting',
      ready: { kind: 'running', at: 100 },
    };
    const next = advanceBattle(s);
    expect(next.state.traps).toHaveLength(1);
    expect(enemy(next).hp).toBe(10000);
  });
});

describe('unit boundaries and complete deterministic sample battle', () => {
  it('supports animation pauses and escape before the next autonomous event', () => {
    const s = fixture();
    const result = submitCommand(s, command('wait', null), { advance: false });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(getInputActor(result.session)).toBeNull();
    expect(result.session.state.now).toBe(100);
    expect(escapeBattle(result.session).state.result).toBe('escaped');
    expect(retryBattle(result.session)).toEqual(s);
    expect(advanceBattle(result.session)).toEqual(
      submit(s, command('wait', null)),
    );
  });
  it('stepping stops after one trap unit before starting the enemy command', () => {
    const s = prepare(fixture());
    actor(s).action = { kind: 'waiting', ready: { kind: 'running', at: 300 } };
    enemy(s).action = { kind: 'waiting', ready: { kind: 'running', at: 100 } };
    s.state.traps.push({
      sourceId: 'party-1',
      targetId: 'boss-01',
      sequence: s.state.nextSequence++,
      expires: { kind: 'running', at: 400 },
      attack: attackPayload(),
      attached: [],
      snapshot: 'on-trigger',
    });
    const stepped = advanceBattle(s, { stopAfterUnit: true });
    expect(enemy(stepped).hp).toBe(9970);
    expect(enemy(stepped).action).toEqual({ kind: 'ready' });
    expect(stepped.log.some((e) => e.kind === 'command')).toBe(false);
    const continued = advanceBattle(stepped, { stopAfterUnit: true });
    expect(actor(continued).hp).toBe(270);
    expect(enemy(continued).action).toMatchObject({ ready: { at: 225 } });
    expect(advanceBattle(continued)).toEqual(advanceBattle(s));
  });
  it('reaches victory with the same input sequence, logs and timeline in automatic and stepped modes', () => {
    const source = fixture({
      enemyStats: { maxHp: 400 },
      enemy: { maxBreakGauge: 60 },
    });
    /**
     * 同じ入力方針で合成戦闘を最後まで実行し、自動・段階進行の一致を検証する。
     *
     * @param stepped trueなら処理単位ごと、falseなら自動進行でテスト戦闘を実行する。
     */
    const play = (stepped: boolean) => {
      let s = structuredClone(source);
      let commands = 0;
      while (s.state.result === 'ongoing') {
        const id = getInputActor(s);
        if (id === null) {
          s = advanceBattle(s, { stopAfterUnit: stepped });
          continue;
        }
        const result = submitCommand(
          s,
          { ...command(), actorId: id },
          { advance: !stepped },
        );
        if (!result.ok) throw new Error(result.reason);
        s = result.session;
        if (++commands > 100) throw new Error('Sample battle did not finish');
      }
      return s;
    };
    const automatic = play(false);
    expect(automatic.state.result).toBe('victory');
    expect(automatic.state.timeline).toEqual([]);
    expect(play(true)).toEqual(automatic);
    expect(play(false)).toEqual(automatic);
    expect(source.state.result).toBe('ongoing');
  });
  it('initialization rejects invalid party slots and unknown builds', () => {
    const s = fixture();
    s.setup.party[0].id = 'party-2';
    expect(() => createBattle(s.content, s.setup)).toThrow('Party slots');
    const next = fixture();
    next.setup.party[0].learnedSkills = ['knight-a3'];
    expect(() => createBattle(next.content, next.setup)).toThrow(
      'prerequisite',
    );
  });
  it('enemy HP threshold jumps keep an existing cast and never return to an earlier phase', () => {
    const s = prepare(
      fixture({
        skills: [
          skill('boss-01-s2', {
            target: 'enemy-single',
            cooldownId: 'boss-01-s2',
            effects: [atk()],
          }),
        ],
        enemy: {
          phases: [
            {
              id: 'phase-1',
              hpThreshold: 10000,
              actions: [{ skillId: 'boss-01-s1', selection: 'lowest-hp' }],
            },
            {
              id: 'phase-2',
              hpThreshold: 6000,
              actions: [{ skillId: 'boss-01-s2', selection: 'lowest-hp' }],
            },
            {
              id: 'phase-3',
              hpThreshold: 3000,
              actions: [{ skillId: 'boss-01-s2', selection: 'highest-mag' }],
            },
          ],
        },
      }),
    );
    enemy(s).hp = 2900;
    enemy(s).action = {
      kind: 'casting',
      cast: {
        command: reservation('boss-01-s1', 'party-3'),
        completes: { kind: 'running', at: 300 },
      },
    };
    engine(s).startCommand(actor(s), reservation('wait'));
    expect(enemy(s)).toMatchObject({
      phaseIndex: 2,
      actionIndex: 0,
      action: { kind: 'casting' },
    });
    expect(getEnemyForecast(s).command.skillId).toBe('boss-01-s1');
    enemy(s).hp = 9000;
    engine(s).startCommand(actor(s), reservation('wait'));
    expect(enemy(s)).toMatchObject({ phaseIndex: 2, actionIndex: 0 });
  });
});

describe('additional rule boundaries', () => {
  it('game-rules 10.1: three tied allies win before the enemy tied action', () => {
    const s = fixture({
      jobs: ['knight', 'knight', 'knight'],
      partyStats: { maxHp: 100 },
      enemyStats: { maxHp: 90, atk: 30, spd: 100 },
      enemy: { maxBreakGauge: 100 },
      skills: [
        skill('knight-a3', {
          target: 'enemy-single',
          delay: 100,
          cooldown: 0,
          effects: [atk('selected', { breakDamage: 10 })],
        }),
      ],
    });
    const first = submit(s, command('knight-a3'));
    expect(enemy(first)).toMatchObject({ hp: 60, breakGauge: 90 });
    expect(actor(first).action).toMatchObject({ ready: { at: 200 } });
    const second = submit(first, {
      ...command('knight-a3'),
      actorId: 'party-2',
    });
    expect(enemy(second)).toMatchObject({ hp: 30, breakGauge: 80 });
    const third = submit(second, {
      ...command('knight-a3'),
      actorId: 'party-3',
    });
    expect(third.state.result).toBe('victory');
    expect(third.state.participants.slice(0, 3).map((p) => p.hp)).toEqual([
      100, 100, 100,
    ]);
    expect(
      third.log.some((e) => e.kind === 'command' && e.actorId === 'boss-01'),
    ).toBe(false);
  });
  it('applies break vulnerability only to later hits and never re-breaks', () => {
    const s = fixture({
      skills: [
        skill('knight-a3', {
          target: 'enemy-single',
          effects: [atk('selected', { breakDamage: 500 })],
        }),
      ],
    });
    const first = submit(s, command('knight-a3'));
    expect(enemy(first).hp).toBe(9970);
    const second = submit(first, { ...command(), actorId: 'party-2' });
    expect(enemy(second).hp).toBe(9925);
    expect(second.log.filter((e) => e.kind === 'break')).toHaveLength(1);
    expect(enemy(second).action).toMatchObject({
      break: { recovers: { at: 160 } },
    });
  });
  it('cancel immunity preserves casts and death removes a trap owned by that actor', () => {
    const s = prepare(fixture({ enemy: { cancelImmune: true } }));
    enemy(s).action = {
      kind: 'casting',
      cast: {
        command: reservation('boss-01-s1', 'party-1'),
        completes: { kind: 'running', at: 200 },
      },
    };
    engine(s).utility(actor(s), enemy(s), { kind: 'cancel-cast' });
    expect(enemy(s).action.kind).toBe('casting');
    const p = s.state.participants[1];
    p.hp = 1;
    s.state.traps.push({
      sourceId: p.id,
      targetId: 'boss-01',
      sequence: s.state.nextSequence++,
      expires: { kind: 'running', at: 300 },
      attack: attackPayload(),
      attached: [],
      snapshot: 'on-trigger',
    });
    engine(s).startCommand(enemy(s), reservation('boss-01-s1', p.id));
    expect(p.hp).toBe(0);
    expect(s.state.traps).toEqual([]);
  });
  it('keeps the fixed all-allies set for healing before dispelling debuffs', () => {
    const s = fixture({
      jobs: ['cleric', 'knight', 'wizard'],
      skills: [
        skill('cleric-b3', {
          target: 'ally-all',
          effects: [
            {
              kind: 'heal',
              target: 'all-allies',
              power: 120,
              actorReference: 'before-activation',
              targetReference: 'before-effect',
            },
            {
              kind: 'dispel',
              target: 'all-allies',
              polarity: 'debuff',
              count: 1,
            },
          ],
        }),
      ],
    });
    s.state.participants.slice(0, 3).forEach((p) => {
      p.hp = 100;
      status(s, p, { familyId: 'poison', damage: 8, interval: 20 });
    });
    const next = submit(s, command('cleric-b3', null));
    expect(
      next.log
        .filter((e) => ['heal', 'dispel'].includes(e.kind))
        .map((e) => `${e.kind}:${e.targetId}`),
    ).toEqual([
      'heal:party-1',
      'heal:party-2',
      'heal:party-3',
      'dispel:party-1',
      'dispel:party-2',
      'dispel:party-3',
    ]);
  });
  it('AI extrema use current absolute values with stable slot tie breaks', () => {
    const s = fixture();
    const p = enemy(s);
    if (p.side !== 'enemy') throw new Error('Expected enemy');
    s.content.enemies[0]!.phases[0]!.actions[0]!.selection = 'highest-mag';
    status(s, s.state.participants[2], { familyId: 'mag-up', magnitude: 2500 });
    expect(getEnemyForecast(s).command.selectedTargetId).toBe('party-3');
    status(s, s.state.participants[1], { familyId: 'mag-up', magnitude: 2500 });
    expect(getEnemyForecast(s).command.selectedTargetId).toBe('party-2');
    s.content.enemies[0]!.phases[0]!.actions[0]!.selection = 'lowest-hp';
    s.state.participants[2].hp = 2;
    expect(getEnemyForecast(s).command.selectedTargetId).toBe('party-3');
  });
  it('clamps stat modifiers and SPD limits and leaves existing schedules unchanged', () => {
    const s = fixture();
    const ready = structuredClone(s.state.participants[1].action);
    status(s, s.state.participants[1], {
      familyId: 'spd-down',
      magnitude: 10000,
    });
    expect(effectiveStats(s.state.participants[1]).spd).toBe(25);
    expect(s.state.participants[1].action).toEqual(ready);
    const p = actor(s);
    p.stats.atk = 9999;
    status(s, p, { familyId: 'atk-up', magnitude: 10000 });
    expect(effectiveStats(p).atk).toBe(9999);
  });
});
