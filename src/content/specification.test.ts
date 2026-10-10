import source from '../../docs/growth-party-rewards.md?raw';
import { describe, expect, it } from 'vitest';
import input from './release.json';
import { parseGameRelease } from '../game/data/release';
import type { AttackPayload, JobId } from '../game/data/model';

const release = parseGameRelease(input);
describe('正式スキルと確定仕様表の照合', () => {
  it('全48ノードの名称・詠唱・D・CD・威力・削り・回復が成長仕様表と一致する', () => {
    let job: JobId | null = null;
    let count = 0;
    for (const line of source.split('\n')) {
      const heading = line.match(/^### 2\.\d+ .*（`([^`]+)`）/);
      if (heading) job = heading[1] as JobId;
      if (!job || !/^\| [AB][123] \|/.test(line)) continue;
      const cells = line.split('|').map((s) => s.trim());
      const id = `${job}-${cells[1]!.toLowerCase()}`;
      const actual = release.content.skills.find((s) => s.id === id)!;
      expect(actual, id).toBeDefined();
      expect(release.presentation.entries[id]!.name, id).toBe(cells[2]);
      expect([actual.castTime, actual.delay, actual.cooldown], id).toEqual(
        cells.slice(5, 8).map(Number),
      );
      const attack = actual.effects.find(
        (e) =>
          e.kind === 'attack' ||
          e.kind === 'trap' ||
          (e.kind === 'apply-status' && 'attack' in e.status),
      );
      const payload: AttackPayload | undefined =
        attack?.kind === 'attack'
          ? attack
          : attack?.kind === 'trap'
            ? attack.attack
            : attack?.kind === 'apply-status' && 'attack' in attack.status
              ? attack.status.attack
              : undefined;
      const power = cells[4]!.match(/威(\d+)/);
      if (power) {
        expect(payload, id).toBeDefined();
        expect(
          typeof payload!.power === 'number'
            ? payload!.power
            : payload!.power.normal,
          id,
        ).toBe(Number(power[1]));
        const low = cells[4]!.match(/背水時(\d+)/);
        if (low)
          expect(payload!.power, id).toMatchObject({ lowHp: Number(low[1]) });
      }
      const gauge = cells[4]!.match(/削(\d+)/);
      if (gauge) expect(payload!.breakDamage, id).toBe(Number(gauge[1]));
      const heal = cells[4]!.match(/回(\d+)/);
      if (heal)
        expect(
          actual.effects.find((e) => e.kind === 'heal'),
          id,
        ).toMatchObject({ power: Number(heal[1]) });
      count++;
    }
    expect(count).toBe(48);
  });
  it('全守護者が固定2手、ボスが固定3手を反復し、火耐性・雷弱点と妨害可能を公開する', () => {
    for (const enemy of release.content.enemies) {
      expect(enemy.phases).toHaveLength(1);
      expect(enemy.phases[0]!.actions.map((a) => a.skillId)).toEqual(
        Array.from(
          { length: enemy.id === 'boss-01' ? 3 : 2 },
          (_, i) => `${enemy.id}-s${i + 1}`,
        ),
      );
      expect([enemy.weakness, enemy.resistance]).toEqual(['lightning', 'fire']);
      expect([
        enemy.breakResistance,
        enemy.knockbackResistance,
        enemy.cancelImmune,
        enemy.timeStopImmune,
      ]).toEqual([0, 0, false, false]);
    }
  });
});
