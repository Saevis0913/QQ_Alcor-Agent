// One decision per interaction, shared by every sticker transport. No I/O or model calls.
const TIERS = [null,
  { label: '不发', probability: 0, cap: 0 },
  { label: '偶尔发', probability: .20, cap: 3 },
  { label: '正常', probability: .35, cap: 6 },
  { label: '经常发', probability: .70, cap: 8 }
];

const stickerWord = /表情(?:包|图)?|梗鲸|梗图|贴纸|斗图|\b(?:stickers?|memes?)\b/iu;
const politeLead = /^(?:(?:请问|请|麻烦|劳驾|拜托|帮我|你|您|能不能|可不可以|能否|可以|能|再|直接|现在)\s*)+/u;
const sendLead = /^(?:发(?:送|来)?|来|整|回|丢|甩|扔|贴|分享|给(?:我们|我|大家|群里)|给(?=\s*[个张一两几点])|(?:我)?想要|我要)\s*/u;
const stickerFirst = /^(?:原生\s*)?(?:QQ\s*)?(?:表情(?:包|图)?|梗鲸(?:原图|表情包?)?|梗图|贴纸)\s*(?:(?:请|再|给我|给大家)\s*)*(?:发(?:送)?|来|整)(?=\s*(?:[一两几\d个张点]|[呀啊吧嘛呗吗~～]*$))/iu;
const discussion = /^(?:了|过|的|没|不|聊|说|讲|问|教|介绍|分析|解释|怎么|如何|给(?:他|她|别人))|(?:教程|方法|流程|设置|规则|意思|示例|功能|许可|开关|关掉|关闭|发不了)[呀啊吧嘛呗吗~～\s]*$/u;
const cancelLead = /^(?:算了\s*)?(?:先别|不要|不用|别|不必|不想要)\s*/u;
const cancelAction = /^(?:(?:再)?(?:发(?:送)?|来|给我|用))?[了啦啊呀吧嘛呗~～]*$/u;

/** Recognize a direct request in the sender's own text, before asking the model. */
export function isExplicitStickerRequest(text) {
  if (typeof text !== 'string') return false;
  const clauses = text.normalize('NFKC')
    .replace(/“[^”]*”|「[^」]*」|『[^』]*』|"[^"\r\n]*"|`[^`\r\n]*`|\[(?:表情|表情包|图片|动画表情)\]/gu, ' ')
    .split(/[，,。！？!?；;\r\n]+/u);
  let requested = false;
  for (const part of clauses) {
    const clause = part.trim().replace(politeLead, '');
    const cancel = cancelLead.exec(clause);
    if (cancel) {
      if (stickerWord.test(clause) || cancelAction.test(clause.slice(cancel[0].length))) requested = false;
      continue;
    }
    const action = sendLead.exec(clause);
    if (action) {
      const object = clause.slice(action[0].length);
      if (stickerWord.test(object) && !discussion.test(object)) requested = true;
    }
    if (stickerFirst.test(clause) ||
        /^用.{0,40}(?:表情(?:包|图)?|梗鲸|梗图|贴纸)(?:来)?回/u.test(clause) ||
        /^(?:(?:can|could|would)\s+you\s+|please\s+)?(?:send|share|post|drop|give)\s+.{0,80}\b(?:stickers?|memes?)\b/iu.test(clause)) {
      requested = true;
    }
  }
  return requested;
}

export function normalizeStickerSettings(value = {}) {
  const settings = value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {};
  const legacy = Number(settings.encourage);
  const raw = settings.sendTier ?? (Number.isInteger(legacy) && legacy >= 0 && legacy <= 3 ? legacy + 1 : 2);
  const tier = Number(raw);
  settings.sendTier = Number.isInteger(tier) && tier >= 1 && tier <= 4 ? tier : 2;
  settings.policyVersion = 1;
  settings.promptMaxStickers = 20;
  delete settings.encourage;
  return settings;
}

export function stickerTier(settings) {
  const normalized = normalizeStickerSettings(settings);
  return { ...TIERS[normalized.sendTier], tier: normalized.sendTier, enabled: normalized.enabled !== false };
}

const fail = (code, message) => { throw Object.assign(new Error(code + ': ' + message), { code, nonretryable: true }); };
function checkScope(selfId, chatKey) {
  if (!/^[1-9]\d{0,9}$/.test(String(selfId)) || !/^(group|private):[1-9]\d{0,9}$/.test(String(chatKey))) {
    fail('STICKER_SCOPE_CHANGED', '无法确认表情发送的账号和会话');
  }
}

export function ensureStickerDecision(session, { selfId, chatKey, sticker, requested = false, random = Math.random }) {
  checkScope(selfId, chatKey);
  if (!session || typeof session !== 'object') fail('STICKER_SESSION_REQUIRED', '缺少本轮表情发送许可');
  if (session.stickerPolicy) {
    if (session.stickerPolicy.selfId !== String(selfId) || session.stickerPolicy.chatKey !== chatKey) {
      fail('STICKER_SCOPE_CHANGED', '本轮 QQ 账号或会话已变化');
    }
    return session.stickerPolicy;
  }
  const tier = stickerTier(sticker);
  const byRequest = requested === true;
  const roll = byRequest ? null : random();
  session.stickerPolicy = { version: 1, selfId: String(selfId), chatKey, tier: tier.tier,
    ...(byRequest && { requested: true }), roll,
    eligible: tier.enabled && (byRequest || (Number.isFinite(roll) && roll >= 0 && roll < tier.probability)),
    attempted: false };
  return session.stickerPolicy;
}

export function countsTowardStickerWindow(row) {
  // An uncertain ordinary image cannot displace a known sticker; an uncertain sticker still counts.
  return row?.self === true && row.delivery !== 'failed' && (row.delivery !== 'unknown' || isSticker(row));
}

export function recentBotMessages(history, { selfId, chatKey }) {
  return (Array.isArray(history) ? history : []).filter((row) => countsTowardStickerWindow(row) &&
    String(row.selfId ?? '') === String(selfId) && (!row.chatKey || row.chatKey === chatKey));
}

function isSticker(row) {
  if (Array.isArray(row.media) && row.media.some((media) => media?.sticker === true || media?.kind === 'sticker')) return true;
  // Earlier releases saved only labels; preserve those historical sends in the cap.
  return /^\[(?:表情(?:包)?(?::[^\]]*)?|梗鲸图片)\]$/.test(String(row.text ?? ''));
}

export function checkStickerDispatch(decision, { selfId, chatKey, sticker, history = [], signal } = {}) {
  signal?.throwIfAborted();
  checkScope(selfId, chatKey);
  if (!decision || decision.version !== 1) fail('STICKER_SESSION_REQUIRED', '缺少本轮表情发送许可');
  if (decision.selfId !== String(selfId) || decision.chatKey !== chatKey) fail('STICKER_SCOPE_CHANGED', '本轮 QQ 账号或会话已变化');
  // 工具点名 / 用户点名的表情属于"明确请求"：不看档位、不看概率、不看最近十条配额，
  // 也不受表情总开关影响——库里存着的图任何时候都能发出去。限频、去重与记账仍由发送层负责。
  if (decision.explicit === true) return true;
  if (decision.attempted) fail('STICKER_ALREADY_ATTEMPTED', '本轮已经提交过一张表情，不能换工具或重试再发');
  const tier = stickerTier(sticker);
  if (!tier.enabled) fail('STICKER_DISABLED', '表情发送总开关已关闭');
  // The conversation grants this only from the current incoming message. Tool arguments cannot opt in.
  if (decision.requested === true) return true;
  if (!tier.probability || !decision.eligible || !(decision.roll < tier.probability)) {
    fail('STICKER_NOT_SELECTED', '本轮没有主动配图许可');
  }
  const cap = Math.min(TIERS[decision.tier]?.cap ?? 0, tier.cap);
  if (recentBotMessages(history, { selfId, chatKey }).slice(-9).filter(isSticker).length + 1 > cap) {
    fail('STICKER_WINDOW_LIMIT', '主动发送后最近十条机器人消息的表情数将超过当前档位上限');
  }
  return true;
}

export function reserveStickerDispatch(decision, context) {
  checkStickerDispatch(decision, context);
  decision.attempted = true;
}

export function stickerDecisionHint(decision, sticker) {
  const tier = stickerTier(sticker);
  const label = '【本轮表情许可】';
  if (!tier.enabled) return label + '表情发送总开关已关闭。';
  if (decision?.attempted) return label + '本轮已提交一张表情，请等待结果。';
  if (decision?.requested === true) {
    return label + '已收到明确请求，本轮许可发送一张表情。按对方指定的来源或主题选图，使用可用的发送工具。';
  }
  if (decision?.eligible && decision.roll < tier.probability) {
    return label + '本轮可按语境主动配一张表情，发送前仍检查最近十条上限。';
  }
  return label + '本轮没有主动配图许可。照常处理文字、看图和附件，无需在聊天中汇报此判定。';
}
