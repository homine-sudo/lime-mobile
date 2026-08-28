# freee固定資産 簿価スナップショット セットアップ（freee_assets.gs）

LIME Fleet に車両ごとの **帳簿価額（簿価）** と **当期償却額** を表示し、
「相場 − 簿価 = 会計上の売却損益」を見られるようにする仕組み。

- 元ネタ: 2026-08-28 リリースの freee固定資産API（`/hub/fixed_asset_management/fixed_assets`）
- 会計側の固定資産台帳API（`/api/1/fixed_assets`・エンタープライズ限定）も自動で試す
- 出力先: Dropbox `/ライム共有DB/システムデータ車両/fixed_assets.json`（毎朝自動更新）
- 読む側: LIMEFleet.html（車両詳細の「財務」と「市場価格」カード）

## 前提

- GASプロジェクト: **freee連携**（既存・稼働中。壊さないこと）
- 同プロジェクトに `dbx_bridge.gs` が入っていること（Dropbox認証を共用する）

## 手順（約5分）

1. script.google.com → freee連携 → ＋ファイル → `freee_assets` → `freee_assets.gs` の中身を貼る → 保存
2. ファイル冒頭の `FFA_TOKEN_FUNC` に、このプロジェクトで**既に使っている freeeアクセストークン取得関数の名前**を設定
   - わからなければ空のままでOK（よくある名前から自動検出を試みる）
3. 関数 `ffa_testLog` を実行 → ログを確認
   - `採用: hub` か `採用: kaikei` が出て資産件数が見えれば成功
   - **401 が出る場合**: freeeの[アプリ管理](https://app.secure.freee.co.jp/developers/applications) → 対象アプリ → 権限設定 で
     「固定資産（読み取り）」にチェック → 保存 → **再認可**が必要
   - **404 / 両方ダメな場合**: freee固定資産（別プロダクト）未契約かつ会計がエンタープライズ以外。
     現状はAPIで簿価を取れない契約なので、このセットアップは保留でよい
4. `ffa_snapshotToDropbox` を実行 → ログに ✅ が出たら `ffa_setupDailyTrigger` を実行（毎朝6:10自動更新）

## 動作確認

- Dropbox `/ライム共有DB/システムデータ車両/fixed_assets.json` ができている
- LIME Fleet を再読込 → 設定タブ「データ状態」に `freee固定資産` の行が ✅ になる
- 車両詳細の「💴 財務」に `freee簿価（帳簿価額）` が出る（資産名にナンバー4桁 or 車名が入っていれば自動マッチ）

## トラブルシュート

| 症状 | 原因と対処 |
|---|---|
| ログに「freeeトークン取得関数が見つかりません」 | `FFA_TOKEN_FUNC` に既存関数名を手で設定する |
| 資産は取れたが LIME Fleet で「マッチなし」 | freee側の資産名に車両ナンバー下4桁か車名を入れる（例: `車両運搬具 ムーヴ 1001`） |
| 簿価が「項目不明」と出る | `ffa_testLog` の「1件目のキー」をClaude に見せてLIMEFleet側のキー候補を追加してもらう |

## 備考

- freee側の既存関数・プロパティには一切触れない（このファイルのキーは `FFA_` 接頭辞）
- 固定資産データに個人情報は含まれないため、スナップショットは raw のまま書き出す
