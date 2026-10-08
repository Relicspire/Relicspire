import { describe, expect, it } from 'vitest';
import {
  actorSnapshot,
  breakAmount,
  clampStats,
  damageAmount,
  delayTU,
  elementMultiplier,
  healAmount,
  initialWaitTU,
} from './calculations';
import { attackPayload, fixture } from './fixtures.test-support';

describe('計算式の上下限と丸め', () => {
  it('各能力値の下限・上限と入力の非変更を固定する', () => {
    const lower = { maxHp: 0, atk: 0, mag: 0, def: -1, mdef: -1, spd: 24 };
    expect(clampStats(lower)).toEqual({
      maxHp: 1,
      atk: 1,
      mag: 1,
      def: 0,
      mdef: 0,
      spd: 25,
    });
    expect(lower.spd).toBe(24);
    const upper = {
      maxHp: 100000,
      atk: 10000,
      mag: 10000,
      def: 10000,
      mdef: 10000,
      spd: 401,
    };
    expect(clampStats(upper)).toEqual({
      maxHp: 99999,
      atk: 9999,
      mag: 9999,
      def: 9999,
      mdef: 9999,
      spd: 400,
    });
    const exact = {
      maxHp: 99999,
      atk: 1,
      mag: 9999,
      def: 0,
      mdef: 9999,
      spd: 25,
    };
    expect(clampStats(exact)).toEqual(exact);
  });
  it.each([
    [0, 400, 1],
    [1, 400, 1],
    [100, 120, 84],
    [100, 25, 400],
    [100, 400, 25],
  ])('基礎ディレイ%s・SPD%sは%s TU', (base, spd, expected) => {
    expect(delayTU(base, spd)).toBe(expected);
  });
  it.each([
    [25, 400],
    [120, 84],
    [400, 25],
  ])('SPD%sの初期待機は%s TU', (spd, expected) => {
    expect(initialWaitTU(spd)).toBe(expected);
  });
  it('無属性・弱点・耐性・無効と味方への属性倍率を固定する', () => {
    const e = fixture().content.enemies[0]!;
    e.weakness = 'fire';
    e.resistance = 'ice';
    e.immuneElements = ['dark'];
    expect(
      ['none', 'fire', 'ice', 'dark', 'light'].map((element) =>
        elementMultiplier(
          element as Parameters<typeof elementMultiplier>[0],
          e,
        ),
      ),
    ).toEqual([10000, 15000, 5000, 0, 10000]);
    expect(elementMultiplier('fire', null)).toBe(10000);
  });
  it('物理はDEF、魔法はMDEFを参照し、防御超過でも最低1、無効だけ0', () => {
    const s = fixture();
    const a = actorSnapshot(s.state.participants[0]);
    const target = s.state.participants[3];
    target.stats.def = 9999;
    target.stats.mdef = 0;
    expect(damageAmount(attackPayload(), a, target, 'none', null)).toBe(1);
    expect(
      damageAmount(
        attackPayload({ damageType: 'magic' }),
        a,
        target,
        'none',
        null,
      ),
    ).toBe(40);
    const e = { ...s.content.enemies[0]!, immuneElements: ['fire' as const] };
    expect(damageAmount(attackPayload(), a, target, 'fire', e)).toBe(0);
  });
  it.each([
    [49, 80],
    [50, 80],
    [51, 30],
  ])('背水のHP%s/100はダメージ%s', (hp, expected) => {
    const s = fixture();
    const a = { ...actorSnapshot(s.state.participants[0]), hp, maxHp: 100 };
    expect(
      damageAmount(
        attackPayload({
          power: {
            kind: 'low-hp',
            normal: 100,
            lowHp: 225,
            snapshot: 'before-activation',
          },
        }),
        a,
        s.state.participants[3],
        'none',
        null,
      ),
    ).toBe(expected);
  });
  it.each([
    [-1, 10],
    [2500, 10],
    [10000, 40],
    [40000, 160],
    [50000, 160],
  ])('与ダメージ・回復補正%sを上下限へ制限する', (modifier, expected) => {
    const s = fixture();
    const a = {
      ...actorSnapshot(s.state.participants[0]),
      damageModifier: modifier,
      healingModifier: modifier,
    };
    const target = s.state.participants[3];
    target.stats.def = 0;
    expect(damageAmount(attackPayload(), a, target, 'none', null)).toBe(
      expected,
    );
    expect(healAmount(100, a)).toBe(expected);
  });
  it('回復と弱点ゲージ削りを最後に一度だけ切り捨てる', () => {
    const s = fixture();
    const a = { ...actorSnapshot(s.state.participants[0]), mag: 31 };
    expect(healAmount(125, a)).toBe(38);
    expect(healAmount(0, a)).toBe(1);
    const e = {
      ...s.content.enemies[0]!,
      weakness: 'fire' as const,
      breakResistance: 2500,
    };
    expect(breakAmount(20, 'fire', e)).toBe(30);
    expect(breakAmount(7, 'none', e)).toBe(5);
    expect(breakAmount(7, 'fire', { ...e, breakResistance: 9999 })).toBe(0);
    expect(breakAmount(7, 'fire', { ...e, breakResistance: 10000 })).toBe(0);
    expect(breakAmount(0, 'fire', e)).toBe(0);
  });
});
