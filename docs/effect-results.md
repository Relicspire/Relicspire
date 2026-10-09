# 効果単位の成立・不成立診断

`BattleSession.effectResults`は本エンジンが効果処理時に生成する診断履歴。`src/game/battle/queries.ts`の`getEffectResults(session, afterSequence?)`で独立コピーを取得できる。`getBattleDelta`の`effectResults`には前後のセッション間で新しく生成された診断だけを含める。

## 予測と実行

- 即時コマンドの`previewCommand(...).committed.effectResults`は、同じ入力を`submitCommand(..., { advance: false })`で実行した診断と一致する。
- 詠唱予約の`committed`には発動効果の診断を含めない。`reference.effectResults`は現在状態で発動した場合の参考結果。実発動はその時点で診断し直すため、対象の戦闘不能などで結果が変わり得る。
- 罠の設置は`kind: 'trap'`の成立診断。`trapReferences`の参考発動は`origin: 'trap'`として別に取得する。反撃・追撃も状態IDに対応する攻撃診断を記録する。
- `getEffectWarnings`は入力前の警告。先行ダメージ・ブレイク・状態操作を反映した実際の効果結果とは区別する。

照会と予測は元の状態・ログ・診断履歴を変更しない。診断は本エンジンの処理位置で作り、UI側でHP差分から理由を推測する必要はない。

## 結果の識別

| フィールド | 内容 |
| --- | --- |
| `sequence` / `now` | 診断専用の1始まり連番と実処理TU |
| `skillId` / `effectIndex` | スキルIDと独立効果の元配列添字 |
| `attachedIndex` | 付随効果の元配列添字。独立効果はnull |
| `origin` / `originId` | skill／counter／follow／trapと反応状態・設置物のID。反応・罠のskillIdとeffectIndexはnull |
| `actorId` | 効果の実行者 |
| `requestedTargetId` / `targetId` | 当初の対象と実対象。かばうで異なる場合がある。全体効果は対象ごとに記録する |
| `kind` / `outcome` / `code` | 効果種別、applied／rejected、成立種別・不成立理由 |
| `cause` | 親攻撃の不成立理由。該当しなければnull |
| `amount` | 実HP適用量、実移動TU、解除数、状態・罠の持続TUなど。該当しなければnull |
| `statusBefore` / `statusAfter` | 状態付与・更新の前後コピー。新規付与のbeforeはnull |

診断の記録順は実際の処理順。付随効果は時間操作→詠唱解除→状態付与→解除の順に処理し、添字は元定義の位置を保持する。対象集合は従来どおり発動時に固定し、先行効果で戦闘不能になった対象への後続効果も診断する。

## 成立種別と不成立理由

| `code` | 意味 |
| --- | --- |
| `applied` | 効果を実適用した |
| `status-added` | 状態を新規付与した |
| `status-refreshed` | 同系統状態の期限だけ更新した |
| `dead-target` | 処理直前に対象が戦闘不能だった |
| `invalid-target` | 発動時の対象規則、または蘇生・罠の対象条件を満たさない |
| `no-target` | 発動時の全体対象集合が空だった |
| `immune-element` | 属性無効で攻撃が成立しない |
| `attack-rejected` | 親攻撃が成立せず付随効果を実行しない。causeで理由を示す |
| `immune-stop` / `immune-cancel` | 停止／詠唱解除への固有耐性 |
| `not-casting` | 先行ブレイクや解除を反映し、処理直前に対象が詠唱中ではない |
| `no-dispellable-status` | 指定極性の解除可能な状態がない |
| `no-shiftable-schedule` | 時間操作可能な主予定がない、または手番到達済み・処理中の前進 |
| `immune-shift` | 後退耐性により移動TUが0になった |
| `schedule-limit` | 0 TU指定や前進下限により主予定が変化しなかった |
| `hp-full` | 満タンで実回復量が0だった |

同系統再付与の`statusAfter`は元の性能・付与者・ID・残り回数を保持し、期限を更新する。時間停止では従来の停止解除時刻も更新する。前後コピーは付与直後のもので、同じ行動内の後続解除や反応消費で遡って変化しない。

入力自体の拒否は従来の`checkCommand`で返し、診断履歴を追加しない。空の効果配列も診断は空となる。毒の周期ダメージ・反射・自己蘇生などは従来のイベントログ・状態差分で取得し、このスキル効果診断とは区別する。

## カーソルと既存契約

診断はログ連番・状態連番・予定IDを消費せず、既存ログの内容・200件表示上限・処理順を維持する。取得には診断専用カーソルを使う。全ログと同様にセッション内の全履歴を保持し、保存進行には含めない。リトライではログと診断履歴をリセットして再生成するため、画面側もカーソルをリセットする。

日本語名のテストで、致死ダメージ・先行ブレイク・かばう・属性無効・固有耐性・解除対象なし・新規状態／同系統更新・蘇生対象・実回復量・罠・詠唱参考値と実発動の差、即時予測一致、カーソル、入力の非変更を確認する。
