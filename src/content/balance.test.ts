import { describe, expect, it } from 'vitest';
import input from './release.json';
import { parseGameRelease } from '../game/data/release';
import { createBattle, submitCommand, type PartyBuild } from '../game/battle';
import type { JobId, SkillNodeId } from '../game/data/model';
import { chooseCommand } from './strategy.test-support';

const release = parseGameRelease(input);
const compositions: { name: string; jobs: JobId[]; routes: ('a' | 'b')[] }[] = [
  {
    name: 'ナイト・雷・回復',
    jobs: ['knight', 'wizard', 'cleric'],
    routes: ['a', 'b', 'a'],
  },
  {
    name: '破砕・短ディレイ・回復',
    jobs: ['berserker', 'thief', 'cleric'],
    routes: ['b', 'a', 'a'],
  },
  {
    name: '妨害射撃・雷・回復',
    jobs: ['ranger', 'wizard', 'cleric'],
    routes: ['a', 'b', 'a'],
  },
  {
    name: '初期編成（火耐性を通常攻撃で補う）',
    jobs: ['knight', 'wizard', 'cleric'],
    routes: ['a', 'a', 'a'],
  },
];
describe('第1階層の初期予算での攻略', () => {
  for (const composition of compositions) {
    it.each(release.content.enemies.map((e) => [e.id] as const))(
      `${composition.name}は %s を初期装備・予算3で討伐できる`,
      (enemyId) => {
        const party = release.content.characters.map((c, i): PartyBuild => ({
          id: c.id,
          jobId: composition.jobs[i]!,
          learnedSkills: [1, 2].map(
            (rank) =>
              `${composition.jobs[i]}-${composition.routes[i]}${rank}` as SkillNodeId,
          ),
          equipment: c.initialEquipment,
        })) as [PartyBuild, PartyBuild, PartyBuild];
        let session = createBattle(release.content, {
          party,
          enemyId,
          campaign: release.campaign,
        });
        let turns = 0;
        while (session.state.result === 'ongoing' && turns < 100) {
          const result = submitCommand(session, chooseCommand(session));
          if (!result.ok) throw new Error(result.reason);
          session = result.session;
          turns++;
        }
        expect(session.state.result).toBe('victory');
        expect(turns).toBeLessThan(60);
        expect(
          session.state.participants.filter(
            (p) => p.side === 'party' && p.hp > 0,
          ),
        ).toHaveLength(3);
        console.info(
          `${composition.name} / ${enemyId}: ${turns}手, ${session.state.now} TU`,
        );
      },
    );
  }
});
