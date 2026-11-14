# zaiko01 — 中古車 買取在庫管理（Claude 向けの引き継ぎメモ）

**最初に `docs/HANDOVER.md` を読むこと**（これまでのやり取り・決まりごと・未完了の作業のまとめ）。

利用者は日本語話者。返答・画面の文言・コミットメッセージは日本語で書く。
利用者はエンジニアではないので、操作手順は画面の名前とボタン名で具体的に説明する。

## 構成
- Cloudflare Workers（静的アセット）＋ D1（SQLite）＋ Workers AI。GitHub の main に push すると Workers Builds が自動デプロイ
- `src/worker.js` … ルーティングとログイン確認（`run_worker_first = true` で全リクエストを通す）
- `src/auth.js` … ID・パスワードのログイン。シークレット `LOGIN_ID` / `LOGIN_PASSWORD`(6文字以上) / `SESSION_SECRET`(32文字以上)
- `src/lib.js` … 入力チェック、`ensureSchema`（列の自動追加・テーブル自動作成。D1 コンソールでの作業は不要）
- `src/api/items.js`, `item.js` … 在庫の一覧・登録・更新・削除
- `src/api/import.js` … 在庫CSV取り込み（車台番号が同じ車両は上書きしない。予定価格・グレードだけ上書き可）
- `src/api/market.js` … AA結果（オークション結果）の取り込み・一覧・相場表示。`/api/market-replace`（全部消して入れ直す）・`/api/market-summary`（件数確認）は Claude 用
- `src/api/backup.js` … 全データのバックアップ（JSON）と、空のサイトへの復元
- `src/api/ocr_plate.js` … コーションプレート写真から車台番号・カラーコード読み取り（Workers AI）
- `public/` … 画面（ビルド不要の素の HTML/CSS/JS）。`index.html`=在庫一覧、`aa.html`=AA結果、`upload.html`=アップロード

## 決まりごと
- 予定価格 `list_price` は税抜で保存し、表示・入力は税込（×1.1）
- 陸送会社：シンセイ①〜④・タカラ・自社。会場：名古屋（金曜開催）・静岡（土曜開催）・廃車
- 表は1段表示のみ。No.・初度登録・車名は横スクロールで固定
- 相場の金額（応札額）は千円単位として扱う
- データは消さない方針：画面から外した列（保証書・取説・セールスポイント等）もDBには残している

## Claude から相場データを入れ替える
- 本番の Worker のシークレット `API_TOKEN`（32文字以上）と同じ値を、クラウド環境のネットワーク秘密情報（ホスト `zaiko01.oowa-matsushita.workers.dev`）に登録してある前提。トークンで使えるのは `/api/market-*` だけ（在庫・バックアップ・復元は不可）
- 社内システムの契約書CSV（Shift-JIS）は顧客名が「USS静岡」→静岡、「ジェイボーイ」「USS名古屋」→名古屋 の行だけを相場に使う。日付＝開催日、伝票No＝出品番号、車輛本体価格÷1000＝応札額（千円）、初度＝年式（H28/10 形式）、型式は先頭の「DBA-」等を外す。結果はすべて「落札」。顧客名は相場に入れない
- AA結果形式の CSV に変換したら `node scripts/market-upload.mjs <CSV>` で確認、`--apply` で入れ替え。先に利用者へ件数を見せて了承を得る

## ローカル確認
`.dev.vars` に3つのシークレットを書き、`[ai]` を外した設定で `npx wrangler dev` を動かして Playwright で画面確認している
（Workers AI はローカルでは動かないため）。
