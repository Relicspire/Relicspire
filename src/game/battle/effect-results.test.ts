import { describe, expect, it } from 'vitest';
import { advanceBattle, retryBattle, submitCommand } from './index';
import { Engine } from './engine';
import { attackPayload, fixture, skill } from './fixtures.test-support';
import { getEffectResults, getEffectWarnings, previewCommand } from './queries';
import type { BattleSession, PlayerCommand } from './types';
import type { Effect, HitEffect, StatusSpec } from '../data/model';

/** 独立効果の診断を比較するための通常攻撃付きスキルを作る。
 * @param attached 元の配列添字を維持する付随効果。
 */
function attack(attached: HitEffect[] = []): Effect {
  return { kind: 'attack', target: 'selected', ...attackPayload(), attached };
}
/** 診断対象のスキルと入力待ち戦闘を作る。
 * @param effects 配列順に適用する独立効果。
 * @param castTime 詠唱予約と参考結果を検証するTU。
 */
function battle(effects: Effect[], castTime = 0): BattleSession {
  return fixture({
    skills: [skill('knight-a3', { target: 'enemy-single', effects, castTime })],
  });
}
/** テスト用のスキル確定入力。 */
const command: PlayerCommand = {
  actorId: 'party-1',
  skillId: 'knight-a3',
  selectedTargetId: 'boss-01',
  chosenElement: null,
};
/** 即時予測と実行の診断一致を確認して実行後を返す。
 * @param session 元の入力待ち戦闘。
 * @param input 実行する確定入力。
 */
function run(session: BattleSession, input = command): BattleSession {
  const original = structuredClone(session);
  const preview = previewCommand(session, input);
  expect(session).toEqual(original);
  const result = submitCommand(session, input, { advance: false });
  if (!result.ok || !preview.ok) throw new Error('入力の拒否');
  expect(preview.committed.effectResults).toEqual(
    getEffectResults(
      result.session,
      session.effectResults.at(-1)?.sequence ?? 0,
    ),
  );
  return result.session;
}
/** 参考条件の状態を追加する。診断履歴を増やさずテストの前提だけ作る。
 * @param session 設定する戦闘。
 * @param source 付与者の配列位置。
 * @param target 対象の配列位置。
 * @param spec 状態の性能。
 */
function apply(
  session: BattleSession,
  source: number,
  target: number,
  spec: StatusSpec,
): void {
  new Engine(session.content, session.state, session.log).applyStatus(
    session.state.participants[source]!,
    session.state.participants[target]!,
    spec,
    50,
    true,
  );
}

describe('効果単位の成立と不成立診断', () => {
  it('満タンの回復は実回復なしと診断し不足HPへの回復量は実適用値を返す', () => {
    const s = battle([
      {
        kind: 'heal',
        target: 'self',
        power: 100,
        actorReference: 'before-activation',
        targetReference: 'before-effect',
      },
    ]);
    expect(run(s).effectResults[0]).toMatchObject({
      code: 'hp-full',
      outcome: 'rejected',
      amount: 0,
    });
    s.state.participants[0]!.hp -= 3;
    expect(run(s).effectResults[0]).toMatchObject({
      code: 'applied',
      outcome: 'applied',
      amount: 3,
    });
  });

  it('同系統の強い再付与でも元の強度と付与者を保持する', () => {
    const s = battle([
      {
        kind: 'apply-status',
        target: 'self',
        status: { familyId: 'atk-up', magnitude: 5000 },
        duration: 100,
        dispellable: true,
      },
    ]);
    apply(s, 1, 0, { familyId: 'atk-up', magnitude: 1000 });
    expect(run(s).effectResults[0]).toMatchObject({
      code: 'status-refreshed',
      statusAfter: { sourceId: 'party-2', spec: { magnitude: 1000 } },
    });
  });

  it('罠の設置診断と発動参考診断を分け設置物IDを返す', () => {
    const s = battle([
      {
        kind: 'trap',
        target: 'selected',
        duration: 100,
        attack: attackPayload(),
        attached: [{ kind: 'cancel-cast', target: 'hit-recipient' }],
        snapshot: 'on-trigger',
      },
    ]);
    const preview = previewCommand(s, command);
    if (!preview.ok) throw new Error('入力の拒否');
    expect(preview.committed.effectResults[0]).toMatchObject({
      kind: 'trap',
      origin: 'skill',
      code: 'applied',
    });
    const trap = preview.trapReferences[0]!;
    expect(
      trap.reference!.effectResults.map((r) => [
        r.origin,
        r.originId,
        r.kind,
        r.code,
      ]),
    ).toEqual([
      ['trap', trap.sequence, 'attack', 'applied'],
      ['trap', trap.sequence, 'cancel-cast', 'not-casting'],
    ]);
  });
  it('致死ダメージ後の付随効果と後続効果を戦闘不能の理由で拒否する', () => {
    const s = battle([
      attack([{ kind: 'cancel-cast', target: 'hit-recipient' }]),
      { kind: 'dispel', target: 'selected', polarity: 'buff', count: 1 },
    ]);
    s.state.participants[3]!.hp = 1;
    const results = run(s).effectResults;
    expect(
      results.map((r) => [r.effectIndex, r.attachedIndex, r.code]),
    ).toEqual([
      [0, null, 'applied'],
      [0, 0, 'dead-target'],
      [1, null, 'dead-target'],
    ]);
    expect(results[0]!.amount).toBe(1);
  });

  it('攻撃が先にブレイクさせたら詠唱解除と時間操作を処理時の状態で拒否する', () => {
    const s = battle([
      attack([
        { kind: 'cancel-cast', target: 'hit-recipient' },
        {
          kind: 'shift',
          target: 'hit-recipient',
          direction: 'delay',
          amount: 20,
        },
      ]),
    ]);
    const enemy = s.state.participants[3]!;
    if (enemy.side !== 'enemy') throw new Error('敵が必要');
    enemy.breakGauge = 1;
    enemy.action = {
      kind: 'casting',
      cast: {
        completes: { kind: 'running', at: 200 },
        command: {
          skillId: 'boss-01-s1',
          selectedTargetId: 'party-1',
          chosenElement: null,
        },
      },
    };
    expect(getEffectWarnings(s, command)).toEqual([]);
    const results = run(s).effectResults;
    expect(results.map((r) => [r.attachedIndex, r.code])).toEqual([
      [null, 'applied'],
      [1, 'no-shiftable-schedule'],
      [0, 'not-casting'],
    ]);
  });

  it('属性無効では親攻撃と全付随効果の不成立を区別し独立効果は実行する', () => {
    const s = battle([
      {
        ...attack([{ kind: 'cancel-cast', target: 'hit-recipient' }]),
        element: 'fire',
      } as Effect,
      { kind: 'cancel-cast', target: 'selected' },
    ]);
    s.content.enemies[0]!.immuneElements = ['fire'];
    const results = run(s).effectResults;
    expect(results.map((r) => [r.code, r.cause])).toEqual([
      ['immune-element', null],
      ['attack-rejected', 'immune-element'],
      ['not-casting', null],
    ]);
  });

  it('かばう後の実際の被弾者に攻撃と付随効果の診断を対応させる', () => {
    const s = fixture({
      skills: [
        skill('boss-01-s1', {
          target: 'enemy-single',
          effects: [attack([{ kind: 'cancel-cast', target: 'hit-recipient' }])],
        }),
      ],
    });
    apply(s, 2, 1, { familyId: 'cover' });
    const e = new Engine(s.content, s.state, s.log, s.effectResults);
    e.activate(s.state.participants[3]!, {
      skillId: 'boss-01-s1',
      selectedTargetId: 'party-2',
      chosenElement: null,
    });
    expect(
      s.effectResults.map((r) => [r.requestedTargetId, r.targetId]),
    ).toEqual([
      ['party-2', 'party-3'],
      ['party-2', 'party-3'],
    ]);
  });

  it('固有耐性と解除対象なしを別の安定した理由で返す', () => {
    const s = battle([
      {
        kind: 'apply-status',
        target: 'selected',
        status: { familyId: 'time-stop' },
        duration: 30,
        dispellable: true,
      },
      { kind: 'cancel-cast', target: 'selected' },
      { kind: 'shift', target: 'selected', direction: 'delay', amount: 10 },
      { kind: 'dispel', target: 'selected', polarity: 'buff', count: 1 },
    ]);
    Object.assign(s.content.enemies[0]!, {
      timeStopImmune: true,
      cancelImmune: true,
      knockbackResistance: 10000,
    });
    expect(run(s).effectResults.map((r) => r.code)).toEqual([
      'immune-stop',
      'immune-cancel',
      'immune-shift',
      'no-dispellable-status',
    ]);
  });

  it('同系統再付与は期限だけ更新し強度と実付与者と残り回数を保持する', () => {
    const s = battle([
      {
        kind: 'apply-status',
        target: 'self',
        status: { familyId: 'reflect', ratio: 5000, charges: 5 },
        duration: 100,
        dispellable: true,
      },
    ]);
    apply(s, 1, 0, { familyId: 'reflect', ratio: 5000, charges: 2 });
    s.state.participants[0]!.statuses[0]!.remainingCharges = 1;
    const result = run(s).effectResults[0]!;
    expect(result.code).toBe('status-refreshed');
    expect(result.statusBefore!.expires).not.toEqual(
      result.statusAfter!.expires,
    );
    expect(result.statusAfter).toEqual({
      ...result.statusBefore,
      expires: { kind: 'running', at: s.state.now + 100 },
    });
    expect(result.statusAfter).toMatchObject({
      sourceId: 'party-2',
      remainingCharges: 1,
      spec: { charges: 2 },
    });
  });

  it('新規状態の付与と続く解除の成立数を返す', () => {
    const s = battle([
      {
        kind: 'apply-status',
        target: 'selected',
        status: { familyId: 'atk-up', magnitude: 2000 },
        duration: 50,
        dispellable: true,
      },
      { kind: 'dispel', target: 'selected', polarity: 'buff', count: 2 },
    ]);
    const results = run(s).effectResults;
    expect(results[0]).toMatchObject({
      code: 'status-added',
      statusBefore: null,
      statusAfter: { sourceId: 'party-1', spec: { magnitude: 2000 } },
    });
    expect(results[1]).toMatchObject({ code: 'applied', amount: 1 });
  });

  it('蘇生後の後続蘇生は処理直前の生存状態により不適格となる', () => {
    const s = fixture({
      jobs: ['cleric', 'wizard', 'knight'],
      skills: [
        skill('cleric-a3', {
          target: 'dead-ally-other',
          effects: [
            { kind: 'revive', target: 'selected', hpRatio: 5000 },
            { kind: 'revive', target: 'selected', hpRatio: 5000 },
          ],
        }),
      ],
    });
    s.state.participants[1]!.hp = 0;
    s.state.participants[1]!.action = { kind: 'dead' };
    const results = run(s, {
      ...command,
      skillId: 'cleric-a3',
      selectedTargetId: 'party-2',
    }).effectResults;
    expect(results.map((r) => r.code)).toEqual(['applied', 'invalid-target']);
    expect(results[0]!.amount).toBe(150);
  });

  it('詠唱予約には診断を含めず参考発動と対象失効後の実発動を区別する', () => {
    const s = battle([attack()], 60);
    const preview = previewCommand(s, command);
    if (!preview.ok) throw new Error('入力の拒否');
    expect(preview.committed.effectResults).toEqual([]);
    expect(preview.reference!.effectResults[0]!.code).toBe('applied');
    const reserved = run(s);
    reserved.state.participants[1]!.action = {
      kind: 'waiting',
      ready: { kind: 'running', at: 1000 },
    };
    reserved.state.participants[2]!.action = {
      kind: 'waiting',
      ready: { kind: 'running', at: 1000 },
    };
    reserved.state.participants[3]!.action = {
      kind: 'waiting',
      ready: { kind: 'running', at: 1000 },
    };
    reserved.state.participants[3]!.hp = 0;
    const after = advanceBattle(reserved, { stopAfterUnit: true });
    expect(after.effectResults[0]).toMatchObject({
      code: 'invalid-target',
      now: s.state.now + 60,
    });
  });

  it('診断取得と凍結入力の予測は原本を変えず独立カーソルと再試行で履歴を扱える', () => {
    const s = battle([attack(), { kind: 'cancel-cast', target: 'selected' }]);
    const original = structuredClone(s);
    /** ネストした照会元を凍結する。
     * @param value 検証する入力値。
     */
    function freeze(value: unknown): void {
      if (value && typeof value === 'object') {
        Object.values(value).forEach(freeze);
        Object.freeze(value);
      }
    }
    freeze(s);
    const after = run(s);
    expect(s).toEqual(original);
    expect(after.log.map((entry) => entry.sequence)).toEqual(
      Array.from({ length: after.log.length }, (_, i) => i),
    );
    const tail = getEffectResults(after, 1);
    expect(tail).toHaveLength(1);
    tail[0]!.code = 'applied';
    expect(after.effectResults[1]!.code).toBe('not-casting');
    expect(getEffectResults(after, 2)).toEqual([]);
    expect(retryBattle(after).effectResults).toEqual([]);
  });
});
