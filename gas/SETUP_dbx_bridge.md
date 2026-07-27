# dbx_bridge 導入手順（ローカルPCのClaude Code用）

> 目的: Dropboxの車両データ(data.json)を毎朝Googleドライブに書き出し、
> クラウドのClaudeが走行距離・リース料等を読めるようにする。
> 成果物: Drive「システム一時保管」に `車両スナップショット.json`（車両マスタのみ・顧客情報なし）
> 作成: 2026-07-27 クラウドセッション（詳細な背景はDrive「システム一時保管」の各分析ファイル参照）

## 対象GASプロジェクト

- 名前: **freee連携**（既存・稼働中。壊さないこと）
- scriptId: `1S59EOgcTy08ZExcIMJqzvafntQpTAriicClozk7d5Vob-FN_hsIpJzjn`
- 追加するファイル: このフォルダの `dbx_bridge.gs`（既存ファイルには一切触れない）

## 手順A: clasp で自動導入（推奨・Claude Codeが実行）

```bash
npm i -g @google/clasp
clasp login                        # ← ユーザーがブラウザで1回「許可」
mkdir gas-work && cd gas-work
clasp clone 1S59EOgcTy08ZExcIMJqzvafntQpTAriicClozk7d5Vob-FN_hsIpJzjn
# 既存ファイルがローカルに落ちてくる。dbx_bridge.js として追加:
cp ../gas/dbx_bridge.gs ./dbx_bridge.js
clasp push                         # ← 既存ファイル構成は維持されるが、push前に status で差分確認すること
```

⚠️ `clasp push` は**プロジェクト全体を上書き**する。`clasp clone` 直後に追加だけして push すること
（cloneとpushの間に他所でGASを編集しない）。不安なら手順Bへ。

## 手順B: 手動貼り付け（フォールバック）

1. script.google.com → freee連携 → ＋ファイル → `dbx_bridge` → `dbx_bridge.gs` の中身を貼る → 保存

## 共通: 認可と初回実行（ここはユーザーの承認が必要）

1. GASエディタで関数 `dbx_getAuthUrl` を実行 → ログのURLをブラウザで開き「許可」→ コードをコピー
2. `dbx_setAuthCode` の `AUTH_CODE` にコードを貼って実行 →「✅ Dropbox連携完了」
3. `dbx_snapshotToDrive` を実行（初回はGoogleのDrive権限承認が出る）
   → ログ「✅ 車両スナップショット.json 更新: 車両77台…」を確認
4. `dbx_setupDailyTrigger` を実行（毎朝6時の自動更新）

## 検証

- Googleドライブ「システム一時保管」に `車両スナップショット.json` ができている
- 中身に `vehicles[].mileage` / `mileageFromCases` が入っている
  （マスタ未入力車は mileage=0 のことがある → mileageFromCases が実質値）

## 完了したら

クラウドセッションに「できた」と伝える → フィット3844の売却見積もり確定と
全77台の残価率再計算（簿外資産の車両含み益 更新）をクラウド側が実施する。
