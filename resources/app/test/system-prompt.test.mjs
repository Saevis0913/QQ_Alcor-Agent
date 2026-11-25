import test from 'node:test';
import assert from 'node:assert/strict';
import { conversationInstructions, DEFAULT_PERSONA } from '../src/conversation-instructions.js';
import { buildSystemPrompt } from '../src/prompt.js';

const HEADINGS = [
  '# Role & Context',
  '# Security & Boundaries',
  '# Read First',
  '# Participation Logic',
  '# Persona & Expression',
  '# Tool Protocols'
];

test('默认系统提示按固定顺序拼装六段', () => {
  const out = conversationInstructions({ botName: 'Aino', participationStyle: '我的参与度风格：安静型。' });
  let at = -1;
  for (const heading of HEADINGS) {
    const next = out.indexOf(heading);
    assert.ok(next > at, heading + ' 缺失或顺序错位');
    at = next;
  }
});

test('系统提示用第一人称，名字取自 botName', () => {
  const out = conversationInstructions({ botName: 'Aino', roleText: '' });
  assert.ok(out.includes('我是「Aino」'));
  assert.ok(!out.includes('你是「'));
  const named = conversationInstructions({ botName: '阿尔可', roleText: '' });
  assert.ok(named.includes('我是「阿尔可」'));
});

test('人设留空时注入内置 Aino 人设', () => {
  const out = conversationInstructions({ botName: 'Aino', roleText: '' });
  assert.match(out, /## 1\. 我的性格特征/);
  assert.ok(out.includes(DEFAULT_PERSONA));
  assert.ok(out.includes('活泼热情'));
  assert.ok(out.includes('识趣靠谱'));
});

test('填写人设后替换默认人设正文', () => {
  const out = conversationInstructions({ botName: 'Aino', roleText: '我是猫娘，说话带喵。' });
  assert.ok(out.includes('我是猫娘，说话带喵。'));
  assert.ok(!out.includes(DEFAULT_PERSONA), '自定义人设时不应保留默认人设正文');
});

test('自定义提示词模式不再拼接默认人设段', () => {
  const out = conversationInstructions({ botName: 'Aino', override: '你是{roleText}。' });
  assert.ok(out.includes('你是{roleText}。'));
  assert.ok(!out.includes('# Persona & Expression'));
  assert.ok(out.includes('## 2. 输出与行动隔离'));
});

test('能力关闭时替换视觉与搜索说明', () => {
  const off = conversationInstructions({ botName: 'Aino', vision: false, search: false });
  assert.ok(off.includes('当前视觉能力关闭'));
  assert.ok(off.includes('本轮搜索配置关闭'));
  const on = conversationInstructions({ botName: 'Aino', vision: true, search: true });
  assert.ok(!on.includes('当前视觉能力关闭'));
});

test('buildSystemPrompt 把 roleText 传进人设段且不重复', () => {
  const out = buildSystemPrompt({ persona: { botName: 'Aino', roleText: '我是猫娘，说话带喵。', participation: 'low' } });
  assert.ok(out.includes('我是猫娘，说话带喵。'));
  assert.ok(!out.includes(DEFAULT_PERSONA));
  assert.ok(out.includes('安静型'));
  assert.equal(out.split('我是猫娘，说话带喵。').length - 1, 1, '人设正文重复注入');
});

test('自定义提示词写了 {roleText} 时人设只出现一次', () => {
  const out = buildSystemPrompt({
    persona: { botName: 'Aino', roleText: '我是猫娘，说话带喵。', systemPromptOverride: '你是{roleText}，别重复。' }
  });
  assert.equal(out.split('我是猫娘，说话带喵。').length - 1, 1);
});
