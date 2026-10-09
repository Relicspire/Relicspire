import { useState } from 'react';
import type { GameRelease } from '../../game/data/release';
import type { CharacterId, EquipmentId } from '../../game/data/model';
import {
  getInventory,
  setEquipment,
  transferEquipment,
  type EquipmentLocation,
  type FormationContext,
  type FormationResult,
  type FormationState,
} from '../../game/party';

export function EquipmentPanel({
  release,
  draft,
  context,
  disabled,
  change,
}: {
  release: GameRelease;
  draft: FormationState;
  context: FormationContext;
  disabled: boolean;
  change: (result: FormationResult<FormationState>) => void;
}) {
  const [source, setSource] = useState<EquipmentLocation | null>(null);
  const [item, setItem] = useState<EquipmentId | null>(null);
  const inventory = getInventory(release.content, context, release.campaign);
  const used = (id: EquipmentId) =>
    draft.party.flatMap((p) => p.equipment).filter((value) => value === id)
      .length;
  const label = (id: string) => release.presentation.entries[id]?.name ?? id;
  const transfer = (target: EquipmentLocation) => {
    if (disabled) return;
    if (source)
      change(
        transferEquipment(
          release.content,
          draft,
          source,
          target,
          context,
          'swap',
        ),
      );
    else change(setEquipment(release.content, draft, target, item, context));
    setSource(null);
    setItem(null);
  };
  return (
    <>
      <h3>宝物庫</h3>
      <p>
        装備を選んで枠をタップすると装着。装備中の枠を選び、別の枠をタップすると交換します。PCでは枠や宝物庫からドラッグできます。
      </p>
      <div className="inventory-grid">
        {[...inventory]
          .filter(
            ([id, count]) =>
              count > 0 ||
              release.content.equipment.some((entry) => entry.id === id),
          )
          .map(([id, count]) => {
            const definition = release.content.equipment.find(
              (entry) => entry.id === id,
            );
            return (
              <article key={id}>
                <h4>{label(id)}</h4>
                <p>
                  所持 {count} ／ 装備中 {used(id)} ／ 残り {count - used(id)}
                </p>
                <p>{release.presentation.entries[id]?.description}</p>
                <p>
                  {definition
                    ? Object.entries(definition.stats)
                        .map(
                          ([stat, value]) =>
                            `${stat === 'maxHp' ? 'HP' : stat.toUpperCase()} +${value}`,
                        )
                        .join(' ／ ') || '能力加算なし'
                    : 'この版では未収録'}
                </p>
                <button
                  disabled={disabled || !definition || count <= used(id)}
                  aria-pressed={item === id && !source}
                  draggable={!disabled && !!definition && count > used(id)}
                  onDragStart={(e) => {
                    e.dataTransfer.setData(
                      'application/x-relicspire-equipment',
                      JSON.stringify({ item: id }),
                    );
                  }}
                  onClick={() => {
                    setItem(id);
                    setSource(null);
                  }}
                >
                  {label(id)}を選ぶ
                </button>
              </article>
            );
          })}
      </div>
      <button
        disabled={disabled}
        onClick={() => {
          setItem(null);
          setSource(null);
        }}
      >
        装備の選択を取り消す
      </button>
      <p role="status">
        {source
          ? `${label(source.characterId)}の枠${source.slot + 1}を交換元に選択中`
          : item
            ? `${label(item)}を装着する枠を選んでください`
            : '枠を選ぶと交換元になります。「外す」で宝物庫へ戻せます。'}
      </p>
      <div className="party-grid">
        {draft.party.map((build) => (
          <article key={build.id}>
            <h3>{label(build.id)}</h3>
            <ol className="equipment-slots">
              {build.equipment.map((id, slot) => {
                const location = { characterId: build.id, slot };
                return (
                  <li
                    key={slot}
                    onDragOver={(e) => {
                      if (!disabled) e.preventDefault();
                    }}
                    onDrop={(e) => {
                      e.preventDefault();
                      if (disabled) return;
                      try {
                        const raw = JSON.parse(
                          e.dataTransfer.getData(
                            'application/x-relicspire-equipment',
                          ),
                        ) as { source?: EquipmentLocation; item?: EquipmentId };
                        if (
                          raw.source &&
                          draft.party.some(
                            (p) => p.id === raw.source?.characterId,
                          )
                        )
                          change(
                            transferEquipment(
                              release.content,
                              draft,
                              raw.source,
                              location,
                              context,
                              'swap',
                            ),
                          );
                        else if (
                          raw.item &&
                          release.content.equipment.some(
                            (entry) => entry.id === raw.item,
                          )
                        )
                          change(
                            setEquipment(
                              release.content,
                              draft,
                              location,
                              raw.item,
                              context,
                            ),
                          );
                      } catch {
                        /* 他アプリ由来のドラッグは編成候補に取り込まない。 */
                      }
                      setSource(null);
                      setItem(null);
                    }}
                  >
                    <button
                      disabled={disabled}
                      aria-label={`${label(build.id)}の枠${slot + 1}：${id ? label(id) : '空欄'}`}
                      aria-pressed={
                        source?.characterId === build.id && source.slot === slot
                      }
                      draggable={!disabled && id !== null}
                      onDragStart={(e) =>
                        e.dataTransfer.setData(
                          'application/x-relicspire-equipment',
                          JSON.stringify({ source: location }),
                        )
                      }
                      onClick={() => {
                        if (source || item) transfer(location);
                        else {
                          setSource({
                            characterId: build.id as CharacterId,
                            slot,
                          });
                          setItem(null);
                        }
                      }}
                    >
                      枠{slot + 1} {id ? label(id) : '空欄'}
                    </button>
                    <button
                      disabled={disabled || !id}
                      aria-label={`${label(build.id)}の枠${slot + 1}を外す`}
                      onClick={() => {
                        change(
                          setEquipment(
                            release.content,
                            draft,
                            location,
                            null,
                            context,
                          ),
                        );
                        setSource(null);
                        setItem(null);
                      }}
                    >
                      外す
                    </button>
                  </li>
                );
              })}
            </ol>
          </article>
        ))}
      </div>
    </>
  );
}
