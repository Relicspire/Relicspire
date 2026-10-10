import type { GameRelease } from '../../game/data/release-model';

export function titleFor(release: GameRelease, id: string | null): string {
  if (id === 'basic-attack') return '通常攻撃';
  if (id === 'wait') return '待機';
  if (!id) return '—';
  const entry = release.presentation.entries[id];
  if (entry) return entry.name;
  if (/-(a|b)$/.test(id))
    return `${release.presentation.entries[id.slice(0, -2)]?.name ?? ''} ${id.slice(-1).toUpperCase()}系統`;
  return id;
}
export const inactiveText = {
  'source-dead': '付与者が戦闘不能',
  'source-stopped': '時間停止中',
  'source-broken': 'ブレイク中',
  'battle-finished': '戦闘終了',
  'charges-exhausted': '回数を消費済み',
};
export const resultText = {
  ongoing: '戦闘中',
  victory: '勝利',
  defeat: '敗北',
  escaped: '逃走',
};
export const eventText = {
  start: '戦闘開始',
  command: '行動',
  cast: '詠唱',
  fizzle: '不発',
  damage: 'ダメージ',
  heal: '回復',
  death: '戦闘不能',
  revive: '蘇生',
  break: 'ブレイク',
  recover: 'ブレイク復帰',
  status: '状態付与・延長',
  expire: '期限切れ',
  dispel: '解除',
  shift: '予定移動',
  cancel: '詠唱中断',
  trap: '罠',
  reflect: '反射',
  counter: '反撃',
  follow: '追撃',
  phase: 'フェーズ移行',
  result: '戦闘結果',
};
export const rejectionText = {
  'not-awaiting-input': '現在の手番ではありません',
  'unknown-skill': '未収録のスキルです',
  'not-learned': '未習得です',
  replaced: '上位スキルに置換済みです',
  cooldown: 'クールダウン中です',
  'invalid-element': '属性を選んでください',
  'unexpected-target': '対象を選ぶ必要はありません',
  'invalid-target': '有効な対象がありません',
};
export const effectResultText = {
  applied: '効果適用',
  'status-added': '状態を付与',
  'status-refreshed': '期限を延長',
  'dead-target': '戦闘不能の対象',
  'invalid-target': '対象が不適格',
  'immune-element': '属性無効',
  'immune-stop': '時間停止無効',
  'immune-cancel': '詠唱中断無効',
  'not-casting': '詠唱していない',
  'no-dispellable-status': '解除できる状態なし',
  'no-shiftable-schedule': '移動できる予定なし',
  'immune-shift': '予定移動無効',
  'schedule-limit': '予定移動の限界',
  'hp-full': 'HP満タン',
  'attack-rejected': '攻撃が成立せず付随効果も不成立',
  'no-target': '対象なし',
};
