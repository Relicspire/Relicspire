# 3.5 リリース範囲と全編メタデータ

入口は`src/game/data/release.ts`。`GameRelease`は`contentVersion`、`campaign`、`scope`、`content`、`presentation`を分離して持つ。`parseGameRelease(unknown)`は構造・全編メタデータ・正式収録・表示を検証し、入力から独立したコピーを返す。不正データはパス付き例外となる。`validateGameRelease`は同じ問題一覧を返し、入力を変更しない。

## 全編メタデータと収録範囲

`CampaignMetadata`は全10階層、60敵の所属と固定報酬、50遺物の所属・入手元・所持上限を保持する。能力値・行動列・装備性能・表示文言は含めない。`createCampaignMetadata()`で現行仕様の正規ID・固定報酬を生成できる。`validateCampaignMetadata`／`parseCampaignMetadata`は未知JSONを検証し、欠落・重複・所属違い・誤報酬・誤った入手元・未知キーを拒否する。

ボス01〜09は各人1ポイントと次階層解放、ボス10は追加ポイントなし・解放なし・最終クリア、各守護者は対応遺物1個だけを報酬とする。配列の並び順を変えてもIDで照合する。

`ReleaseScope.playableFloorIds`は第1階層から連続して実装済みの階層を指定する。MVPは`['floor-01']`、フル版は全10階層。途中の収録穴・重複・未知IDを拒否する。収録範囲は解放済み階層とは別であり、討伐集合からの解放導出は3.6で実装する。

`getContentAvailability(campaign, scope, id)`は階層または敵について`unknown`、`unavailable`（既知・未収録）、`playable`を返す。この照会だけで移動を確定せず、3.6の移動APIで解放・隣接・遭遇条件と合わせて使用する。

MVPでもfloor-02への解放報酬と全編IDを保持する。フル版では同じメタデータを使い、実戦データの追加と`contentVersion`の更新を行う。敵の能力値や未収録階層の探索データを仮置きして参照を埋める必要はない。

## 部分カタログと正式コンテンツ

既存の`validateGameContent`／`parseGameContent`は部分カタログを許可する入口として残す。省略可能な第2引数に`campaign`を渡した場合だけ、報酬の解放先・遺物の入手元を全編IDへ参照でき、収録敵の報酬を全編メタデータと照合する。スキル・キャラクター・ノードなどの実戦参照は引き続き収録コンテンツ内に必要。

`validateReleasedContent(content, campaign, scope)`は正式収録専用。3人・8ジョブ48ノードと所定の前提、初期装備6種類、収録階層の全6遭遇と5遺物、敵の能力・行動列・報酬参照、初期編成の予算・所持数を確認する。収録範囲外の階層・敵・遺物・敵スキルも拒否する。

各収録階層は入口・分岐3・守護者部屋5・ボス部屋を持ち、入口から全室へ到達できることを確認する。entry→hall-1→hall-2→hall-3→bossの主経路、指定親分岐だけへ接続する守護者部屋、部屋ごとの対応敵を検証する。フル版ではこの検証によって60遭遇・50遺物の網羅性も確認する。攻略可能性や正式性能のバランスは後続タスクで検証する。

## 表示カタログ

`ReleasePresentation`は既存の`PresentationCatalog`を拡張し、`elements`・`statuses`・`targets`の辞書を必須にする。全属性、現行16状態系統、全対象規則へ空でない表示名を要求する。

`validatePresentationCatalog`／`parsePresentationCatalog`には検証済みの実戦データ・全編メタデータ・収録範囲を渡す。収録IDと通常攻撃・待機の名称・説明、収録階層のテーマ・入口文・1件以上のヒントを要求する。既知の未収録階層・敵・遺物の表示項目は任意で保持できるが、未知IDは拒否する。floor-10収録時には結末本文が必須。MVPでは結末本文が空でもよい。

## 戦闘への接続

```ts
import { parseGameRelease } from '../src/game/data/release';
import { createBattle } from '../src/game/battle';

const release = parseGameRelease(rawRelease);
const session = createBattle(
  release.content,
  {
    party,
    enemyId: 'boss-01',
    context: { defeatedEnemyIds, inBattle: false },
    campaign: release.campaign,
  },
  committedProgress,
);
```

`BattleSetup.campaign`で正式リリースの全編参照を戦闘開始検証へ渡す。従来の部分カタログfixtureは省略できる。未収録の敵は実戦定義がないため戦闘開始できない。保存・探索・画面の確定処理、正式48スキルや第1階層の戦闘性能・文言の投入は3.6以降・5.5・6で行う。

## 検証

`src/game/data/release.test.ts`で合成MVPとフル版を生成する。全編IDの維持、部分検証との区別、MVP戦闘開始、版・構造・メタデータ不整合、収録欠落、探索経路・配置、表示不足、最終階層の結末必須、解析結果の独立性を固定する。合成の能力値・文言はテスト専用であり、正式コンテンツとして配信しない。
