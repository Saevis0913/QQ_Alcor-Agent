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
  const out = conversationInstructions({ botName: 'Aino', participationStyle: '你的参与度风格：安静型。' });
  let at = -1;
  for (const heading of HEADINGS) {
    const next = out.indexOf(heading);
    assert.ok(next > at, heading + ' 缺失或顺序错位');
    at = next;
  }
});

test('人设留空时注入内置 Aino 人设', () => {
  const out = conversationInstructions({ botName: 'Aino', roleText: '' });
  assert.match(out, /## 1\. 性格特征（Aino/);
  assert.ok(out.includes(DEFAULT_PERSONA));
});

test('填写人设后替换默认人设正文', () => {
  const out = conversationInstructions({ botName: '阿尔可', roleText: '你是一只猫娘。' });
  assert.ok(out.includes('你是一只猫娘。'));
  assert.ok(!out.includes(DEFAULT_PERSONA), '自定义人设时不应保留默认人设正文');
  assert.match(out, /你是「阿尔可」/);
});

test('自定义提示词模式不再拼接默认人设段', () => {
  const out = conversationInstructions({ botName: 'Aino', override: '你是{roleText}。' });
  assert.ok(out.includes('你是{roleText}。'));
  assert.ok(!out.includes('# Persona & Expression'));
});

test('buildSystemPrompt 把 roleText 传进人设段且不重复', () => {
  const out = buildSystemPrompt({ persona: { botName: 'Aino', roleText: '你是一只猫娘。', participation: 'low' } });
  assert.ok(out.includes('你是一只猫娘。'));
  assert.ok(!out.includes(DEFAULT_PERSONA));
  assert.ok(out.includes('安静型'));
  assert.equal(out.split('你是一只猫娘。').length - 1, 1, '人设正文重复注入');
});

test('自定义提示词写了 {roleText} 时人设只出现一次', () => {
  const out = buildSystemPrompt({
    persona: { botName: 'Aino', roleText: '你是一只猫娘。', systemPromptOverride: '你是{roleText}，别重复。' }
  });
  assert.equal(out.split('你是一只猫娘。').length - 1, 1);
});
