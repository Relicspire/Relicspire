import type { ParticipantId, StatusEffect } from '../data/battle';
import type { Effect, SkillId, UtilityPayload } from '../data/model';

/** 効果が成立した種類、または処理直前の状態から決まる不成立理由。 */
export type EffectResultCode =
  | 'applied'
  | 'status-added'
  | 'status-refreshed'
  | 'dead-target'
  | 'invalid-target'
  | 'immune-element'
  | 'immune-stop'
  | 'immune-cancel'
  | 'not-casting'
  | 'no-dispellable-status'
  | 'no-shiftable-schedule'
  | 'immune-shift'
  | 'schedule-limit'
  | 'hp-full'
  | 'attack-rejected'
  | 'no-target';

/** 診断対象の定義位置。反応・罠ではノード添字の代わりに設置物／状態のIDを使う。 */
export interface EffectContext {
  skillId: SkillId | null;
  effectIndex: number | null;
  attachedIndex: number | null;
  origin: 'skill' | 'counter' | 'follow' | 'trap';
  originId: number | null;
  requestedTargetId: ParticipantId | null;
}

/** ログとは独立した連番を持つ効果結果。前後の状態コピーで期限のみの更新を確認できる。 */
export interface EffectResult extends EffectContext {
  sequence: number;
  now: number;
  actorId: ParticipantId;
  targetId: ParticipantId | null;
  kind: Effect['kind'] | UtilityPayload['kind'];
  outcome: 'applied' | 'rejected';
  code: EffectResultCode;
  cause: EffectResultCode | null;
  amount: number | null;
  statusBefore: StatusEffect | null;
  statusAfter: StatusEffect | null;
}
