# zaiko01 — 中古車 買取在庫管理

Cloudflare Workers（静的アセット）+ D1 で動く、個人用の買取在庫管理サイトです。

## 機能
- 買取登録・編集・削除（車名、車台番号、色、カラーコード、走行距離（km／マイル、マイルはkm換算も表示）、セールスポイント、保証書・取扱説明書の有無、買取日、買取価格、仕入先、保管場所、販売予定価格、メモ）
- 列の追加は Worker が自動で行う（`src/lib.js` の `ADDED_COLUMNS`）。D1 コンソールでの作業は不要
- ステータス管理：在庫 → 出品中 → 売却済（販売日・販売価格・手数料を入れると利益を自動計算）
- 検索、ステータス別の絞り込み、並び替え、在庫の経過日数表示
- 集計：在庫件数、在庫の買取総額、今月の買取・売上・利益
- CSV出力（Excelで文字化けしないBOM付き）

## 構成
```
public/            画面 (HTML/CSS/JS、ビルド不要)
src/worker.js      Worker 本体。/api/* を処理し、それ以外は public/ を返す
src/api/items.js   GET 一覧・検索 / POST 登録
src/api/item.js    GET / PUT・PATCH 更新 / DELETE
src/api/stats.js   GET 集計
src/lib.js         入力チェックなど共通処理
migrations/        D1 のテーブル定義
wrangler.toml      Worker と D1 の設定（database_id を自分の D1 の ID にする）
```

## Cloudflare への公開手順（初回のみ）

### 1. D1 データベースを作る
Cloudflare ダッシュボード → **ストレージとデータベース → D1** →「データベースを作成」
- 名前：`zaiko01-db`
- 作成後、**Console** タブで `migrations/0001_init.sql` の CREATE 文を**1行ずつ**貼り付けて Execute（コンソールは改行がつながるため）

（または PC で `npx wrangler d1 create zaiko01-db` → `npm run db:migrate:remote`）

### 2. wrangler.toml に D1 の ID を書く
D1 の「概要」に表示されるデータベース ID を `wrangler.toml` の `database_id` に設定します。

### 3. Worker を作る
ダッシュボード → **Workers & Pages → 作成 → GitHub からインポート** → `zaiko01` を選択（ビルド設定は既定のまま、デプロイコマンド `npx wrangler deploy`）。
push するたびに自動でデプロイされます。

### 4. 自分だけがアクセスできるようにする（重要）
Worker の **Access** タブ → Cloudflare Access を有効化し、ポリシーで自分のメールアドレスだけを許可します。

## ローカルで動かす
```bash
npm install
npm run db:migrate:local
npm run dev     # http://localhost:8787
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
