// 由《最新系统提示词.txt》逐行生成 resources/app/src/conversation-instructions.js。
// 用法：node tools/gen-conversation-instructions.mjs <提示词.txt> [输出文件]
// 改文案请改源文件后重跑；手工改生成物会在下次重跑时被覆盖。

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const SRC = process.argv[2];
const OUT = process.argv[3] || fileURLToPath(new URL('../resources/app/src/conversation-instructions.js', import.meta.url));
const raw = fs.readFileSync(SRC, 'utf8').replace(/\r\n/g, '\n');
const lines = raw.split('\n');

const heads = [];
lines.forEach((t, i) => { if (/^# /.test(t)) heads.push(i); });
const sections = heads.map((start, k) => {
  const end = k + 1 < heads.length ? heads[k + 1] : lines.length;
  const slice = lines.slice(start, end);
  while (slice.length && (slice[slice.length - 1].trim() === '' || slice[slice.length - 1].trim() === '---')) slice.pop();
  while (slice.length && slice[0].trim() === '') slice.shift();
  return slice;
});
if (sections.length !== 6) throw new Error('expected 6 sections, got ' + sections.length);

const role = sections[0].slice();
const security = sections[1].slice();
const readFirst = sections[2].slice();
const participation = sections[3].slice();
const persona = sections[4].slice();
const tools = sections[5].slice();

const rep = (arr, from, to) => {
  const i = arr.findIndex(t => t.includes(from));
  if (i < 0) throw new Error('marker anchor not found: ' + from);
  arr[i] = arr[i].split(from).join(to);
};
rep(role, '我是「Aino」', '我是「{{NAME}}」');
const pIdx = participation.findIndex(t => t.startsWith('我的参与度风格：'));
if (pIdx < 0) throw new Error('participation line missing');
participation[pIdx] = '{{PARTICIPATION}}';

const p1 = persona.findIndex(t => t.startsWith('## 1. '));
const p2 = persona.findIndex(t => t.startsWith('## 2. '));
if (p1 < 0 || p2 < 0) throw new Error('persona subheads missing');
const defaultPersona = persona.slice(p1 + 1, p2).filter(t => t.trim() !== '');
const personaTpl = persona.slice(0, p1 + 1).concat(['{{PERSONA}}'], persona.slice(p2));

rep(tools, '主动配图为「经常发」，每轮概率 70%，发送后的最近十条机器人消息中表情最多 8 张。', '{{STICKER}}');
rep(tools, '用消息前的 #数字调用 get_message_images 查看消息里的图片、动图或表情。已收藏的表情用 get_sticker_image 查看。', '{{VISION}}');
rep(tools, '或群友直接发 URL 询问内容时。', '或群友直接发 URL 询问内容时。{{SEARCH}}');

const arr = (name, list) => 'const ' + name + ' = [\n' + list.map(t => '  ' + JSON.stringify(t)).join(',\n') + '\n];\n';
const out = [
  "import { stickerTier } from './sticker-policy.js';",
  '',
  '// 逐行生成：改文案请改源文件后重跑生成脚本，',
  '// 六个一级段与源文件逐字一致，只有 {{NAME}} / {{PARTICIPATION}} / {{PERSONA}} /',
  '// {{STICKER}} / {{VISION}} / {{SEARCH}} 六处按运行时配置替换。',
  arr('ROLE', role),
  arr('SECURITY', security),
  arr('READ_FIRST', readFirst),
  arr('PARTICIPATION', participation),
  arr('PERSONA', personaTpl),
  arr('TOOLS', tools),
  "export const DEFAULT_PERSONA = [\n" + defaultPersona.map(t => '  ' + JSON.stringify(t)).join(',\n') + "\n].join('\\n');",
  '',
  'function fill(text, vars) {',
  "  return Object.entries(vars).reduce((acc, [key, value]) => acc.split('{{' + key + '}}').join(String(value)), text);",
  '}',
  '',
  'export function conversationInstructions({ botName, roleText, participationStyle, override, ...capabilities } = {}) {',
  "  const name = String(botName || '').trim() || 'Aino';",
  '  const tier = stickerTier(capabilities.stickerSettings);',
  '  const sticker = tier.enabled && tier.probability > 0',
  "    ? '主动配图为「' + tier.label + '」，每轮概率 ' + Math.round(tier.probability * 100) + '%，发送后的最近十条机器人消息中表情最多 ' + tier.cap + ' 张。'",
  "    : tier.enabled ? '当前档位不主动配图。' : '当前表情发送总开关已关闭。';",
  '  const vars = {',
  '    NAME: name,',
  "    PARTICIPATION: String(participationStyle || ''),",
  "    PERSONA: String(roleText || '').trim() || DEFAULT_PERSONA,",
  '    STICKER: sticker,',
  "    VISION: capabilities.vision === false ? '当前视觉能力关闭，图片和表情仅显示类型。' : '用消息前的 #数字调用 get_message_images 查看消息里的图片、动图或表情。已收藏的表情用 get_sticker_image 查看。',",
  "    SEARCH: capabilities.search === false ? '本轮搜索配置关闭，按当前可用能力回答。' : ''",
  '  };',
  "  const roleSection = fill(ROLE.join('\\n'), vars);",
  "  const toolsSection = fill(TOOLS.join('\\n'), vars);",
  '  if (override) {',
  "    const isolationAt = roleSection.indexOf('## 2. 输出与行动隔离');",
  "    const isolation = isolationAt >= 0 ? roleSection.slice(isolationAt) : '';",
  "    return [SECURITY.join('\\n'), String(override), isolation, READ_FIRST.join('\\n'), toolsSection].join('\\n\\n---\\n\\n');",
  '  }',
  '  return [',
  '    roleSection,',
  "    SECURITY.join('\\n'),",
  "    READ_FIRST.join('\\n'),",
  "    fill(PARTICIPATION.join('\\n'), vars),",
  "    fill(PERSONA.join('\\n'), vars),",
  '    toolsSection',
  "  ].join('\\n\\n---\\n\\n');",
  '}',
  ''
].join('\n');

fs.writeFileSync(OUT, out, 'utf8');
console.log('written bytes=' + out.length + ' personaLines=' + defaultPersona.length + ' sections=' + [role, security, readFirst, participation, personaTpl, tools].map(s => s.length).join('/'));