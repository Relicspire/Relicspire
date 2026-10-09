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

describe('戦闘初期化と純粋なコマンドAPI', () => {
  it('全快で固定順の先頭から開始し、入力待ちではTUを進めない', () => {
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
  it('装備を反映し、初期能力値を上下限に収める', () => {
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
  it('敵の行動と同着の人物を定められた順に処理する', () => {
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
  ])('不正な入力を拒否し、戦闘状態を変更しない', (c) => {
    const s = fixture();
    const before = structuredClone(s);
    const result = submitCommand(s, c);
    expect(result.ok).toBe(false);
    expect(result.session).toBe(s);
    expect(s).toEqual(before);
  });
  it('下位ランクのコマンドを非表示にし、クールダウンを共有する', () => {
    const s = fixture();
    expect(checkCommand(s, command('knight-a1', null)).ok).toBe(false);
    actor(s).cooldowns.push({
      id: 'knight-a',
      timer: { kind: 'running', at: 101 },
    });
    expect(checkCommand(s, command('knight-a2', null))).toEqual({
      ok: false,
      code: 'cooldown',
      reason: 'Skill is on cooldown',
    });
    actor(s).cooldowns[0]!.timer = { kind: 'running', at: 100 };
    expect(checkCommand(s, command('knight-a2', null)).ok).toBe(true);
  });
  it('選択した属性を詠唱中も保持する', () => {
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
  it('既に手番へ到達した味方を前進の対象から除外する', () => {
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

describe('ダメージ・回復・能力参照時点・終了判定', () => {
  it('対象の現在の防御・弱点・ブレイク耐性を参照する', () => {
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
  it('整数の分数で正確に計算し、最後に一度だけ丸める', () => {
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
  it('B15: 自身への強化前に保存したSPDでディレイを計算する', () => {
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
  it('B14: 必須対象の敵を倒した後も自身の回復を完了する', () => {
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
  it('背水行動の全効果で回復前のHP条件を使用する', () => {
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
  it('B18: 属性無効では付随効果とゲージ削りも無効にする', () => {
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
  it('回復を最大HPまでに制限し、通常回復では蘇生しない', () => {
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
  it('B07: 反射で死亡した後の自己蘇生は固定50 TU待機とCDを保持する', () => {
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
  it('クレリックA3だけが他の死者を蘇生し、対象のCDを保持する', () => {
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
  it('反射の相打ちは処理単位を完了した後に敗北と判定する', () => {
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
  it('進行を変更せず開始前スナップショットを復元し、同じ結果を再現する', () => {
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

describe('詠唱・ブレイク・時間操作', () => {
  it('B09: 予約対象が死亡した詠唱は不発になり、ディレイとCDを保持する', () => {
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
  it('B04: 同着の未処理の敵を行動列を消費せず後退させる', () => {
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
  it('B06: 行動中に受けた後退を最終待機時間へ加算する', () => {
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
  it('詠唱キャンセルは固定30 TU待機とし、CDを保持する', () => {
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
  it('ブレイクは詠唱を中断して行動列を1つ消費し、復帰後に次の手番を設定する', () => {
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
  it('B08: 反撃ブレイクは復帰予定を保持し、行動中の列を二重消費しない', () => {
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
  it('後退耐性は各適用で切り上げ、前進は現在TU＋1を下限とする', () => {
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

describe('状態の期限・時間凍結・同時イベント', () => {
  it('B01: 停止解除後の残り0 TUの毒は発動より先に期限切れになる', () => {
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
  it('B02: 停止解除後の残り0 TUの詠唱は同着の味方入力前に1回だけ発動する', () => {
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
  it('B03: 同時刻の毒をすべて処理してからフェーズ移行と入力待ちを処理する', () => {
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
  it('毒による同時死亡を1処理単位とし、相打ちは敗北を優先する', () => {
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
  it('B10/B16: 凍結中の再付与は強度・付与者・発動周期を保持する', () => {
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
  it('停止の再付与は終了時刻だけを変更し、新規状態も凍結する', () => {
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
  it('B11: 死亡時にCDを復元し、その後の蘇生ではCDを再設定しない', () => {
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
  it('B12: 停止中の詠唱キャンセルは30 TUの待機を凍結する', () => {
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
  it('停止中のブレイクは60 TUの復帰待機を凍結し、停止無効の敵は凍結しない', () => {
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
  it('停止解除で予定を復元し、除去済みの凍結した毒は復活させない', () => {
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
  it('同系統の再付与は期限だけを更新し、解除は付与順に処理する', () => {
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

describe('挑発・かばう・反射・反撃・追撃・罠', () => {
  it('挑発は詠唱開始時だけ対象を変更し、挑発者の死亡後も予約対象を保持する', () => {
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
  it('B13: かばうはダメージと付随する毒を移し、連鎖しない', () => {
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
  it('B13: 被弾で死亡したかばう役には毒を付与しない', () => {
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
  it('全体攻撃はかばうを無視し、効果処理前に対象集合を固定する', () => {
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
  it('被弾前に保存した反射は同じ攻撃の停止・解除後も発動し、反撃は抑止する', () => {
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
  it('B20: HPが1減れば反射量が0でも反射回数を消費する', () => {
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
  it('B21: 反射で攻撃者が死亡すると自己蘇生前の反撃を抑止する', () => {
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
  it('反撃と追撃は自身の能力値を使い、反応を連鎖させない', () => {
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
  it('追撃は死亡した敵に発動せず、待機・回復でも発動しない', () => {
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
  it('B05: 罠は敵の行動開始を延期し、行動列と残りの罠を消費しない', () => {
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
  it('罠は発動時のATKを使い、再設置で古い罠を置き換える', () => {
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
  it('停止中の設置者の罠を保持し、詠唱完了では罠を発動しない', () => {
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

describe('処理単位の境界と最後まで再現可能なサンプル戦闘', () => {
  it('次の自動イベント前に演出待ちと逃走を実行できる', () => {
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
  it('段階進行は罠1個の処理後、敵の行動開始前に停止する', () => {
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
  it('自動進行と段階進行で同じ入力列・ログ・タイムラインのまま勝利する', () => {
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
  it('初期化時に不正な人物枠と編成を拒否する', () => {
    const s = fixture();
    s.setup.party[0].id = 'party-2';
    expect(() => createBattle(s.content, s.setup)).toThrow('Party slots');
    const next = fixture();
    next.setup.party[0].learnedSkills = ['knight-a3'];
    expect(() => createBattle(next.content, next.setup)).toThrow(
      'prerequisite',
    );
  });
  it('敵のHP閾値を飛び越えても詠唱を保持し、以前のフェーズへ戻らない', () => {
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

describe('追加のルール境界値', () => {
  it('ゲームルール10.1: 同着の味方3人が敵の同着行動より先に勝利する', () => {
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
  it('ブレイクの被ダメージ増加は後続の攻撃だけに適用し、再ブレイクしない', () => {
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
  it('キャンセル無効は詠唱を保持し、死亡は本人が設置した罠を除去する', () => {
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
  it('固定した味方全体へ回復してから弱体解除を処理する', () => {
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
  it('AIは現在の絶対値で対象を選び、同値は固定の人物順で決定する', () => {
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
  it('能力補正とSPDを上下限に収め、既存の行動予定を変更しない', () => {
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

/** 現行16系統すべての状態。付与・延長・自然終了を同じ契約で検証する。 */
const allStatuses: StatusSpec[] = [
  ...(
    [
      'atk-up',
      'atk-down',
      'mag-up',
      'mag-down',
      'spd-up',
      'spd-down',
      'physical-guard',
      'magic-guard',
    ] as const
  ).map((familyId) => ({ familyId, magnitude: 2000 })),
  { familyId: 'taunt' },
  { familyId: 'cover' },
  { familyId: 'time-stop' },
  { familyId: 'reflect', ratio: 5000, charges: 3 },
  { familyId: 'counter', attack: attackPayload() },
  { familyId: 'follow', attack: attackPayload() },
  { familyId: 'poison', damage: 8, interval: 20 },
  { familyId: 'self-revive', hpRatio: 5000, charges: 1 },
];

describe('全状態系統のライフサイクル', () => {
  it.each(allStatuses)('$familyIdの付与・延長・期限切れを固定する', (spec) => {
    const s = prepare(fixture());
    const e = engine(s);
    const p = s.state.participants[1];
    e.applyStatus(actor(s), p, spec, 40, true);
    const granted = structuredClone(p.statuses[0]!);
    expect(granted).toMatchObject({
      sourceId: 'party-1',
      spec,
      expires: { kind: 'running', at: 140 },
      dispellable: true,
    });
    expect(granted.nextTick).toEqual(
      spec.familyId === 'poison' ? { kind: 'running', at: 120 } : null,
    );
    // 消費済み回数を再付与で補充しない。強度・付与者・周期も元のまま。
    if (p.statuses[0]!.remainingCharges !== null)
      p.statuses[0]!.remainingCharges = 0;
    const before = structuredClone(p.statuses[0]!);
    s.state.now = 110;
    const stronger =
      'magnitude' in spec
        ? { ...spec, magnitude: 4000 }
        : 'attack' in spec
          ? { ...spec, attack: attackPayload({ power: 200 }) }
          : spec.familyId === 'poison'
            ? { ...spec, damage: 99 }
            : spec;
    e.applyStatus(s.state.participants[2], p, stronger, 50, false);
    expect(p.statuses).toEqual([
      { ...before, expires: { kind: 'running', at: 160 } },
    ]);
    actor(s).action = { kind: 'waiting', ready: { kind: 'running', at: 159 } };
    const alive = advanceBattle(s);
    expect(alive.state.now).toBe(159);
    expect(alive.state.participants[1].statuses).toHaveLength(1);
    actor(alive).action = {
      kind: 'waiting',
      ready: { kind: 'running', at: 160 },
    };
    const expired = advanceBattle(alive);
    expect(expired.state.now).toBe(160);
    expect(expired.state.participants[1].statuses).toEqual([]);
    expect(
      expired.log.filter(
        (x) => x.kind === 'expire' && x.detail === spec.familyId,
      ),
    ).toHaveLength(1);
    if (spec.familyId === 'time-stop') {
      expect(expired.state.participants[1].timeStopUntil).toBeNull();
      expect(expired.state.participants[1].action).toEqual({
        kind: 'waiting',
        ready: { kind: 'running', at: 560 },
      });
    }
    if (spec.familyId === 'poison')
      expect(expired.state.participants[1].hp).toBe(284);
    const nextEngine = engine(expired);
    nextEngine.applyStatus(
      expired.state.participants[2],
      expired.state.participants[1],
      spec,
      40,
      true,
    );
    expect(expired.state.participants[1].statuses[0]!.sourceId).toBe('party-3');
    expect(expired.state.participants[1].statuses[0]!.id).not.toBe(granted.id);
  });
  it.each(allStatuses)('死亡者へ$familyIdを付与しない', (spec) => {
    const s = prepare(fixture());
    const p = s.state.participants[1];
    p.hp = 0;
    p.action = { kind: 'dead' };
    engine(s).applyStatus(actor(s), p, spec, 40, true);
    expect(p.statuses).toEqual([]);
    expect(p.timeStopUntil).toBeNull();
  });
  it('B17: 死亡した挑発者を延長で変更せず、期限切れ後の新規付与だけ変更する', () => {
    const s = prepare(fixture());
    const p = enemy(s);
    const e = engine(s);
    e.applyStatus(s.state.participants[1], p, { familyId: 'taunt' }, 40, true);
    s.state.participants[1].hp = 0;
    s.state.participants[1].action = { kind: 'dead' };
    s.state.now = 110;
    e.applyStatus(actor(s), p, { familyId: 'taunt' }, 50, true);
    expect(p.statuses[0]!.sourceId).toBe('party-2');
    expect(getEnemyForecast(s).command?.selectedTargetId).toBe('party-1');
    actor(s).action = { kind: 'waiting', ready: { kind: 'running', at: 160 } };
    const next = advanceBattle(s);
    expect(enemy(next).statuses).toEqual([]);
    engine(next).applyStatus(
      next.state.participants[2],
      enemy(next),
      { familyId: 'taunt' },
      50,
      true,
    );
    expect(getEnemyForecast(next).command?.selectedTargetId).toBe('party-3');
  });
});

describe('実時間・演出待ちと同一入力列の再現性', () => {
  it('時計・入力待ち時間・処理単位間の演出待ちを変えても全状態・ログ・結果が一致する', () => {
    const source = fixture({
      enemyStats: { maxHp: 400 },
      enemy: { maxBreakGauge: 60 },
    });
    /** 指定した実時間と演出待ちで、同じ入力列を最後まで再生する。
     * @param pauses 処理単位ごとの演出待ちと入力待ちを模擬するか。
     * @param wallTime 開始時の実時間。論理TUへは渡さない。
     */
    const play = (pauses: boolean, wallTime: number) => {
      vi.setSystemTime(wallTime);
      let s = structuredClone(source);
      let steps = 0;
      const inputs: PlayerCommand[] = [];
      while (s.state.result === 'ongoing') {
        if (++steps > 1000) throw new Error('戦闘が終了しません');
        const id = getInputActor(s);
        if (id !== null) {
          if (pauses) {
            const before = structuredClone(s);
            vi.advanceTimersByTime(3600000 + steps * 17);
            expect(advanceBattle(s)).toEqual(before);
            expect(getInputActor(s)).toBe(id);
          }
          const c = { ...command(), actorId: id };
          inputs.push(c);
          const result = submitCommand(s, c, { advance: !pauses });
          if (!result.ok) throw new Error(result.reason);
          s = result.session;
        } else {
          if (pauses) vi.advanceTimersByTime(steps * 500);
          s = advanceBattle(s, { stopAfterUnit: pauses });
        }
      }
      return { s, inputs, outcome: getBattleOutcome(s) };
    };
    vi.useFakeTimers();
    try {
      const expected = play(false, Date.UTC(2020, 0, 1));
      expect(expected.s.state.result).toBe('victory');
      expect(play(false, Date.UTC(2040, 0, 1))).toEqual(expected);
      expect(play(true, Date.UTC(2060, 0, 1))).toEqual(expected);
      expect(source.state.result).toBe('ongoing');
    } finally {
      vi.useRealTimers();
    }
  });
});
