import { useState } from 'react';
import { useStore } from 'zustand';
import type { GameState } from '../../state/game';
import { Dialog } from '../../app/Dialog';
import { EnemyActions } from '../battle/BattleInfo';
import { ExplorationView } from './ExplorationView';

export function Exploration({
  game,
  disabled,
  reducedMotion,
}: {
  game: GameState;
  disabled: boolean;
  reducedMotion: boolean;
}) {
  const progression = useStore(game.progression).value;
  const { encounter, entryText } = useStore(game.exploration);
  const { session } = useStore(game.battle);
  const settings = useStore(game.settings).value;
  const [error, setError] = useState('');
  const [reading, setReading] = useState(false);
  if (!progression || progression.location.kind !== 'floor') return null;
  const location = progression.location;
  const { release } = game;
  const floor = release.content.floors.find((f) => f.id === location.floorId)!;
  const node = floor.nodes.find((n) => n.id === location.nodeId)!;
  const text = release.presentation.floors[floor.id]!;
  const enemy = encounter
    ? release.content.enemies.find((e) => e.id === encounter.enemyId)!
    : null;
  const name = (id: string) => release.presentation.entries[id]?.name ?? id;
  const act = async (action: () => Promise<void>) => {
    if (disabled) return;
    setError('');
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  const blocked =
    disabled || reading || !!encounter || !!session || !!entryText;
  const nextFloor = release.campaign.enemies.find(
    (e) => e.id === `boss-${floor.id.slice(-2)}`,
  )?.reward.unlockFloorId;
  return (
    <section className="exploration" aria-label="迷宮探索">
      <p className="eyebrow">
        第{Number(floor.id.slice(-2))}階層 · {text.theme}
      </p>
      <h2>探索の再開</h2>
      <p aria-live="polite">現在地：{name(location.nodeId)}</p>
      {node.enemies.length > 0 &&
        node.enemies.every((id) =>
          progression.defeatedEnemyIds.includes(id),
        ) && <p>討伐済み · この部屋の敵は再出現しません。</p>}
      <ExplorationView
        location={location.nodeId}
        enemy={!!enemy || !!session}
        paths={node.links.length}
        paused={disabled || !!encounter || !!entryText}
        reducedMotion={reducedMotion}
        speed={settings?.animationSpeed ?? 1}
      />
      {error && <p role="alert">{error}</p>}
      {!session && (
        <>
          <nav aria-label="経路選択">
            {node.links.map((id) => {
              const target = floor.nodes.find((n) => n.id === id)!;
              const alive = target.enemies.find(
                (e) => !progression.defeatedEnemyIds.includes(e),
              );
              return (
                <button
                  key={id}
                  aria-describedby={`path-direction-${id}`}
                  disabled={blocked}
                  onClick={() => void act(() => game.move(id))}
                >
                  {name(id)}
                  {alive
                    ? ` · ${name(alive)}`
                    : target.enemies.length
                      ? ' · 討伐済み'
                      : ''}
                  <span
                    id={`path-direction-${id}`}
                    className="block text-sm"
                    aria-hidden="true"
                  >
                    {id.endsWith('-alcove-1') || id.endsWith('-alcove-3')
                      ? '左の枝'
                      : id.endsWith('-alcove-2') || id.endsWith('-alcove-4')
                        ? '右の枝'
                        : id.endsWith('-alcove-5')
                          ? '奥の枝'
                          : node.links[0] === id && !node.id.endsWith('-entry')
                            ? '戻る'
                            : '進む'}
                  </span>
                </button>
              );
            })}
          </nav>
          {location.nodeId.endsWith('-boss') && nextFloor && (
            <button
              disabled={
                blocked || !release.scope.playableFloorIds.includes(nextFloor)
              }
              onClick={() => void act(() => game.nextFloor())}
            >
              {release.scope.playableFloorIds.includes(nextFloor)
                ? '次の階層へ進む'
                : '次の階層はこの版では未収録です'}
            </button>
          )}
          <button
            disabled={blocked}
            onClick={() => void act(() => game.returnToGuild())}
          >
            拠点へ帰還
          </button>
          <button disabled={blocked} onClick={() => setReading(true)}>
            {location.nodeId.endsWith('-hall-3')
              ? '予告碑・ボスの攻略ヒントを読む'
              : '入口の本文・攻略ヒントを読む'}
          </button>
        </>
      )}
      {!disabled && (entryText || reading) && (
        <Dialog
          title={
            reading && location.nodeId.endsWith('-hall-3')
              ? `${name(`boss-${floor.id.slice(-2)}`)}の予告碑`
              : '迷宮の入口'
          }
          onClose={() => {
            if (disabled) return;
            game.dismissEntry();
            setReading(false);
          }}
        >
          <p>{entryText ?? text.entryText}</p>
          {reading && text.hints.map((hint, i) => <p key={i}>{hint}</p>)}
          <button
            disabled={disabled}
            onClick={() => {
              game.dismissEntry();
              setReading(false);
            }}
          >
            探索を続ける
          </button>
        </Dialog>
      )}
      {enemy && !session && !disabled && (
        <Dialog
          title={name(enemy.id)}
          onClose={() => {
            if (!disabled) game.avoidEncounter();
          }}
        >
          <p>{release.presentation.entries[enemy.id]?.description}</p>
          <p>
            HP {enemy.stats.maxHp} / ブレイクゲージ {enemy.maxBreakGauge}
          </p>
          <p>
            ATK {enemy.stats.atk} / MAG {enemy.stats.mag} / DEF{' '}
            {enemy.stats.def} / MDEF {enemy.stats.mdef} / SPD {enemy.stats.spd}
          </p>
          <p>
            弱点：{release.presentation.elements[enemy.weakness]} / 耐性：
            {release.presentation.elements[enemy.resistance]}
          </p>
          <p>
            初回報酬：各人に{enemy.reward.skillPointsPerCharacter}ポイント
            {enemy.reward.equipment
              .map((e) => ` / ${name(e.id)} × ${e.quantity}`)
              .join('')}
          </p>
          <EnemyActions enemy={enemy} release={release} />
          <p>戦う場合は現在の編成と復帰先を保存してから開始します。</p>
          <button
            disabled={disabled}
            onClick={() => void act(() => game.startBattle(encounter!))}
          >
            戦う
          </button>
          <button disabled={disabled} onClick={() => game.avoidEncounter()}>
            回避する
          </button>
        </Dialog>
      )}
    </section>
  );
}
