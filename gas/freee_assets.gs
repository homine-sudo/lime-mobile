/* ============================================================
 * freee_assets.gs — freee固定資産 簿価スナップショット (2026-08-28)
 *   「freee連携」GASプロジェクトに新規ファイルとして追加する。
 *   ★dbx_bridge.gs が同プロジェクトに入っていること (Dropbox認証を共用)。
 *
 * 【目的】
 *   freeeの固定資産台帳から車両ごとの 帳簿価額(簿価)・当期償却額 を取得し、
 *   Dropbox の システムデータ車両/fixed_assets.json に書き出す。
 *   → LIME Fleet が「相場 − 簿価 = 会計上の売却損益」を表示できるように。
 *
 * 【2つのAPIを両方試す理由】
 *   ① freee固定資産(新プロダクト) API: /hub/fixed_asset_management/fixed_assets
 *      (2026-08-28リリース。freee固定資産の契約が必要)
 *   ② freee会計 固定資産台帳API: /api/1/fixed_assets
 *      (エンタープライズプラン限定。スタンダードだと401が返る)
 *   どちらが使える契約かはアカウント次第なので、両方叩いて
 *   資産が返ってきた方を採用する。両方ダメでも snapshot は書き出し、
 *   LIME Fleet 側に「未契約/権限なし」を表示させる。
 *
 * 【セットアップ 4手順・約5分】
 *   1. GASエディタ「＋ファイル」→ freee_assets → 本文を丸ごと貼る
 *   2. FFA_TOKEN_FUNC にこのプロジェクト既存のfreeeトークン取得関数名を設定
 *      (空のままなら下の候補名から自動検出を試みる)
 *   3. ffa_testLog を実行 → ログで「どちらのAPIが使えたか」と
 *      「資産レコードのキー一覧」を確認
 *      ※401なら freeeアプリ管理→権限設定 で固定資産(読み取り)に
 *        チェック→再認可が必要
 *   4. ffa_snapshotToDropbox を実行 → ✅が出たら ffa_setupDailyTrigger
 *
 * 【備考】
 *   - freee側の既存関数・プロパティには触れない (キーは FFA_ 接頭辞)。
 *   - 固定資産に個人情報は含まれないため raw のまま書き出す。
 * ============================================================ */

// ▼ 既存freee連携のアクセストークン取得関数名 (例: 'freeeAccessToken')。
//   空文字なら FFA_TOKEN_CANDIDATES から自動検出。
var FFA_TOKEN_FUNC = '';
var FFA_TOKEN_CANDIDATES = ['freeeAccessToken','getFreeeAccessToken','freeeToken','getFreeeToken','getAccessToken','refreshFreeeAccessToken'];
var FFA_OUT_PATH = '/ライム共有DB/システムデータ車両/fixed_assets.json';

function ffa_freeeToken(){
  var g=(function(){return this})();  // GASグローバル
  var names=FFA_TOKEN_FUNC?[FFA_TOKEN_FUNC]:FFA_TOKEN_CANDIDATES;
  for(var i=0;i<names.length;i++){
    if(typeof g[names[i]]==='function'){
      var t=g[names[i]]();
      if(t&&typeof t==='string') return t;
    }
  }
  // 関数が見つからない場合の最終手段: プロパティに直接置かれたトークン
  var p=PropertiesService.getScriptProperties();
  var raw=p.getProperty('FREEE_ACCESS_TOKEN')||p.getProperty('ACCESS_TOKEN');
  if(raw) return raw;
  throw new Error('freeeトークン取得関数が見つかりません。FFA_TOKEN_FUNC に既存の関数名を設定してください (候補: '+FFA_TOKEN_CANDIDATES.join(' / ')+')');
}

/** 事業所ID: プロパティ優先 → /api/1/companies の先頭をキャッシュ */
function ffa_companyId(){
  var p=PropertiesService.getScriptProperties();
  var id=p.getProperty('FFA_COMPANY_ID')||p.getProperty('FREEE_COMPANY_ID')||p.getProperty('COMPANY_ID');
  if(id) return String(id).trim();
  var res=UrlFetchApp.fetch('https://api.freee.co.jp/api/1/companies',{
    headers:{Authorization:'Bearer '+ffa_freeeToken()}, muteHttpExceptions:true
  });
  var j=JSON.parse(res.getContentText());
  if(!j.companies||!j.companies.length) throw new Error('事業所IDを特定できません: '+res.getContentText().slice(0,200));
  id=String(j.companies[0].id);
  p.setProperty('FFA_COMPANY_ID', id);
  return id;
}

function ffa_get(url){
  var res=UrlFetchApp.fetch(url,{
    headers:{Authorization:'Bearer '+ffa_freeeToken(), Accept:'application/json'},
    muteHttpExceptions:true
  });
  var code=res.getResponseCode(), body=res.getContentText();
  var json=null; try{ json=JSON.parse(body); }catch(e){}
  return {status:code, json:json, raw:body};
}

/** レスポンスから資産配列を取り出す (キー名がAPIごとに違うため最初の配列を採用) */
function ffa_pickArray(j){
  if(!j) return null;
  if(Array.isArray(j)) return j;
  var keys=Object.keys(j);
  for(var i=0;i<keys.length;i++){ if(Array.isArray(j[keys[i]])) return j[keys[i]]; }
  return null;
}

/** ①freee固定資産(hub) ②会計固定資産台帳 の順に取得。結果と診断情報を返す */
function ffa_fetchAll(){
  var cid=ffa_companyId();
  var out={hub:{ok:false,status:0,count:0,error:null}, kaikei:{ok:false,status:0,count:0,error:null}, assets:[], assetSource:null};

  // ① freee固定資産 (新API 2026-08-28)
  var r1=ffa_get('https://api.freee.co.jp/hub/fixed_asset_management/fixed_assets?company_id='+encodeURIComponent(cid));
  out.hub.status=r1.status;
  var a1=ffa_pickArray(r1.json);
  if(r1.status<300&&a1){ out.hub.ok=true; out.hub.count=a1.length; }
  else out.hub.error=String(r1.raw||'').slice(0,300);

  // ② freee会計 固定資産台帳 (エンタープライズ限定・ページング100件ずつ)
  var a2=[], off=0, LIMIT=100;
  for(var page=0;page<20;page++){  // 最大2000件で打ち切り
    var r2=ffa_get('https://api.freee.co.jp/api/1/fixed_assets?company_id='+encodeURIComponent(cid)+'&limit='+LIMIT+'&offset='+off);
    out.kaikei.status=r2.status;
    if(r2.status>=300){ out.kaikei.error=String(r2.raw||'').slice(0,300); break; }
    var chunk=ffa_pickArray(r2.json)||[];
    a2=a2.concat(chunk); off+=LIMIT;
    if(chunk.length<LIMIT) break;
  }
  if(!out.kaikei.error){ out.kaikei.ok=true; out.kaikei.count=a2.length; }

  // 採用: hubに資産があればhub (freee固定資産が正本)、なければ会計台帳
  if(out.hub.ok&&a1&&a1.length){ out.assets=a1; out.assetSource='hub'; }
  else if(out.kaikei.ok&&a2.length){ out.assets=a2; out.assetSource='kaikei'; }
  return out;
}

function ffa_dbxUpload(path, content){
  var arg={path:path, mode:{'.tag':'overwrite'}, autorename:false, mute:true};
  var res=UrlFetchApp.fetch('https://content.dropboxapi.com/2/files/upload',{
    method:'post', muteHttpExceptions:true, contentType:'application/octet-stream',
    headers:{ Authorization:'Bearer '+dbx_accessToken(), 'Dropbox-API-Arg':_dbxArg(arg) },
    payload:content
  });
  if(res.getResponseCode()>=300) throw new Error('Dropbox upload失敗 '+path+': '+String(res.getContentText()).slice(0,200));
}

/** 本体: 固定資産スナップショットをDropboxへ書き出す (毎朝の自動実行対象) */
function ffa_snapshotToDropbox(){
  if(typeof dbx_accessToken!=='function') throw new Error('dbx_bridge.gs が同じGASプロジェクトに必要です');
  var r=ffa_fetchAll();
  var out={
    generatedAt:new Date().toISOString(),
    note:'GAS freee_assets が毎朝自動生成。assetSource=hub はfreee固定資産API、kaikei はfreee会計固定資産台帳API。LIME Fleet が簿価表示に使用。',
    sources:{hub:r.hub, kaikei:r.kaikei},
    assetSource:r.assetSource,
    assetCount:r.assets.length,
    assets:r.assets
  };
  ffa_dbxUpload(FFA_OUT_PATH, JSON.stringify(out,null,1));
  Logger.log('✅ fixed_assets.json 更新: '+(r.assetSource||'取得元なし')+' / 資産'+r.assets.length+'件 (hub:'+r.hub.status+' kaikei:'+r.kaikei.status+')');
}

/** セットアップ確認用: 各APIの結果と資産レコードのキー一覧をログに出す */
function ffa_testLog(){
  var r=ffa_fetchAll();
  Logger.log('hub(freee固定資産): status='+r.hub.status+' ok='+r.hub.ok+' count='+r.hub.count+(r.hub.error?' error='+r.hub.error:''));
  Logger.log('kaikei(会計台帳): status='+r.kaikei.status+' ok='+r.kaikei.ok+' count='+r.kaikei.count+(r.kaikei.error?' error='+r.kaikei.error:''));
  if(r.assets.length){
    Logger.log('採用: '+r.assetSource+' / 1件目のキー: '+Object.keys(r.assets[0]).join(', '));
    Logger.log('1件目の中身: '+JSON.stringify(r.assets[0]).slice(0,600));
  } else {
    Logger.log('⚠ 資産が取得できませんでした。401なら freeeアプリの権限設定で固定資産(読み取り)を有効化→再認可。404ならプラン/契約を確認。');
  }
}

/** 毎朝6:10の自動更新トリガー (dbx_bridgeの6:00の後・重複は作らない) */
function ffa_setupDailyTrigger(){
  ScriptApp.getProjectTriggers().forEach(function(t){
    if(t.getHandlerFunction()==='ffa_snapshotToDropbox') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('ffa_snapshotToDropbox').timeBased().everyDays(1).atHour(6).nearMinute(10).create();
  Logger.log('✅ 毎朝6時台の自動更新トリガーを設定しました');
}
