# zaiko01 — 買取在庫管理

Cloudflare Pages + Pages Functions + D1 で動く、個人用の買取在庫管理サイトです。

## 機能
- 買取登録・編集・削除（品名、型番・JAN、カテゴリ、状態ランク、数量、買取日、買取価格、仕入先、保管場所、販売予定価格、メモ）
- ステータス管理：在庫 → 出品中 → 売却済（販売日・販売価格・手数料を入れると利益を自動計算）
- 検索、ステータス別の絞り込み、並び替え、在庫の経過日数表示
- 集計：在庫件数、在庫の買取総額、今月の買取・売上・利益
- CSV出力（Excelで文字化けしないBOM付き）

## 構成
```
public/            画面 (HTML/CSS/JS、ビルド不要)
functions/api/     API (Pages Functions)
  items/index.js   GET 一覧・検索 / POST 登録
  items/[id].js    GET / PUT・PATCH 更新 / DELETE
  stats.js         GET 集計
  _middleware.js   エラー処理・APIトークン認証
lib/items.js       入力チェックなど共通処理
migrations/        D1 のテーブル定義
```

## Cloudflare への公開手順（初回のみ）

### 1. D1 データベースを作る
Cloudflare ダッシュボード → **ストレージとデータベース → D1** →「データベースを作成」
- 名前：`zaiko01-db`
- 作成後、**Console** タブで `migrations/0001_init.sql` の CREATE 文を**1行ずつ**貼り付けて Execute（コンソールは改行がつながるため）

（または PC で `npx wrangler d1 create zaiko01-db` → `npm run db:migrate:remote`）

### 2. Pages プロジェクトを作る
ダッシュボード → **Workers & Pages → 作成 → Pages → Git に接続** → `zaiko01` リポジトリを選択
- フレームワーク：なし
- ビルドコマンド：空欄
- ビルド出力ディレクトリ：`public`

### 3. D1 をひも付ける
作成した Pages プロジェクト → **設定 → バインディング → 追加 → D1 データベース**
- 変数名：`DB`
- データベース：`zaiko01-db`

設定後、**デプロイメント**から「再試行（再デプロイ）」すると反映されます。

### 4. 自分だけがアクセスできるようにする（重要）
Pages プロジェクト → **設定 → 一般 → アクセスポリシー（Cloudflare Access）を有効化**
- ポリシーで自分のメールアドレスだけを許可
- `*.pages.dev` のプレビュー URL も含めて保護されます

## ローカルで動かす
```bash
npm install
npm run db:migrate:local
npm run dev     # http://localhost:8788
```

## API（Claude などからの連携用）
| メソッド | パス | 内容 |
|---|---|---|
| GET | `/api/items?q=&status=&from=&to=&sort=` | 一覧・検索（status: in_stock / listed / sold） |
| POST | `/api/items` | 登録（`name` 必須） |
| GET | `/api/items/:id` | 1件取得 |
| PATCH | `/api/items/:id` | 指定項目だけ更新 |
| DELETE | `/api/items/:id` | 削除 |
| GET | `/api/stats` | 集計 |

外部から使う場合は、Pages の環境変数に `API_TOKEN` を設定し、`Authorization: Bearer <API_TOKEN>` を付けて呼び出します（Access を使う場合はサービストークンの設定も必要）。
