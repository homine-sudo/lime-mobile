/* ============================================================
 * dbx_bridge.gs — Dropbox→Drive 車両スナップショット (2026-07-25)
 *   「freee連携」GASプロジェクトに新規ファイルとして追加する。
 *
 * 【目的】
 *   クラウドのClaudeはDropboxを読めないため、GASが代わりに
 *   レンタカー data.json から車両マスタを抽出し、Googleドライブの
 *   「システム一時保管」に 車両スナップショット.json を書き出す。
 *   → 走行距離・リース料・売却済み等をClaudeがいつでも参照可能に。
 *
 * 【個人情報保護】
 *   案件(cases)の顧客名・連絡先・保険会社等は一切含めない。
 *   使うのは 車両マスタ + 案件の返却メーター(車両IDキーの数値のみ)。
 *
 * 【セットアップ 5手順・約5分】
 *   1. GASエディタ「＋ファイル」→ dbx_bridge → 本文を丸ごと貼る
 *   2. 関数 dbx_getAuthUrl を実行 → ログのURLをブラウザで開き「許可」
 *      → 画面に出たコードをコピー
 *   3. dbx_setAuthCode の AUTH_CODE にコードを貼って実行
 *   4. dbx_snapshotToDrive を実行 (初回はDrive権限の承認が出る)
 *      → ログに「✅ 車両スナップショット.json 更新」と出ればOK
 *   5. dbx_setupDailyTrigger を実行 (毎朝6時に自動更新)
 *
 * 【備考】
 *   - DropboxアプリはLIME Oneと同じ (fly154tcdbz09x9・PKCE方式)。
 *     Dropboxのリフレッシュトークンは使い捨てではないので、
 *     LIME One / LIME Fleet の既存連携には一切影響しない。
 *   - freee側の関数・プロパティには触れない (キーは DBX_ 接頭辞)。
 * ============================================================ */

var DBX_APP_KEY      = 'fly154tcdbz09x9';
var DBX_PATH_RENTAL  = '/ライム共有DB/システムデータ（R）/data.json';
var DBX_PATH_FLEET   = '/ライム共有DB/システムデータ車両/data.json';
var SNAPSHOT_FOLDER_ID = '1Ts7aIzvFExe2A29ORa1Ozouy8f40yJK9';  // Drive: システム一時保管
var SNAPSHOT_NAME    = '車両スナップショット.json';

function _dbxB64url(bytes){ return Utilities.base64EncodeWebSafe(bytes).replace(/=+$/,''); }
/** 非ASCIIパスをヘッダに載せるためのエスケープ (LIMEFleetの_asciiSafeと同じ役割) */
function _dbxArg(o){
  return JSON.stringify(o).replace(/[\u007f-\uffff]/g,function(c){
    return '\\u'+('0000'+c.charCodeAt(0).toString(16)).slice(-4);
  });
}

/** STEP 1: 認可URLを取得 (実行ログに出る) */
function dbx_getAuthUrl(){
  var chars='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~', v='';
  for(var i=0;i<64;i++) v+=chars.charAt(Math.floor(Math.random()*chars.length));
  _fp().setProperty('DBX_CODE_VERIFIER', v);
  var challenge=_dbxB64url(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, v, Utilities.Charset.US_ASCII));
  var url='https://www.dropbox.com/oauth2/authorize'
    +'?client_id='+DBX_APP_KEY
    +'&response_type=code'
    +'&token_access_type=offline'
    +'&code_challenge_method=S256'
    +'&code_challenge='+challenge;
  Logger.log('▼ このURLをブラウザで開いて「許可」→ 表示されたコードを dbx_setAuthCode に貼る:\n'+url);
  return url;
}

/** STEP 2: 認可コードをリフレッシュトークンに交換して保存 */
function dbx_setAuthCode(){
  // ▼▼▼ STEP1 で画面に出たコードをここに貼って実行 ▼▼▼
  var AUTH_CODE = '__ここにコードを貼る__';
  // ▲▲▲
  if(!AUTH_CODE || AUTH_CODE.indexOf('__')===0) throw new Error('AUTH_CODE を貼ってください');
  var res=UrlFetchApp.fetch('https://api.dropboxapi.com/oauth2/token',{
    method:'post', muteHttpExceptions:true,
    payload:{ code:AUTH_CODE.trim(), grant_type:'authorization_code',
      client_id:DBX_APP_KEY, code_verifier:_fp().getProperty('DBX_CODE_VERIFIER') }
  });
  var j=JSON.parse(res.getContentText());
  if(!j.refresh_token) throw new Error('トークン取得失敗: '+res.getContentText());
  _fp().setProperty('DBX_REFRESH_TOKEN', j.refresh_token);
  Logger.log('✅ Dropbox連携完了。次に dbx_snapshotToDrive を実行してください');
}

/** アクセストークン取得 (リフレッシュトークンは使い回し可・失効しない) */
function dbx_accessToken(){
  var rt=_fp().getProperty('DBX_REFRESH_TOKEN');
  if(!rt) throw new Error('先に dbx_getAuthUrl → dbx_setAuthCode を実行してください');
  var res=UrlFetchApp.fetch('https://api.dropboxapi.com/oauth2/token',{
    method:'post', muteHttpExceptions:true,
    payload:{ grant_type:'refresh_token', refresh_token:rt, client_id:DBX_APP_KEY }
  });
  var j=JSON.parse(res.getContentText());
  if(!j.access_token) throw new Error('Dropboxトークン更新失敗: '+res.getContentText());
  return j.access_token;
}

function dbx_download(path){
  var res=UrlFetchApp.fetch('https://content.dropboxapi.com/2/files/download',{
    method:'post', muteHttpExceptions:true,
    headers:{ Authorization:'Bearer '+dbx_accessToken(), 'Dropbox-API-Arg':_dbxArg({path:path}) }
  });
  if(res.getResponseCode()>=300) throw new Error('Dropbox download失敗 '+path+': '+String(res.getContentText()).slice(0,200));
  return JSON.parse(res.getContentText());
}

/** STEP 3&4: 車両スナップショットをDriveへ書き出す (毎朝の自動実行対象) */
function dbx_snapshotToDrive(){
  var r=dbx_download(DBX_PATH_RENTAL);
  var f=null; try{ f=dbx_download(DBX_PATH_FLEET); }catch(e){ /* Fleet正本は無くても続行 */ }
  // 案件から車両別の最新返却メーター (数値のみ・顧客情報は読まない)
  var meter={};
  (r.cases||[]).forEach(function(c){
    var vid=c.vehicleId, m=Number(c.meterAtReturn||0);
    if(vid&&m>0&&(!meter[vid]||m>meter[vid])) meter[vid]=m;
  });
  var vehicles=(r.vehicles||[]).map(function(v){
    return {
      id:v.id, name:v.name||'', grade:v.grade||'', maker:v.maker||'',
      vehicleClass:v.vehicleClass||'', color:v.color||'', plate:v.plateDisplay||'',
      status:v.status||'', firstRegistration:v.firstRegistration||v.firstRegistrationRaw||'',
      purchaseDate:v.purchaseDate||'', vehiclePrice:Number(v.vehiclePrice||0),
      leaseFee:Number(v.leaseFee||0), leasePeriod:Number(v.leasePeriod||0),
      leaseTotal:Number(v.leaseTotal||0), residualValue:Number(v.residualValue||0),
      lessor:v.lessor||'', dealer:v.dealer||'', inspectionDate:v.inspectionDate||'',
      mileage:Number(v.mileage||0), mileageFromCases:meter[v.id]||0,
      soldAt:v.soldAt||'', soldPrice:Number(v.soldPrice||0), saleNote:v.saleNote||''
    };
  });
  var out={
    generatedAt:new Date().toISOString(),
    note:'GAS dbx_bridge が毎朝自動生成。走行距離は mileage(マスタ) と mileageFromCases(返却メーター最大値) の大きい方を採用すること。',
    vehicleCount:vehicles.length,
    vehicles:vehicles,
    fleet:f?{ meta:f.meta||null, market:f.market||null }:null
  };
  var folder=DriveApp.getFolderById(SNAPSHOT_FOLDER_ID);
  var it=folder.getFilesByName(SNAPSHOT_NAME);
  var content=JSON.stringify(out,null,1);
  if(it.hasNext()){ it.next().setContent(content); }
  else { folder.createFile(SNAPSHOT_NAME, content, 'application/json'); }
  Logger.log('✅ '+SNAPSHOT_NAME+' 更新: 車両'+vehicles.length+'台 / メーター記録あり'+Object.keys(meter).length+'台');
}

/** STEP 5: 毎朝6時の自動更新トリガー (重複は作らない) */
function dbx_setupDailyTrigger(){
  ScriptApp.getProjectTriggers().forEach(function(t){
    if(t.getHandlerFunction()==='dbx_snapshotToDrive') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('dbx_snapshotToDrive').timeBased().everyDays(1).atHour(6).create();
  Logger.log('✅ 毎朝6時の自動更新トリガーを設定しました');
}
