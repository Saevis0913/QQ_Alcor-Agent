'use strict';
async function showInstallationGuide({firstRun=false}={}) {
  if(document.querySelector('#installation-report'))return;
  const standard = Boolean(state.status?.onebotEdition);
  const modal=modelModalShell({head:firstRun?'开始使用 Alcor Agent':'安装导航与环境检测',body:`
    <ol class="install-steps">
      ${standard ? '<li><strong>准备聊天后端</strong><p>在这台电脑上启动你有权使用的 OneBot v11 服务，取得 HTTP、WebSocket 地址和所需令牌。</p></li><li><strong>连接账号</strong><p>进入 Alcor 页填写连接信息，点击“保存并连接”，检查显示的账号。</p></li>' : `
      <li><strong>登录 QQ</strong><p>在同一 Windows 用户下正常登录兼容的 QQ。按模块校验值精确识别构建：9.9.36-53644 x64 已实测；9.9.37-54395 x64 已静态适配，待实际运行验证。版本号相同也需通过模块校验。</p></li>
      <li><strong>连接 Alcor</strong><p>进入 Alcor 页，启动核心，点击“打开控制台（免输令牌）”，再选择已登录的 QQ 进程。手动访问控制台时可在 Alcor 页复制令牌。</p></li>`}
      <li><strong>设置 AI 与会话</strong><p>填写模型 API 地址、模型和必要的密钥，在“人设”页自行添加人设或填写角色设定，再添加聊天白名单并选择回复模式。确认后点击“恢复”。初始状态为暂停。</p></li>
    </ol>
    <p class="hint">已包含 Node.js、Electron${standard ? '' : '、Alcor 核心'}和本地语音转写组件。视频与动图处理使用 PATH 中的 FFmpeg 和 FFprobe。媒体依赖缺失会列为提示，基础文字功能仍可使用。</p>
    <div class="install-report-heading"><label for="installation-report">环境检测报告</label><span id="installation-result" role="status">正在检测…</span></div>
    <textarea id="installation-report" readonly spellcheck="false" rows="13" aria-busy="true">正在检查系统、运行时和连接配置，请稍候…</textarea>
    <p class="hint">遇到问题时，点击“复制完整报告”，将缺失项和错误代码发送给本地 AI 程序。报告不包含 QQ 密码、令牌或模型密钥。</p>`,
    foot:'<span id="installation-copy-status" class="hint" role="status"></span><button class="btn" id="installation-copy" disabled>复制完整报告</button><button class="btn" id="installation-recheck">重新检测</button><button class="btn btn-primary" id="installation-next">前往 Alcor</button>'});
  modal.classList.add('installation-overlay');
  const report=modal.querySelector('#installation-report'),copy=modal.querySelector('#installation-copy'),retry=modal.querySelector('#installation-recheck');
  async function check(){
    retry.disabled=true;copy.disabled=true;report.setAttribute('aria-busy','true');modal.querySelector('#installation-result').textContent='正在检测…';
    try{
      const result=await api('/api/environment');if(!modal.isConnected)return;
      report.value=result.text;copy.disabled=false;
      const missing=result.checks.filter(c=>['error','setup'].includes(c.status));
      const warnings=result.checks.filter(c=>c.status==='warning');
      modal.querySelector('#installation-result').textContent=missing.length
        ? `${missing.length} 项需要处理`
        : warnings.length ? `检查通过，${warnings.length} 项提示` : '检查通过';
    }catch(error){if(modal.isConnected){report.value=`[ENV_ENDPOINT_FAILED] 无法完成环境检测\n${error.message}\n请从托盘完全退出并重新启动 Agent，再点击重新检测。也可运行安装目录中的 Diagnose-Alcor.cmd。\n请复制本报告给本地 AI 程序。`;copy.disabled=false;modal.querySelector('#installation-result').textContent='检测未完成';}}
    finally{retry.disabled=false;report.setAttribute('aria-busy','false');}
  }
  copy.onclick=async()=>{try{await navigator.clipboard.writeText(report.value);modal.querySelector('#installation-copy-status').textContent='完整报告已复制';}catch{report.focus();report.select();modal.querySelector('#installation-copy-status').textContent='请按 Ctrl+C 复制已选中的报告';}};
  retry.onclick=check;
  modal.querySelector('#installation-next').onclick=()=>{closeModelModal(modal);switchTab('alcor');};
  if(firstRun)api('/api/config',{method:'POST',body:JSON.stringify({ui:{installGuideSeen:true}})}).catch(()=>{});
  await check();
}
