# 保存進行の移行・復旧候補

入口は`src/game/progression`、実装は`recovery.ts`。通常の`validateProgression`や移動APIの拒否規則を維持し、保存層へ明示確定前の候補だけを返す。IndexedDB・時計・乱数・版選択・設定修復は扱わない。

## APIと結果

| API | 用途 |
| --- | --- |
| `migrateProgression(campaign, input, migration?)` | 明示ID移行だけを行って通常検証する。重複・位置・結末は修復しない |
| `previewProgressionRecovery(release, input, migration?)` | 明示ID移行後、許可された修復を候補化して再検証・収録確認する |

入力は未知のJSON。現行進行の項目・配列・文字列・boolean・位置の構造を検証するが、ID形式は移行後に検証する。そのため旧IDが現行の正規表現に合わなくても対応表を適用できる。項目欠落・型違い・未知項目・位置構造破損では`ok: false`と構造問題を返し、候補を生成しない。古い保存包の構造変更や旧導出値の除去は、4章のschema移行でこの入力形へ変換してから渡す。

構造を読み取れる場合は`ok: true`と次の`ProgressionRecovery`を返す。**okは候補を生成できたことを表し、適用可能とは限らない。**

| フィールド | 内容 |
| --- | --- |
| `original` | 未移行・未修復の原本コピー |
| `progression` | 移行／修復候補。停止理由がある場合は不正IDも保持する |
| `changes` | 変更順に並ぶpath・before・after・理由コード。集合や位置を丸ごとコピーする |
| `issues` | 未解決の停止理由。unknown-defeatまたはinvalid-progressionのコードと問題箇所・説明 |
| `canApply` | 通常の進行検証を通過した候補か。保存成功・ユーザー確定ではない |
| `derived` | 適用可能な場合だけ、共通APIから導出した予算・所持数・解放・クリア。停止時はnull |
| `unavailableLocation` | 正当だがこの版で未収録の復帰先階層。該当しなければnull |
| `canResume` | 復旧APIでの再開可否。移行APIは収録範囲を受け取らないため未確認のnull |

すべてのコピーは元データと独立する。changesのbefore／after、original、progressionも互いに編集が波及しない。

## 移行と修復の順序

`ProgressionIdMigration`は敵IDの`enemies`、階層IDの`floors`、探索ノードIDの`nodes`の対応表。版に応じた表の選択は保存層が担当する。表自身に明示されたキーだけを一段変換し、継承プロパティや対応先の再変換を使わない。階層の移行でノード接頭辞を推測して書き換えず、ノードも明示表を使う。

復旧APIは次の順で処理する。

1. 構造検証と明示ID移行。
2. 討伐・訪問集合の重複除去。移行で複数IDが同じ現在IDになった場合も正規化する。
3. 討伐集合だけを通常検証する。未知ID・ボス順序の穴・未解放階層の討伐では後続の意味修復を停止し、導出値を返さない。
4. 正当な討伐から解放・クリアを導出し、未知／未解放の訪問IDを除去する。クリア前のendingHandledをfalseへ戻す。
5. 所属不一致・未知ノード・未解放階層・生存敵の部屋などの不正な復帰先をguildへ戻す。
6. 候補全体を通常検証し、適用可能なら報酬等を共通APIで導出して収録確認する。

差分理由はid-migration、duplicate、invalid-visit、invalid-location、ending-before-clear。未知討伐を捨てたり、進行の穴を埋めるためにボス討伐・ポイント・遺物を追加したりしない。停止時でも原本と候補と差分を保持し、previous復元・書き出し・新規開始の判断へ渡す。

既知の未収録階層の正当な討伐・訪問・復帰先は保持する。例えばMVPでfloor-02の正当な復帰先を読む場合、canApplyはtrue、canResumeはfalse、unavailableLocationはfloor-02となる。自動的にguildへ移動したり進行を消したりせず、保存層・UIが収録版への切替などを案内する。対応する収録版では同じ候補で再開できる。

## 編成復旧と保存への接続

canApplyがtrueの場合だけ、候補のdefeatedEnemyIdsから`FormationContext`を作り、3.8の`previewCurrentPartyRecovery`へ渡す。予算・所持数は同じ討伐集合に基づく。編成側の残存問題も確認し、進行・編成候補を合わせて差分表示・明示確定・所有権／revision照合・原子的保存を行う。この保存処理とschema／content版の対応表選択は4章の担当。

日本語名のテストで旧形式ID、移行由来の重複、対応なしの討伐ID、進行の穴、不正復帰先・訪問・結末、構造破損、既知未収録の保持、最終クリア、継承キー・連鎖移行の拒否、候補の再検証・非変更・再修復の安定性、編成復旧・戦闘開始との接続を固定する。
