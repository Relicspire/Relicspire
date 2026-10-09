# 3.1 データ定義

実装は `src/game/data/model.ts`（コンテンツ）、`battle.ts`（一時戦闘状態）、`validation.ts`（読み込み境界）に分離する。React・Zustand・PixiJSには依存しない。具体的な全48ノード／60遭遇の投入、能力計算、編成検証、セーブモデルは後続タスクで実装する。

## ID規則

| 対象 | ID |
| --- | --- |
| キャラクター | `party-1`～`party-3` |
| ジョブ | `knight`、`wizard`、`cleric`、`thief`、`ranger`、`berserker`、`time-mage`、`paladin` |
| スキルノード／プレイヤースキル | `<job>-a1`～`a3`、`b1`～`b3` |
| 通常コマンド | `basic-attack`、`wait` |
| 置換グループ／CD | ランク1・2は `<job>-a/b`、3はノードID。敵・通常コマンドはスキルID |
| 初期装備 | `starter-sword/staff/armor/charm/boots/ring` |
| 遺物 | `relic-01-01`～`relic-10-05` |
| 敵 | `boss-01`～`boss-10`、`guardian-01-01`～`guardian-10-05` |
| 敵スキル | `<enemy>-s1/s2/s3` |
| 階層 | `floor-01`～`floor-10` |
| マップノード | `<floor>-entry/boss/hall-1..3/alcove-1..5` |
| フェーズ | 敵内で一意の小文字英数字・ハイフンID |
| 戦闘イベント／状態／罠 | 戦闘内の数値連番。永続コンテンツIDとは別 |

型はテンプレートリテラルで表現し、未知JSONの検証でも同じ規則を適用する。TU・HP・能力値・威力は安全な整数、倍率は10000を1倍とする整数。装備は部位制限のない順序付き6枠、遺物もEquipmentDefinitionの一種とする。

## Effectと対象・能力参照

Effectは判別可能なunionとし、攻撃・回復・状態付与・解除・時間前後移動・詠唱キャンセル・他者蘇生・罠を扱う。反射・反撃・追撃・自己蘇生はStatusSpecで定義する。効果なしの行動は空のeffects配列を使う。

スキルのtargetは必須対象の適格性を定める。selectedは確定時の単体ID、all-allies/all-enemiesは発動直前に固定した集合、selfは行動者。各Effect直前に適格性を再検証するが集合は再選択しない。攻撃付随効果はattached内に置き、hit-recipient（かばう後の被弾者）にのみ束縛する。エンジンは後退、キャンセル、状態付与、解除の順に処理し、同分類は配列順を保つ。

スキルはactorSnapshotとtargetSnapshotをbefore-activationに固定する。攻撃・回復の対象能力はbefore-effect。背水威力も発動直前の行動者スナップショットから選ぶ。罠はon-triggerで設置者の能力を取得し、反撃・追撃は独立した発動直前スナップショットを使用する（AttackPayloadのbefore-activationはその反応の発動直前を意味する）。反射は記録したHP損失から計算する。

時間停止はActionStateと独立する。Timerはrunningの絶対時刻とfrozenの残りTUを判別し、CD・詠唱・ブレイク・状態期限・毒・罠に共通利用する。停止自身の期限はtimeStopUntilで全体時刻を使う。同系統の再付与で保持する付与者・強度・連番・回数と、更新する期限を分離する。actingは処理中の後退をpendingKnockbackに蓄積する。

## 実行時検証

`validateGameContent(unknown)` はパスと理由の配列を返す。`parseGameContent(unknown)` は不正データなら例外、成功時は外部からの変更を避けるためコピーしたGameContentを返す。余分なキーも拒否する。検証は構造・数値・ID、重複、参照、前提循環、所有ジョブ・ルート、置換/CD、対象束縛、参照時点、蘇生制限、フェーズ閾値、遺物報酬、階層内双方向接続を対象とする。

バリア・継続回復・自傷・ゲージ回復、2体以上の敵、複数ヒット、複数攻撃Effectによる迂回、トップレベルのhit-recipientを拒否する。複数ヒット制限は基本行動の攻撃に適用し、状態による反撃・追撃は別途許可する。

部分カタログをテストや段階的なコンテンツ投入に使えるよう、3人・8職・10階層・全48ノードの件数はここでは強制しない。参照先は部分カタログにも必要。全編コンテンツの網羅性・攻略可能性、所持数や習得予算などの現在編成整合性は後続のコンテンツ・編成検証で確認する。PresentationCatalogは名前・説明・テーマ・ヒント・エンディング本文だけを持ち、ロジックのコンテンツに表示文言を埋め込まない。

## 3.2での拡張

BattleParticipantのActionStateへ、終了済みで行動予定を持たない`finished`を追加した。EnemyDefinitionの`immuneElements`は省略時空配列として扱い、属性無効の境界例を検証するために使用する。通常攻撃・待機の固定定義、現行敵のCD0・固定属性、弱点・耐性・無効の排他性も読み込み時に検証する。エンジンのAPIは [バトルエンジン](./battle-engine.md) を参照。

## 3.5での拡張

全編進行ID・固定報酬の`CampaignMetadata`、プレイ可能範囲の`ReleaseScope`、正式収録の`GameRelease`を追加した。部分カタログ検証は維持し、正式カタログと表示の検証を別の入口にした。`parseGameContent`の第2引数に全編メタデータを渡すと、未収録の解放先・入手元を検証できる。詳細は[リリースカタログ](release-catalog.md)を参照。
