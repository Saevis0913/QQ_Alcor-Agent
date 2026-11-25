import { normalizeMessageList } from '../../src/util.js';
import { mdToPlain } from '../../src/md-to-plain.js';

const textSendTools = new Set(['send_message', 'send_to', '发送消息', '发送到指定会话']);

const openings = [
  '这是一个(?:非常)?(?:深刻|敏锐|绝妙|发人深省)的问题',
  '好问题', '你抓住了核心', '你问到了点子上', '很有意思的视角',
  '好的[，,][ \t]*没问题', '当然可以(?=[！!][ \t]*下面为你)', '很高兴能为你解答',
  '我完全理解你的(?:感受|焦虑|纠结)', '听起来你现在很不容易',
  '别(?:慌|担心)[，,][ \t]*我来帮你', '懂了[！!][ \t]*这就给你安排',
  '这个我认', '我错了[，,][ \t]*彻底错了', '你说[，,][ \t]*我做',
  '不狡辩[，,][ \t]*直接改', '行[，,][ \t]*我闭嘴', '我接住这记直球', '被你一巴掌打醒了',
  '您说得完全正确', '您指出的非常对', '确实如此[，,][ \t]*我刚才考虑不周',
  '非常抱歉给您带来了困扰', '感谢您的指正',
  '让我们深入(?:探讨|探索)一下', '显而易见', '毋庸置疑', '毫无疑问',
  '简而言之', '总而言之', '归根结底', '客观来看', '先说结论', '核心要点如下',
  '综合来看', '总体而言', '综上所述', '说白了', '本质上', '说到底',
  '残酷的真相是', '扎心的是', '长话短说', '咱们别整那些虚的', '不装了[，,][ \t]*摊牌了',
  '老实讲[，,][ \t]*这事挺魔幻的', '哈哈[，,][ \t]*你这问题够尖锐的',
  '嗯[，,][ \t]*让我想想', '等等[，,][ \t]*不对', '好[，,][ \t]*这下理顺了'
];
const opening = new RegExp(
  '^[\\s]*(?:(?:值得注意的是|需要说明的是|不可否认的是|下面为你(?:整理了|列出))[，,：:]?|(?:'
    + openings.join('|') + ')(?:[。！？!?，,：:]+|(?=\\r?\\n|$)))[\\s]*',
  'u'
);
const closing = /(^|[。！？!?；;，,\n])[ \t\r\n]*(?:(?:希望(?:这些|以上)?(?:建议|内容|信息)能帮到你|希望(?:对你有帮助|能帮到你)|如果你还有(?:任何)?问题[，,][ \t]*(?:随时告诉我|可以随时告诉我)|祝你(?:生活愉快|一切顺利)|是不是清晰多了|你觉得呢)[。！？!?～~…]*[ \t\r\n]*)$/u;

// 只替换辨识度高的搭配。单独出现的技术术语留给上下文。
const builtInWords = new Map([
  ['话虽如此', '不过'],
  ['换句话说', '也就是说'],
  ['与此同时', '同时'],
  ['具有重要的现实意义', '有实际用处'],
  ['结合自身实际情况', '看自己遇到的情况'],
  ['值得深思', '值得再想想'],
  ['为团队赋能', '给团队提供支持'],
  ['持续为企业赋能', '持续为企业提供支持'],
  ['作为重要抓手', '作为主要办法'],
  ['实现链路闭环', '把流程从头到尾跑通'],
  ['打通业务链路', '把各个业务环节接起来'],
  ['对齐目标', '统一目标'],
  ['认知对齐', '统一理解'],
  ['需求颗粒度太粗', '需求拆得还不够细'],
  ['这是一把双刃剑，有利也有弊', '这有好有坏'],
  ['嘴角勾起一抹不易察觉的弧度', '微微笑了一下'],
  ['心里咯噔一下', '心头一紧'],
  ['空气仿佛凝固了', '四周像是突然静了下来']
]);

// 按从左到右的顺序寻找应原样保留的片段，再处理它们之间的普通文本。
const protectedText = new RegExp([
  /(?<!`)(?<fence>`{3,})(?!`)[\s\S]*?(?:(?<!`)\k<fence>(?!`)|(?![\s\S]))/,
  /^[ \t]*(?<tilde>~{3,})(?!~)[^\r\n]*(?:\r?\n|$)[\s\S]*?(?:^[ \t]*\k<tilde>~*[ \t]*(?:\r?\n|$)|(?![\s\S]))/,
  /(?<!`)(?<inline>`{1,2})(?!`)[^\r\n]*?(?:(?<!`)\k<inline>(?!`)|(?=\r?$))/,
  /^[ \t]*>[^\r\n]*/,
  /!?\[[^\]\r\n]*\](?:\((?:\\.|[^\\()\r\n]|\([^()\r\n]*\))*\)|\[[^\]\r\n]*\])/,
  /\[CQ:[^\]\r\n]*\]/,
  /(?:https?:\/\/|www\.|mailto:|[a-z]:[\\/]|\\\\)[^\s<>"“”‘’「」『』《》，。！？；：、]+/i,
  /“[^”]*”|‘[^’]*’|「[^」]*」|『[^』]*』|《[^》]*》|【[^】]*】|"[^"\r\n]*"|'[^'\r\n]*'/
].map(pattern => pattern.source).join('|'), 'gimu');

function compileWords(replacements) {
  const keys = [...replacements.keys()].sort((a, b) => b.length - a.length);
  const alternatives = keys.map(word => word.replace(/[.*+?^$(){}|[\]\\]/g, '\\$&'));
  return { pattern: new RegExp(alternatives.join('|'), 'gu'), replacements };
}

const defaultWords = compileWords(builtInWords);

function wordsFor(extra) {
  if (typeof extra !== 'string' || !extra.trim()) return defaultWords;
  const replacements = new Map(builtInWords);
  for (const item of extra.split('|', 40)) {
    const equals = item.indexOf('=');
    if (equals < 1) continue;
    const from = item.slice(0, equals).trim();
    const to = item.slice(equals + 1).trim();
    if (from && to && from.length <= 80 && to.length <= 120) replacements.set(from, to);
  }
  return compileWords(replacements);
}

function rewritePlainText(text, dictionary, atStart, atEnd) {
  if (atStart) {
    while (opening.test(text)) text = text.replace(opening, '');
  }
  if (atEnd) {
    while (closing.test(text)) {
      text = text.replace(closing, (_match, boundary) => /[。！？!?]/u.test(boundary) ? boundary : '');
    }
  }
  return text.replace(dictionary.pattern, word => dictionary.replacements.get(word))
    .replace(/！{3,}|!{3,}/g, run => run[0]);
}

function rewriteText(text, dictionary) {
  const parts = [];
  let end = 0;
  for (const match of text.matchAll(protectedText)) {
    parts.push(rewritePlainText(text.slice(end, match.index), dictionary, end === 0, false), match[0]);
    end = match.index + match[0].length;
  }
  parts.push(rewritePlainText(text.slice(end), dictionary, end === 0, true));
  return parts.join('').trim();
}

function isSendable(text) {
  const plain = mdToPlain(text);
  return plain !== '' && plain !== '[object Object]';
}

function rewriteSendCall(call, dictionary) {
  const action = call.function;
  const raw = action.arguments;
  let args;
  let original;
  try {
    args = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!args || !Object.hasOwn(args, 'messages')) return;
    original = normalizeMessageList(args.messages);
  } catch {
    // 让原工具记录它本来就会报告的参数错误。
    return;
  }
  const rewritten = original.map(text => {
    const next = rewriteText(text, dictionary);
    return next && next !== text && !isSendable(next) ? text : next;
  }).filter(Boolean);
  if (rewritten.length === original.length
    && rewritten.every((text, index) => text === original[index])) return;
  // 发言工具还会转换 Markdown 并跳过空项。整批失去可发送正文时沿用原参数。
  if (!rewritten.some(isSendable)) return;
  const next = { ...args, messages: rewritten };
  action.arguments = typeof raw === 'string' ? JSON.stringify(next) : next;
}

const style = {
  id: 'plain-replies-style',
  title: '自然表达规范',
  priority: 45,
  content: [
    '以下表达规范适用于你要发给对方的文字消息。延续既有的人设和称呼。照实回答身份问题。必要的限制、风险和求助建议要说清楚。',
    '开头直接说事。省去机械开场、夸赞和客服播报，比如“好问题”“你抓住了核心”“接下来我将为你”。别用“我完全理解你的感受”“抱抱你”敷衍对方。',
    '平实纠错。指出错在哪里、改成什么。别先附和或表演认错。需要表达限制时直说具体原因，别用“作为一个人工智能”或“以上内容仅供参考”之类的套话。',
    '少用翻译腔、公文腔和机械接话。不靠“值得注意的是”“从以下几个维度”“综上所述”串起全文。先后顺序或对照真有用时再标出来。',
    '别装深刻、硬玩梗或堆商业黑话。遇到“赋能、闭环、抓手、颗粒度、共振、同频、情绪价值”时，尽量直接说谁做什么、做到哪一步。术语在专业语境中按原义使用。',
    '用自然的近义说法，例如把“与此同时”换成“同时”，把“对齐目标”换成“统一目标”。别让换词改变事实、态度或专业术语的含义。',
    '少套对仗和三段排比。遇到“不是……而是……”“与其说……不如说……”这类强行升华的句式，直接说判断和理由。事实上的否定或对照要交代清楚。收尾省去鸡汤、“希望这些建议能帮到你”和无意义的追问。',
    '角色扮演、创作和闲聊时，避免反复写嘴角、瞳孔、喉结、凝固的空气等模板描写。语气词、波浪号、感叹号和口头禅按人设与场合使用。正文只放给对方看的话。',
    '排版跟着内容走。简短问答用自然段落，少用装饰性引号、破折号、Emoji 列表和刻意的短句分行。只有步骤确实需要时才列清单。',
    '优先给事实、数量、例子或下一步。保留逐字引用、链接和代码。说完就停。'
  ].join('\n')
};

let api;

export function setup(skillApi) {
  api = skillApi;
}

export function promptSections() {
  return api.config().promptEnabled === false ? [] : [style];
}

export const hooks = {
  'after-response'({ response }) {
    const calls = response?.message?.tool_calls;
    if (!Array.isArray(calls)) return;
    const config = api.config();
    if (config.rewriteEnabled === false) return;
    const sends = calls.filter(call => textSendTools.has(call?.function?.name));
    if (!sends.length) return;
    const dictionary = wordsFor(config.extraReplacements);
    for (const call of sends) rewriteSendCall(call, dictionary);
  }
};
