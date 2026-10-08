# Relicspire

タイムラインバトルと自由なリビルドで強敵に挑む思考型ダンジョンRPGです。
3人パーティと8職のスキルツリー、固定性能の遺物を組み合わせ、神の試練を攻略します。

## 開発

Node.js 24（`.nvmrc` のバージョン）とnpmを使用します。

```sh
npm ci
npm run dev
```

表示されたURLの `/Relicspire/` を開きます（通常は `http://localhost:5173/Relicspire/`）。現在は起動確認用の画面を表示します。

## 品質チェック・ビルド

```sh
npm run check
```

型チェック、Lint、整形確認、テスト、本番ビルドを順に実行します。個別実行も可能です。

| コマンド               | 用途                                      |
| ---------------------- | ----------------------------------------- |
| `npm run typecheck`    | TypeScript strictでアプリ・Vite設定を検証 |
| `npm run lint`         | ESLint（警告も失敗扱い）                  |
| `npm run format:check` | Prettierの整形確認                        |
| `npm run format`       | 自動整形                                  |
| `npm test`             | Vitestを1回実行                           |
| `npm run test:watch`   | テスト監視                                |
| `npm run build`        | 型チェック後、`dist/` へ本番ビルド        |
| `npm run preview`      | ビルド済みアプリのローカル表示            |

テストはhappy-dom上で実行し、React Testing Libraryとfake-indexeddbをセットアップ済みです。起動表示とidb-keyvalの保存・読込をスモークテストします。`@/` は `src/` を指し、Vite・TypeScript・Vitestで共有します。

## ソース構成

| ディレクトリ     | 責務                                |
| ---------------- | ----------------------------------- |
| `src/app`        | 起動・アプリ全体・共通CSS           |
| `src/components` | 共通React UI                        |
| `src/features`   | 拠点・探索・戦闘などの機能UI        |
| `src/game`       | 副作用のないゲームロジック          |
| `src/content`    | ジョブ・スキル・敵・階層データ      |
| `src/store`      | Zustand状態管理                     |
| `src/storage`    | IndexedDB・保存・移行               |
| `src/rendering`  | Reactの再描画から分離したPixiJS描画 |
| `src/assets`     | ビルド対象の画像・音声              |
| `src/test`       | テスト共通セットアップ              |

Zustand・PixiJS・idb-keyvalは導入済みです。ゲーム状態・永続化・描画の実装は後続タスクで進めます。PWAとオフライン配信はタスク8の対象です。

## GitHub Pages

Viteの `base` は `/Relicspire/` です。単一の `index.html` でSPAを起動し、画面遷移はアプリ内部の状態で扱います。後でURLと同期する場合はハッシュ方式（`/Relicspire/#/...`）を使い、サーバー側の履歴フォールバックを必要とするパス方式は使いません。アセットはimport、または `import.meta.env.BASE_URL` を用いて参照します。

`.github/workflows/deploy.yml` はPRとmainへのpushで依存関係をキャッシュし、`npm ci`、型チェック、Lint、整形確認、テスト、ビルドを実行します。mainで全チェックに成功した場合だけGitHub Pagesへデプロイします。デプロイは同時実行しません。

リポジトリの **Settings → Pages → Source** を **GitHub Actions** に設定してください。想定公開URLは `https://relicspire.github.io/Relicspire/` です。リポジトリ名やカスタムドメインを変更する場合はViteの `base` も変更します。

設定の参考: [ViteのGitHub Pages配信](https://vite.dev/guide/static-deploy.html#github-pages)、[Tailwind CSSのVite導入](https://tailwindcss.com/docs/installation/using-vite)。

仕様と進捗は [docs/tasks.md](docs/tasks.md) を参照してください。
