import type { GameRelease } from '../game/data/release-model';
import {
  createInitialFormation,
  inspectPresetCollection,
  previewCurrentPartyRecovery,
} from '../game/party';
import type { FormationState } from '../game/party';
import {
  createInitialProgression,
  previewProgressionRecovery,
  type Progression,
} from '../game/progression';
import type { SaveSnapshot } from '../storage/save';

export const SCHEMA_VERSION = 1;
export const DEFAULT_SETTINGS = {
  masterVolume: 80,
  bgmVolume: 60,
  seVolume: 80,
  ambientVolume: 40,
  muted: false,
  animationSpeed: 1,
  screenShake: false,
  skipBattleAnimations: false,
};
export type Settings = typeof DEFAULT_SETTINGS;
export interface SaveData extends FormationState {
  progression: Progression;
  settings: Settings;
}
export function initialSave(
  release: GameRelease,
  settings = DEFAULT_SETTINGS,
): SaveData {
  const formation = createInitialFormation(release.content, {
    defeatedEnemyIds: [],
    inBattle: false,
  });
  if (!formation.ok) throw new Error('初期編成が不正です');
  return {
    ...formation.value,
    progression: createInitialProgression(),
    settings: { ...settings },
  };
}
export function repairSettings(input: unknown): Settings {
  const raw =
    input && typeof input === 'object'
      ? (input as Record<string, unknown>)
      : {};
  return Object.fromEntries(
    Object.entries(DEFAULT_SETTINGS).map(([key, fallback]) => {
      const value = raw[key];
      const valid =
        typeof fallback === 'boolean'
          ? typeof value === 'boolean'
          : key === 'animationSpeed'
            ? [0.5, 1, 2].includes(value as number)
            : typeof value === 'number' &&
              Number.isInteger(value) &&
              value >= 0 &&
              value <= 100;
      return [key, valid ? value : fallback];
    }),
  ) as Settings;
}
export interface SaveInspection {
  candidate: SaveData | null;
  changes: string[];
  error: string | null;
  future: boolean;
}
/** 旧schema0は同一の正規データ構造。内容版は明示対応のある現版だけを許可する。 */
export function migrateSave(input: unknown, version: number): unknown {
  if (version !== 0 && version !== SCHEMA_VERSION)
    throw new Error('未対応の保存形式です');
  return structuredClone(input);
}
export function inspectSave(
  release: GameRelease,
  input: unknown,
): SaveInspection {
  const fail = (error: string, future = false): SaveInspection => ({
    candidate: null,
    changes: [],
    error,
    future,
  });
  if (!input || typeof input !== 'object')
    return fail('保存データの構造が不正です');
  const s = input as SaveSnapshot<SaveData>;
  if (
    s.schemaVersion > SCHEMA_VERSION ||
    s.contentVersion > release.contentVersion
  )
    return fail('新版アプリで開いてください', true);
  if (
    typeof s.saveId !== 'string' ||
    !s.saveId ||
    !Number.isSafeInteger(s.revision) ||
    s.revision < 1 ||
    !Number.isFinite(s.updatedAt)
  )
    return fail('保存識別情報が不正です');
  if (
    ![0, SCHEMA_VERSION].includes(s.schemaVersion) ||
    s.contentVersion !== release.contentVersion
  )
    return fail('この版からの移行は未対応です');
  const data = migrateSave(s.data, s.schemaVersion) as SaveData | undefined;
  if (!data) return fail('保存内容がありません');
  const p = previewProgressionRecovery(release, data.progression);
  if (!p.ok || !p.value.canApply)
    return fail('進行が破損しています。元データを保持しています');
  const context = {
    defeatedEnemyIds: p.value.progression.defeatedEnemyIds,
    inBattle: false,
  };
  const party = previewCurrentPartyRecovery(
    release.content,
    data.party,
    context,
  );
  const presets = inspectPresetCollection(
    release.content,
    data.presets,
    context,
  );
  if (!party.ok || party.value.issues.length || !presets.metadataValid)
    return fail('編成またはプリセット管理情報が破損しています');
  const candidate: SaveData = {
    progression: p.value.progression,
    party: party.value.party,
    presets: structuredClone(data.presets),
    settings: repairSettings(data.settings),
  };
  const changes = [
    ...p.value.changes.map((c) => `${c.path}: ${c.reason}`),
    ...party.value.changes.map((c) => `${c.path}: ${c.reason}`),
  ];
  if (JSON.stringify(candidate.settings) !== JSON.stringify(data.settings))
    changes.push('不正・欠落した設定を既定値へ修復');
  if (s.schemaVersion !== SCHEMA_VERSION) changes.push('schemaVersion: 0 → 1');
  return { candidate, changes, error: null, future: false };
}
