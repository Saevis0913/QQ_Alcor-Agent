import fs from 'node:fs';
import {isIP} from 'node:net';
import {safeFetchBinary} from './safe-fetch.js';
import {readUpdateSource} from './update-source.js';

// 更新源：用户设置（data/release-source.json）优先，其次随包出厂值。
function releaseSource(){
  try { return readUpdateSource().url; }
  catch { return ''; }
}
function httpsUrl(value){
  if(typeof value!=='string'||value.length>2048)throw Error('UPDATE_MANIFEST_INVALID');
  const url=new URL(value);
  if(url.protocol!=='https:'||url.username||url.password||url.hash||isIP(url.hostname)||!url.hostname.includes('.')||url.hostname.endsWith('.localhost'))throw Error('UPDATE_MANIFEST_INVALID');
  return url.href;
}
function version(value){
  const match=/^v?(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(value||''));
  if(!match)throw Error('UPDATE_MANIFEST_INVALID');
  const pre=match[4]?.split('.')||[];
  if(pre.some(x=>!x||/^\d+$/.test(x)&&x.length>1&&x.startsWith('0')))throw Error('UPDATE_MANIFEST_INVALID');
  const asPatch=/^as$/.test(pre[0])?Number(pre[1]||0):0;
  return{numbers:match.slice(1,4).map(Number),pre,asPatch};
}
function newer(a,b){
  for(let i=0;i<3;i++)if(a.numbers[i]!==b.numbers[i])return a.numbers[i]>b.numbers[i];
  /* Alcor 的小版本约定：0.3.1-as.1 是 0.3.1 的补丁，必须比 0.3.1 新，否则老用户收不到。 */
  if(a.asPatch!==b.asPatch)return a.asPatch>b.asPatch;
  if(a.asPatch)return false;
  if(!a.pre.length||!b.pre.length)return !a.pre.length&&b.pre.length>0;
  for(let i=0;i<Math.max(a.pre.length,b.pre.length);i++){
    if(a.pre[i]===b.pre[i])continue;
    if(a.pre[i]===undefined)return false;if(b.pre[i]===undefined)return true;
    const an=/^\d+$/.test(a.pre[i]),bn=/^\d+$/.test(b.pre[i]);
    if(an&&bn)return BigInt(a.pre[i])>BigInt(b.pre[i]);
    if(an!==bn)return !an;
    return a.pre[i]>b.pre[i];
  }
  return false;
}

function githubRepository(value) {
  const url = new URL(value);
  if (url.hostname !== 'github.com' || url.port || url.search) return null;
  const match = /^\/([a-z0-9][a-z0-9-]{0,38})\/([a-z0-9][a-z0-9_.-]{0,99})\/?$/i.exec(url.pathname);
  if (!match) return null;
  const slug = match.slice(1).join('/');
  return { url: 'https://github.com/' + slug, endpoint: 'https://api.github.com/repos/' + slug + '/releases?per_page=30' };
}

export function releaseProjectUrl() {
  try { return githubRepository(httpsUrl(releaseSource()))?.url || ''; }
  catch { return ''; }
}

function githubManifest(releases, project, standard) {
  // 滚动 release（v0.3-latest 之类）被标成预发行，否则会占用仓库首页的 Releases 位；
  // 所以这里不看 latest 接口，而是把发行列表拉下来，按资产文件名里的版本号挑最高的一份。
  if (!Array.isArray(releases)) throw Error('UPDATE_MANIFEST_INVALID');
  const edition = standard ? 'Alcor-Agent-OneBot' : 'Alcor-Agent';
  const pattern = new RegExp('^' + edition + '-Setup-(\\d+\\.\\d+\\.\\d+(?:-as\\.\\d+)?)-x64\\.exe$');
  let best = null;
  for (const release of releases) {
    if (!release || release.draft !== false || !Array.isArray(release.assets)) continue;
    for (const asset of release.assets) {
      const match = pattern.exec(String(asset?.name || ''));
      if (!match) continue;
      if (asset.state !== 'uploaded') continue;
      const candidate = { version: match[1], fileName: asset.name, tag: release.tag_name, release };
      if (!best || newer(version(candidate.version), version(best.version))) best = candidate;
    }
  }
  if (!best) throw Error('UPDATE_NO_STABLE_RELEASE');
  const url = httpsUrl(best.release.assets.find(item => item?.name === best.fileName)?.browser_download_url);
  const expected = project.url + '/releases/download/' + encodeURIComponent(best.tag) + '/' + encodeURIComponent(best.fileName);
  if (url !== expected) throw Error('UPDATE_MANIFEST_INVALID');
  return { product: 'Alcor Agent', version: best.version, url, notes: best.release.body, publishedAt: best.release.published_at };
}

export function updateCallSites() { /* 占位，无副作用 */ }

export async function checkReleaseUpdate(current,{source=releaseSource(),fetchBinary=safeFetchBinary,standard=true}={}){
  let base={current,configured:Boolean(source),hasUpdate:false,channel:'alcor'};
  if(!source)return {...base,ok:false,code:'UPDATE_SOURCE_NOT_CONFIGURED',error:'尚未配置 Alcor 更新源。正式发布后才能检查新版本。'};
  try{
    const sourceUrl=httpsUrl(source),installed=version(current);
    const github = githubRepository(sourceUrl);
    if (github) base = { ...base, projectUrl: github.url };
    // 发行列表比单份清单大得多（仓库里有多个 release 时到几十 KB 以上），单独给大一点的额度。
    const limit = github ? 524288 : 65536;
    let buffer;
    try {
      ({buffer}=await fetchBinary(github?.endpoint || sourceUrl,limit,{httpsOnly:true,publicOnly:true,timeoutMs:8000,maxRedirects:github ? 0 : 3}));
    } catch (error) {
      if (github && error?.status === 404) {
        return { ...base, ok: false, code: 'UPDATE_NO_STABLE_RELEASE', error: '暂未找到可公开读取的正式版本。' };
      }
      return {...base,ok:false,code:'UPDATE_CHECK_FAILED',error:'暂时无法获取更新信息，请稍后重试。'};
    }
    if(!buffer?.length||buffer.length>=limit)throw Error('UPDATE_MANIFEST_INVALID');
    const payload = JSON.parse(buffer.toString('utf8'));
    const manifest = github ? githubManifest(payload, github, standard) : payload;
    if(manifest?.product!=='Alcor Agent')throw Error('UPDATE_MANIFEST_INVALID');
    const latest=String(manifest.version),parsed=version(latest),url=httpsUrl(manifest.url);
    if(manifest.notes!=null&&(typeof manifest.notes!=='string'||manifest.notes.length>16000))throw Error('UPDATE_MANIFEST_INVALID');
    if(manifest.publishedAt!=null&&(!Number.isFinite(Date.parse(manifest.publishedAt))||String(manifest.publishedAt).length>50))throw Error('UPDATE_MANIFEST_INVALID');
    // Stable installs do not advertise pre-releases from an accidentally changed feed.
    const hasUpdate=(!parsed.pre.length||installed.pre.length>0||parsed.asPatch>0)&&newer(parsed,installed);
    return{...base,ok:true,latest,hasUpdate,url,notes:manifest.notes||'',publishedAt:manifest.publishedAt||null};
  }catch{return{...base,ok:false,code:'UPDATE_MANIFEST_INVALID',error:'更新信息格式或地址无效，请联系发布者检查版本清单。'};}
}
