import {
  checkCommand,
  getInputActor,
  type BattleSession,
  type PlayerCommand,
} from '../game/battle';

/** 初期予算3、装備交換なし。弱点攻撃・低HP回復・通常攻撃の公開情報だけを使う。 */
export function chooseCommand<T>(session: BattleSession<T>): PlayerCommand {
  const actorId = getInputActor(session);
  if (!actorId) throw new Error('入力待ちの味方がいません');
  const low = session.state.participants
    .filter((p) => p.side === 'party' && p.hp > 0)
    .sort((a, b) => a.hp / a.stats.maxHp - b.hp / b.stats.maxHp)[0]!;
  const enemy = session.setup.enemyId;
  const command = (
    skillId: PlayerCommand['skillId'],
    selectedTargetId: PlayerCommand['selectedTargetId'] = enemy,
    chosenElement: PlayerCommand['chosenElement'] = null,
  ): PlayerCommand => ({ actorId, skillId, selectedTargetId, chosenElement });
  const options = [
    ...(low.hp < low.stats.maxHp * 0.65
      ? [command('cleric-a2', low.id), command('cleric-a1', low.id)]
      : []),
    command('wizard-b2', enemy, 'lightning'),
    command('wizard-b1', enemy, 'lightning'),
    command('berserker-b2'),
    command('berserker-b1'),
    command('thief-a2'),
    command('thief-a1'),
    command('ranger-a2'),
    command('ranger-a1'),
    command('basic-attack'),
  ];
  return options.find((c) => checkCommand(session, c).ok)!;
}
