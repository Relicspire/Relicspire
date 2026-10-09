import { describe, expect, it } from 'vitest';
import { fixture, skill, attackPayload } from './fixtures.test-support';
import { Engine } from './engine';
import {
  submitCommand,
  previewCommand,
  getBattleDisplay,
  getMainSchedules,
  getStatusDetails,
  getEnemyDetails,
  getCommandDetails,
  getDisplayLog,
  getBattleEvents,
  getBattleDelta,
  getTrapReference,
  getEffectWarnings,
} from './index';
import type { PlayerCommand, BattleSession } from './types';
import type { StatusSpec } from '../data/model';
/** 味方1の候補入力を生成する。
 * @param skillId 使用候補。
 * @param target 単体の予約対象。全体・自身はnull。
 */
const command = (
  skillId: PlayerCommand['skillId'] = 'basic-attack',
  target: PlayerCommand['selectedTargetId'] = 'boss-01',
): PlayerCommand => ({
  actorId: 'party-1',
  skillId,
  selectedTargetId: target,
  chosenElement: null,
});
/** 実際の付与処理を使って表示用の状態を準備する。
 * @param s テストセッション。
 * @param index 対象の参加者番号。
 * @param spec 状態性能。
 * @param duration 残りTU。
 */
function apply(
  s: BattleSession,
  index: number,
  spec: StatusSpec,
  duration = 80,
) {
  const e = new Engine(s.content, s.state, s.log);
  e.applyStatus(
    s.state.participants[0],
    s.state.participants[index]!,
    spec,
    duration,
    true,
  );
  e.syncTimeline();
}

describe('コマンド予測の本エンジンとの一致', () => {
  it('即時予測は実行と全状態・ログが一致し、他者イベントを進めない', () => {
    const s = fixture();
    const before = structuredClone(s);
    const p = previewCommand(s, command());
    expect(p.ok).toBe(true);
    if (!p.ok) throw new Error('予測失敗');
    const actual = submitCommand(s, command(), { advance: false });
    if (!actual.ok) throw new Error(actual.reason);
    expect(p.kind).toBe('immediate');
    expect(p.committed).toEqual(getBattleDelta(s, actual.session));
    expect(p.committed.after.now).toBe(s.state.now);
    expect(p.reference).toBeNull();
    expect(s).toEqual(before);
    p.committed.after.participants[0].hp = 1;
    expect(s).toEqual(before);
  });
  it('反射・反撃・追撃と勝敗を即時予測に含める', () => {
    const s = fixture({
      jobs: ['wizard', 'knight', 'cleric'],
      enemyStats: { maxHp: 60 },
      skills: [
        skill('wizard-a3', {
          target: 'enemy-single',
          effects: [
            {
              ...attackPayload({ damageType: 'magic' }),
              kind: 'attack',
              target: 'selected',
              attached: [],
            },
          ],
        }),
      ],
    });
    apply(s, 3, { familyId: 'reflect', ratio: 5000, charges: 1 });
    apply(s, 3, { familyId: 'counter', attack: attackPayload() });
    apply(s, 1, { familyId: 'follow', attack: attackPayload() });
    const p = previewCommand(s, command('wizard-a3'));
    if (!p.ok) throw new Error('予測失敗');
    const actual = submitCommand(s, command('wizard-a3'), { advance: false });
    if (!actual.ok) throw new Error(actual.reason);
    expect(p.committed.after).toEqual(actual.session.state);
    expect(p.committed.events.some((e) => e.kind === 'reflect')).toBe(true);
    expect(p.committed.after.result).toBe('victory');
    expect(p.committed.events.some((e) => e.kind === 'counter')).toBe(true);
    expect(p.committed.events.some((e) => e.kind === 'follow')).toBe(true);
  });
  it('即時予測にブレイク・フェーズ移行と固定待機の自己蘇生を含める', () => {
    const s = fixture({
      enemyStats: { maxHp: 300 },
      enemy: {
        maxBreakGauge: 5,
        phases: [
          {
            id: 'phase-1',
            hpThreshold: 10000,
            actions: [{ skillId: 'boss-01-s1', selection: 'lowest-hp' }],
          },
          {
            id: 'phase-2',
            hpThreshold: 9500,
            actions: [{ skillId: 'boss-01-s1', selection: 'lowest-hp' }],
          },
        ],
      },
    });
    const p = previewCommand(s, command());
    if (!p.ok) throw new Error('予測失敗');
    expect(p.committed.events.map((e) => e.kind)).toEqual(
      expect.arrayContaining(['break', 'phase']),
    );
    expect(p.committed.after.participants[3]).toMatchObject({
      phaseIndex: 1,
      action: { kind: 'broken' },
    });
    const revive = fixture({
      jobs: ['berserker', 'wizard', 'cleric'],
      skills: [
        skill('berserker-b3', {
          target: 'enemy-single',
          effects: [
            {
              ...attackPayload({ damageType: 'magic' }),
              kind: 'attack',
              target: 'selected',
              attached: [],
            },
          ],
        }),
      ],
    });
    revive.state.participants[0].hp = 5;
    apply(revive, 0, { familyId: 'self-revive', hpRatio: 4000, charges: 1 });
    apply(revive, 3, { familyId: 'reflect', ratio: 5000, charges: 1 });
    const preview = previewCommand(revive, command('berserker-b3'));
    if (!preview.ok) throw new Error('予測失敗');
    expect(preview.committed.after.participants[0]).toMatchObject({
      hp: 120,
      action: { kind: 'waiting', ready: { at: 150 } },
    });
    const actual = submitCommand(revive, command('berserker-b3'), {
      advance: false,
    });
    if (!actual.ok) throw new Error(actual.reason);
    expect(preview.committed).toEqual(getBattleDelta(revive, actual.session));
  });
  it('詠唱は予約・CDと現在発動の参考値を分け、先行イベントと失効状態を示す', () => {
    const s = fixture({
      jobs: ['wizard', 'knight', 'cleric'],
      skills: [
        skill('wizard-a3', {
          target: 'enemy-single',
          castTime: 60,
          effects: [
            {
              ...attackPayload(),
              kind: 'attack',
              target: 'selected',
              attached: [],
            },
          ],
        }),
      ],
    });
    apply(s, 0, { familyId: 'atk-up', magnitude: 2000 }, 20);
    const before = structuredClone(s);
    const p = previewCommand(s, command('wizard-a3'));
    if (!p.ok) throw new Error('予測失敗');
    expect(p.kind).toBe('casting');
    expect(p.activationAt).toBe(160);
    expect(p.cooldown).toEqual({ kind: 'running', at: 220 });
    expect(p.committed.participants[3]!.hpChange).toBe(0);
    expect(p.reference!.participants[3]!.hpChange).toBeLessThan(0);
    expect(p.expiringStatuses).toContainEqual({
      participantId: 'party-1',
      statusId: s.state.participants[0].statuses[0]!.id,
      at: 120,
    });
    expect(
      p.precedingEvents.some(
        (e) => e.kind === 'ready' && e.participantId === 'boss-01',
      ),
    ).toBe(true);
    expect(p.reference!.after.now).toBe(100);
    expect(s).toEqual(before);
  });
  it('上位置換・CD・不適格対象の拒否を安定したコードで返す', () => {
    const s = fixture();
    expect(previewCommand(s, command('knight-a1', null))).toMatchObject({
      ok: false,
      check: { code: 'replaced' },
    });
    expect(
      getCommandDetails(s, command('basic-attack', 'party-2')).check,
    ).toMatchObject({ ok: false, code: 'invalid-target' });
    s.state.participants[0].cooldowns.push({
      id: 'knight-a3',
      timer: { kind: 'running', at: 150 },
    });
    expect(getCommandDetails(s, command('knight-a3', null))).toMatchObject({
      check: { code: 'cooldown' },
      cooldownRemaining: 50,
    });
  });
  it('属性無効・時間停止無効・キャンセル無効の不成立理由を表示する', () => {
    const s = fixture({
      skills: [
        skill('knight-a3', {
          target: 'enemy-single',
          effects: [
            {
              ...attackPayload({ element: 'ice' }),
              kind: 'attack',
              target: 'selected',
              attached: [
                { kind: 'cancel-cast', target: 'hit-recipient' },
                {
                  kind: 'apply-status',
                  target: 'hit-recipient',
                  status: { familyId: 'time-stop' },
                  duration: 30,
                  dispellable: true,
                },
              ],
            },
          ],
        }),
      ],
      enemy: {
        immuneElements: ['ice'],
        cancelImmune: true,
        timeStopImmune: true,
      },
    });
    expect(getEffectWarnings(s, command('knight-a3'))).toEqual([
      { targetId: 'boss-01', code: 'immune-element' },
    ]);
    s.content.enemies[0]!.immuneElements = [];
    expect(
      getEffectWarnings(s, command('knight-a3')).map((w) => w.code),
    ).toEqual(['immune-cancel', 'immune-stop']);
  });
  it('罠設置の確定予測と将来発動の現在能力による参考値を分ける', () => {
    const s = fixture({
      jobs: ['ranger', 'knight', 'cleric'],
      skills: [
        skill('ranger-a3', {
          target: 'enemy-single',
          effects: [
            {
              kind: 'trap',
              target: 'selected',
              duration: 100,
              attack: attackPayload(),
              attached: [],
              snapshot: 'on-trigger',
            },
          ],
        }),
      ],
    });
    const before = structuredClone(s);
    const p = previewCommand(s, command('ranger-a3'));
    if (!p.ok) throw new Error('予測失敗');
    expect(p.committed.participants[3]!.hpChange).toBe(0);
    expect(p.committed.after.traps).toHaveLength(1);
    expect(p.trapReferences[0]!.reference!.participants[3]!.hpChange).toBe(-30);
    expect(s).toEqual(before);
    const actual = submitCommand(s, command('ranger-a3'), { advance: false });
    if (!actual.ok) throw new Error(actual.reason);
    apply(actual.session, 0, { familyId: 'time-stop' }, 20);
    expect(
      getTrapReference(actual.session, actual.session.state.traps[0]!.sequence),
    ).toMatchObject({ reference: null, inactiveReason: 'source-stopped' });
  });
});

describe('戦闘表示とログ差分の純粋照会', () => {
  it('1人1個の主予定と停止・ブレイクの参考待機を返す', () => {
    const s = fixture();
    apply(s, 1, { familyId: 'time-stop' }, 30);
    const enemy = s.state.participants[3];
    enemy.action = {
      kind: 'broken',
      break: { recovers: { kind: 'running', at: 160 } },
    };
    expect(getMainSchedules(s)).toHaveLength(4);
    expect(getMainSchedules(s)[1]).toMatchObject({
      kind: 'stopped',
      at: 130,
      frozenRemaining: 0,
    });
    expect(getMainSchedules(s)[3]).toMatchObject({
      kind: 'broken',
      at: 160,
      recoveryWaitReference: 125,
    });
    s.state.participants[2].hp = 0;
    s.state.participants[2].action = { kind: 'dead' };
    expect(getMainSchedules(s)).toHaveLength(3);
  });
  it('実付与者・残り回数・凍結状態と挑発／かばうの無効理由を区別する', () => {
    const s = fixture();
    apply(s, 3, { familyId: 'taunt' });
    apply(s, 2, { familyId: 'cover' });
    apply(s, 1, { familyId: 'reflect', ratio: 5000, charges: 2 });
    apply(s, 1, { familyId: 'time-stop' }, 30);
    expect(getStatusDetails(s, 'party-2')[0]).toMatchObject({
      frozen: true,
      inactiveReason: 'source-stopped',
      status: { sourceId: 'party-1', remainingCharges: 2 },
    });
    s.state.participants[0].hp = 0;
    s.state.participants[0].action = { kind: 'dead' };
    expect(getStatusDetails(s, 'boss-01')[0]!.inactiveReason).toBe(
      'source-dead',
    );
    expect(getStatusDetails(s, 'party-3')[0]!.inactiveReason).toBe(
      'source-dead',
    );
  });
  it('敵の予約済み詠唱と次の列を区別して全移行条件を公開する', () => {
    const s = fixture({
      skills: [skill('boss-01-s2', { target: 'self' })],
      enemy: {
        phases: [
          {
            id: 'phase-1',
            hpThreshold: 10000,
            actions: [
              { skillId: 'boss-01-s1', selection: 'lowest-hp' },
              { skillId: 'boss-01-s2', selection: 'self' },
            ],
          },
        ],
      },
    });
    const enemy = s.state.participants[3];
    if (enemy.side === 'enemy') enemy.actionIndex = 1;
    enemy.action = {
      kind: 'casting',
      cast: {
        command: {
          skillId: 'boss-01-s1',
          selectedTargetId: 'party-2',
          chosenElement: null,
        },
        completes: { kind: 'running', at: 150 },
      },
    };
    expect(getEnemyDetails(s)).toMatchObject({
      reservedCast: { selectedTargetId: 'party-2' },
      nextColumn: { skillId: 'boss-01-s2' },
      forecast: { isCasting: true, activatesAt: 150 },
    });
    expect(getEnemyDetails(s).definition.phases).toEqual(
      s.content.enemies[0]!.phases,
    );
  });
  it('ログ差分は連番順で、表示200件に制限しても全ログを保持する', () => {
    const s = fixture();
    const e = new Engine(s.content, s.state, s.log);
    for (let i = 0; i < 250; i++) e.record('heal', 'party-1', 'party-1', i);
    const before = structuredClone(s);
    const cursor = s.log.at(-3)!.sequence;
    expect(getBattleEvents(s, cursor)).toEqual(s.log.slice(-2));
    expect(getDisplayLog(s)).toEqual(s.log.slice(-200));
    expect(s.log.length).toBeGreaterThan(200);
    const view = getBattleDisplay(s);
    view.participants[0]!.participant.hp = 1;
    getDisplayLog(s)[0]!.amount = -1;
    expect(s).toEqual(before);
  });
});
