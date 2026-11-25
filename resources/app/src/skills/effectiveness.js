/**
 * Skill / 插件「有效性」审计。
 *
 * 背景：加载成功 ≠ 真的生效。扩展系统里有两类静默失效，历史上都表现为
 * 「日志一行绿、功能一次没跑」，排查时要从头读代码才能发现：
 *
 *   · hooks 名写错（'before-send' 而不是 'before-tool'）——loader 照常注册，
 *     但核心从不发射这个名字，插件永远收不到调用；
 *   · 声明的能力没人消费（核心不取、其它 Skill 也不 requires）——提供者登记好了，
 *     却没有任何调用方；
 *   · 清单 capabilities 声明了但 providers 没实现——调用方拿到空数组；
 *   · 入口只有 setup、不注册工具也不提供能力/钩子/提示段——模块存在但没有接点。
 *
 * 这里把「核心真正会调用的名字」固化成一张表，加载期与 /api/skills 都用它判。
 * 表与代码的一致性由 test/skills-effectiveness.test.mjs 反向校验（读源码 grep
 * runHook(...) / getCapabilityProviders(...) 对账），避免表本身腐化。
 */

/** 核心真正发射的钩子名（orchestrator 里 runHook 的调用点）。 */
export const KNOWN_HOOKS = Object.freeze({
  'before-context': 'src/orchestrator.js:1015 组装上下文前',
  'before-llm-messages': 'src/orchestrator.js:1165 消息发给模型前',
  'after-response': 'src/orchestrator.js:1303 模型回复后（改写 tool_calls 在这）',
  'before-tool': 'src/orchestrator.js:1351 工具执行前',
  'after-tool': 'src/orchestrator.js:1364 工具执行后'
});

/** 核心代码里确实会去取用的能力（getCapabilityProviders / providersOf / #capFirst）。 */
export const CONSUMED_CAPABILITIES = Object.freeze({
  'chat.ban-state': 'src/app.js:937、src/orchestrator.js:1665',
  'image.mime-support': 'src/tools.js:1123',
  'llm.endpoint-feedback': 'src/llm.js:501',
  'llm.endpoint-pick': 'src/llm.js:279',
  'llm.request-params': 'src/skills/manager.js:469',
  'llm.response': 'src/skills/manager.js:474',
  'llm.retry-advisor': 'src/skills/manager.js:488',
  'llm.usage': 'src/skills/manager.js:479',
  'media.download': 'src/app.js:791、src/media-links.js:59',
  'media.transcribe': 'src/onebot.js:42',
  'media.transcribe.available': 'src/onebot.js:46',
  'message.inline-at-normalize': 'src/onebot.js:23',
  'message.owner-check': 'src/orchestrator.js:1075',
  'qzone.snapshot': 'src/qzone-tools.js:38',
  'reply.grounded-select': 'src/orchestrator.js:962',
  'reply.local-policy': 'src/orchestrator.js:1445',
  'reply.subscription': 'src/orchestrator.js:925',
  'sticker.label': 'src/native-stickers.js:77、:225',
  'sticker.review': 'src/native-stickers.js:166、:232',
  'tool.guard': 'src/skills/manager.js:493',
  'video.frames': 'src/video-reader.js:219',
  'video.frames.available': 'src/video-reader.js:96'
});

/** 「能不能用」探针型能力：由核心在正式取用前先问一句，不以 providersOf 形式出现。 */
export const PROBE_SUFFIX = '.available';

const FINDING = Object.freeze({
  LOAD_FAILED: 'LOAD_FAILED',
  UNKNOWN_HOOK: 'UNKNOWN_HOOK',
  UNCONSUMED_CAPABILITY: 'UNCONSUMED_CAPABILITY',
  DECLARED_NOT_IMPLEMENTED: 'DECLARED_NOT_IMPLEMENTED',
  IMPLEMENTED_NOT_DECLARED: 'IMPLEMENTED_NOT_DECLARED',
  NO_ENTRY_POINT: 'NO_ENTRY_POINT',
  DUPLICATE_PROVIDER: 'DUPLICATE_PROVIDER'
});

/**
 * 审计一个已加载（或加载失败）的 Skill。
 * @param {object} skill loader 注册进 registry 的实例 { manifest, providers, hooks, toolIds, promptSections, loadError, kind }
 * @param {{ requiredBy?: Set<string>|string[], knownHooks?: Record<string,string>, consumed?: Record<string,string>, providerIndex?: Map<string,string[]> }} [options]
 *   requiredBy：所有 Skill 的 requires 合集（被别人用掉的能力也算生效）。
 * @returns {{ id: string, effective: boolean, findings: Array<{code:string, level:'warn'|'info', message:string, fix:string}> }}
 */
export function auditSkill(skill, options = {}) {
  const requiredBy = options.requiredBy instanceof Set
    ? options.requiredBy
    : new Set(options.requiredBy || []);
  const knownHooks = options.knownHooks || KNOWN_HOOKS;
  const consumed = options.consumed || CONSUMED_CAPABILITIES;
  const manifest = skill?.manifest || {};
  const id = String(manifest.id || skill?.id || '');
  const findings = [];

  if (skill?.loadError) {
    findings.push({
      code: FINDING.LOAD_FAILED, level: 'warn',
      message: `本次加载失败：${skill.loadError}`,
      fix: '按上面的原始错误修清单/入口；失败条目不会产生任何副作用。'
    });
    return { id, effective: false, findings };
  }

  const hooks = Object.keys(skill?.hooks || {});
  const providers = Object.keys(skill?.providers || {});
  const declared = Array.isArray(manifest.capabilities) ? manifest.capabilities.map(String) : [];
  const toolIds = Array.isArray(skill?.toolIds) ? skill.toolIds : [];

  // 1. 钩子名不在核心发射表里 → 注册成功但永远不会被调用。
  for (const hook of hooks) {
    if (!Object.prototype.hasOwnProperty.call(knownHooks, hook)) {
      findings.push({
        code: FINDING.UNKNOWN_HOOK, level: 'warn',
        message: `钩子「${hook}」不是核心会发射的名字，永远不会被调用`,
        fix: `改成以下之一：${Object.keys(knownHooks).join(' / ')}`
      });
    }
  }

  // 2. 声明了却没实现 → 调用方拿到空数组。
  for (const cap of declared) {
    if (!providers.includes(cap)) {
      findings.push({
        code: FINDING.DECLARED_NOT_IMPLEMENTED, level: 'warn',
        message: `清单声明能力「${cap}」，但 providers 没有实现`,
        fix: '在 index.js 的 providers 里补上同名函数，或从清单 capabilities 里删掉。'
      });
    }
  }

  // 3. 实现了却没声明 → 使用方看不出能提供什么，也可能被重复实现。
  for (const cap of providers) {
    if (!declared.includes(cap)) {
      findings.push({
        code: FINDING.IMPLEMENTED_NOT_DECLARED, level: 'info',
        message: `providers 提供了「${cap}」，但清单 capabilities 没声明`,
        fix: '把能力名补进清单 capabilities（能力页与 /api/skills/capabilities 靠它展示）。'
      });
    }
  }

  // 3.5 同一个能力被多个 Skill 实现：核心多数调用点只取 providersOf(...)[0]，
  //     排在后面的那份实现永远不会被调用 —— 这就是「装了但没反应」的另一种来源。
  const providerIndex = options.providerIndex;
  if (providerIndex && typeof providerIndex.get === 'function') {
    for (const cap of providers) {
      const owners = (providerIndex.get(cap) || []).filter(Boolean);
      if (owners.length < 2 || owners[0] === id) continue;
      findings.push({
        code: FINDING.DUPLICATE_PROVIDER, level: 'info',
        message: `能力「${cap}」同时由 ${owners.join('、')} 提供；核心多数调用点只取第一个（${owners[0]}），本插件这份不会被调用`,
        fix: '只保留一处实现；确实要并存就让调用点遍历全部提供者，否则从清单里去掉重复能力。'
      });
    }
  }

  // 4. 声明了但没人消费：核心不取、别的 Skill 也不 requires、也不是可用性探针。
  for (const cap of declared) {
    if (Object.prototype.hasOwnProperty.call(consumed, cap)) continue;
    if (requiredBy.has(cap)) continue;
    if (cap.endsWith(PROBE_SUFFIX)) continue;
    findings.push({
      code: FINDING.UNCONSUMED_CAPABILITY, level: 'info',
      message: `能力「${cap}」当前没有消费方（核心不取用，也没有 Skill requires 它）`,
      fix: '确认是否还留着：要么让调用方 requires 它，要么把它做成工具；保留则当作对外接口即可。'
    });
  }

  // 5. 一个接点都没有 → 模块被加载，但既不进模型工具列表，也不进主流程。
  const hasPromptSections = typeof skill?.promptSections === 'function';
  if (!toolIds.length && !hooks.length && !providers.length && !hasPromptSections) {
    findings.push({
      code: FINDING.NO_ENTRY_POINT, level: 'warn',
      message: '没有任何接点：不注册工具、不提供能力、没有钩子、也没有提示段',
      fix: '至少要有一个：api.registerTool(...) / providers / hooks / promptSections。'
    });
  }

  return { id, effective: findings.every((f) => f.level !== 'warn'), findings };
}

/**
 * 批量审计，并给出可直接放进 /api/skills 与 UI 的摘要。
 * @param {Array} skills registry.list() 的结果
 * @param {{ requiredBy?: Set<string>|string[] }} [options]
 */
export function auditSkills(skills, options = {}) {
  const list = Array.isArray(skills) ? skills : [];
  const requiredBy = options.requiredBy instanceof Set
    ? options.requiredBy
    : new Set(options.requiredBy || []);
  const results = list.map((skill) => auditSkill(skill, { ...options, requiredBy }));
  const warnings = results.reduce((n, r) => n + r.findings.filter((f) => f.level === 'warn').length, 0);
  return {
    results,
    summary: {
      total: results.length,
      effective: results.filter((r) => r.effective).length,
      ineffective: results.filter((r) => !r.effective).length,
      warnings,
      infos: results.reduce((n, r) => n + r.findings.filter((f) => f.level === 'info').length, 0)
    }
  };
}

export { FINDING as EFFECTIVENESS_FINDING };
