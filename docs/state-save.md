# 状態管理・セーブ実装

## 保存経路

`src/state/game.ts` の `createGameState` は進行、編成、探索表示、戦闘の4つのZustand Storeと保存状態Storeを作る。永続化専用Storeのpersistが `src/storage/save.ts` の保存管理器へ書き込み、トランザクション完了後にだけ確定値を4つのStoreへ配布する。画面は読み取り専用で利用し、更新は管理器の操作APIを通す。

保存キーは `relicspire-save`。包のcurrentはsaveId、revision、schemaVersion、contentVersion、updatedAt、dataを持ち、previousには直前currentを保持する。dataは編成・プリセット・進行・設定のみ。所持品、予算、階層解放、クリアは討伐集合から導出し、戦闘中HPやタイムラインは保存しない。非同期書込は直列化し、同一readwriteトランザクションで原本全体（saveId・revisionを含む）と配信キー `relicspire-delivery` のbuildIdを照合する。

初回保存前の配信キー確定は後続の配信処理が担当する。保存層が起動時に配信版を上書きすることはない。未確定の配信キーでは書込を拒否する。

## 起動時の接続

`src/app/runtime.ts` と `main.tsx` が以下の起動経路を実装する。正式な `src/content/release.json` とタスク8の配信準備がない場合は準備待ちを表示し、合成テストデータをゲームとして起動しない。詳細は[共通UI](./common-ui.md)を参照。

1. `SaveOwnership.acquire()` でWeb Locks所有権取得を試みる。
2. `new SaveRepository(buildId, () => ownership.owned)` を作る。
3. `createGameState(release, repository, () => ownership.owned)` を作り、`load()` を待つ。
4. `<App game={game} recheck={...} />` に接続する。再確認は所有権再取得後に `load()` を呼ぶ。必ず古い戦闘と未保存候補を破棄して最新値を読む。
5. 所有権を解放する場合は戦闘処理を停止し、`release()` 後に `load()` して読取専用へ移す。

`SavePanel` は初回開始、保存中、再試行、破損・移行の差分確認、previous復元確認、新規開始確認、未保存勝利の放棄確認、JSON書出し、読取専用の再確認を表示する。正式な探索・編成・戦闘画面への操作接続はタスク5で行う。

## 操作境界

- 通常編集は純粋ロジックで作ったSaveData候補を `update()` へ渡す。保存失敗は確定値を保ち、同じ候補を `retry()` で再試行する。
- `startBattle()` は遭遇と編成を検証し、保存成功後だけ時刻0の戦闘を生成する。
- `leaveBattle()` は保存原本を再照合し、戦闘前の編成と進行へ戻す。確定した現在設定を維持する。
- `victory()` は戦闘結果を確認し、討伐集合を更新した候補を保存する。成功時に戦闘を終了する。失敗中のupdateは禁止する。cancelはDBを再確認し、実際に保存済みなら勝利を確定する。
- schema0から1への移行は現在と同じ正規データ構造を持つ旧包に限定する。未知の旧内容版は解釈せず停止する。未来版は新規開始・previous復元を含む書込を拒否する。
- 現編成・進行は既存の復旧APIで差分候補を作り、プレイヤーの確定を待つ。無効な旧プリセット編成は削除せず保持する。

## 検証と残作業

fake-indexeddbによる保存・再読込、競合、配信版照合、容量不足、schema移行、current破損・previous復元、未来版拒否、所有権喪失、設定修復、成否不明エラー、S01・S02・S03・S06・S07・S11・S12の保存境界を自動テストする。既存の進行・編成復旧テストと併せて用いる。

残作業は [開発タスク](./tasks.md) の次の箇所で管理する。

- タスク4: S01～S12の保存層の自動テストと既存テストの対応付けは完了（下表）。
- 5.1: 起動基盤・復旧UI・Web Locks・読取専用画面・所有権喪失時停止の接続と自動テストは完了。
- 8.2: 5.5の正式データ制作と8.1の配信準備後、製品起動と検証済み配信状態の開始条件への接続を確認する（5.1から移動）。
- 5.3～5.4: 探索・戦闘画面の保存境界と遷移への接続。
- 5.5: 第1階層でのS01～S08・S11～S12の統合検証。
- 6.2: 最終勝利・エンディングに関するS09～S10の統合検証。
- 7.2: S01～S12、実複数タブ、所有権喪失時の実画面停止、終了・再起動からの復帰の実ブラウザE2E検証。

タスク4の完了は保存層の自動テストで判定し、画面接続・実ブラウザ検証は各後続タスクの完了条件に含める。


## 保存・復旧仕様と自動テストの対応

| 仕様 | 保存層の検証 | 関連する既存ロジックテスト |
| --- | --- | --- |
| S01 | `game.test.ts`: 戦闘前保存失敗・同候補再試行後の開始 | `progression.test.ts`: 遭遇検証 |
| S02 | `save-contracts.test.ts`: 遭遇確認・戦闘・敗北から別Storeを生成し再読込、親分岐・未討伐・新しい戦闘初期状態を復元 | `engine.test.ts`: 戦闘初期化・再試行 |
| S03 | `game.test.ts`: ボス報酬保存の再試行で予算4・floor-02解放、討伐1件 | `progression.test.ts`: 勝利候補・報酬導出 |
| S04 | `save-contracts.test.ts`: 守護者勝利後の再読込で遺物1個・討伐部屋 | `progression.test.ts`: 守護者報酬・非再出現 |
| S05 | `save-contracts.test.ts`: 未保存／実際に確定済みのエラーから別Storeで再読込 | `game.test.ts`: 書込後の成否不明エラーの照合 |
| S06 | `save-contracts.test.ts`: 非所有Storeの変更拒否・古い戦闘結果の競合・戦闘停止 | `game.test.ts`: 直列化と競合・所有権喪失 |
| S07 | `game.test.ts`: 未来版のロード・復元・新規開始拒否、原本書出し | `progression/recovery.test.ts`: 未知ID・進行不整合の拒否 |
| S08 | `save-contracts.test.ts`: 確認前の原本保持・現編成全解除・旧プリセット保持と呼出拒否 | `party/recovery.test.ts`: 個人予算超過・他人不変・プリセット修復拒否 |
| S09 | `save-contracts.test.ts`: 最終勝利後の再読込でクリア・guild・endingHandled=false、報酬再付与拒否 | `progression.test.ts`: 最終報酬・終了状態 |
| S10 | `save-contracts.test.ts`: スキップ保存失敗後の再試行／取消、討伐と復帰先維持 | `progression/recovery.test.ts`: 結末フラグの復旧 |
| S11 | `game.test.ts`: 新規開始の容量不足で旧包不変、同候補再試行 | `game.test.ts`: 初回開始・新saveId |
| S12 | `save-contracts.test.ts`: 戦闘中の設定保存後の同編成リトライで最新設定・revision保持 | `game.test.ts`: 逃走時も最新設定保持 |

保存層テストではfake-indexeddb上のセーブを別のStoreへ読み直して再起動を模擬する。勝利・敗北は終了結果を注入し、勝敗判定自体は戦闘エンジンのテストが担当する。Web Locks APIの実排他、画面操作、ブラウザ終了そのものは7.2のE2E対象のままとする。
