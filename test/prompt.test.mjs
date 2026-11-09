/**
 * lib/prompt.js 的单测：只验证 section 的注册行为，不启动 DSH，也不依赖任何
 * @deepseek-ai 包。
 *
 * 不测提示词文本：文案怎么改写都该允许，钉住句子的断言只会在无关紧要的编辑上
 * 报红。“这段文本真的进了模型看到的提示词”留到隔离 profile 里验证。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { GIT_BASH_PROMPT, installGitBashPrompt, SECTION_NAME } from '../lib/prompt.js';

/**
 * 宿主 systemPrompt 服务的最小实现。
 *
 * orders 模拟宿主的 SECTION_ORDERS 表：表里没有的名字返回 undefined，与真服务一致。
 */
function fakePrompt({ orders = { TOOL_BASH: 1000 } } = {}) {
  const sections = [];
  return {
    sections,
    getSectionOrder: (name) => orders[name],
    section(section) {
      sections.push(section);
      // 与宿主一致：返回的撤销器把这一条从注册表里移除。
      return () => sections.splice(sections.indexOf(section), 1);
    },
  };
}

/** 插件 context 的最小实现：effect 立刻执行并按标签记账。 */
function fakeCtx({ prompt, logger } = {}) {
  const effects = [];
  return {
    effects,
    logger,
    get(name) {
      return name === 'systemPrompt' ? prompt : undefined;
    },
    effect(execute, label) {
      effects.push(label);
      return execute();
    },
  };
}

describe('SECTION_NAME', () => {
  it('不与官方的 tool:bash 重名', () => {
    // 重名会让宿主的 section() 抛 already registered，插件跟着挂不上。
    assert.notEqual(SECTION_NAME, 'tool:bash');
  });
});

describe('installGitBashPrompt', () => {
  it('在 win32 上用宿主给的 TOOL_BASH 位置注册一段 section', () => {
    // 位置故意不取 1000，确保实现没有写死数字。
    const prompt = fakePrompt({ orders: { TOOL_BASH: 1012 } });
    const ctx = fakeCtx({ prompt });

    const dispose = installGitBashPrompt(ctx, { platform: 'win32' });

    assert.equal(prompt.sections.length, 1);
    assert.equal(prompt.sections[0].name, SECTION_NAME);
    assert.equal(prompt.sections[0].order, 1012);
    assert.equal(prompt.sections[0].text, GIT_BASH_PROMPT);
    assert.equal(ctx.effects.length, 1);
    assert.equal(typeof dispose, 'function');
  });

  it('非 win32 平台不注册', () => {
    for (const platform of ['linux', 'darwin', 'freebsd', 'android']) {
      const prompt = fakePrompt();
      const ctx = fakeCtx({ prompt });

      assert.equal(installGitBashPrompt(ctx, { platform }), undefined);
      assert.deepEqual(prompt.sections, []);
      assert.deepEqual(ctx.effects, []);
    }
  });

  it('宿主没有 systemPrompt 服务时安静跳过', () => {
    const ctx = fakeCtx({ prompt: undefined });

    assert.equal(installGitBashPrompt(ctx, { platform: 'win32' }), undefined);
    assert.deepEqual(ctx.effects, []);
  });

  it('分区表里没有 TOOL_BASH 时用兜底 order 照常注册，并记一条警告', () => {
    const prompt = fakePrompt({ orders: {} });
    const warnings = [];
    const ctx = fakeCtx({ prompt, logger: { warn: (message) => warnings.push(message) } });

    installGitBashPrompt(ctx, { platform: 'win32' });

    // 兜底值是 SECTION_ORDERS.TOOL_BASH 的历史值，位置可能不准，但提示词不能丢；
    // 位置是猜的这件事必须留在日志里，否则分区表改名后没人能发现。
    assert.equal(prompt.sections.length, 1);
    assert.equal(prompt.sections[0].order, 1000);
    assert.equal(warnings.length, 1);
  });
});
