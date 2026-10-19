import test from 'node:test';
import assert from 'node:assert/strict';
import {classifyModelVendor, VENDOR_META, VENDOR_ORDER} from '../src/services/codebuddy/config.js';

/**
 * 厂商归类决定面板和控制台的分组展示。
 * GPT 单独成组是明确要求：它是国际站主力，且价格跨度大（x0.14 ~ x3.31）。
 */

test('GPT 系单独成组', () => {
    for (const id of ['gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.5', 'gpt-5.4', 'gpt-4.1', 'GPT-5']) {
        assert.equal(classifyModelVendor(id), 'gpt', `${id} 应归到 gpt`);
    }
});

test('GPT 系不再混在「其他」里', () => {
    assert.notEqual(classifyModelVendor('gpt-5.5'), 'others');
});

test('Gemini 单独成组', () => {
    assert.equal(classifyModelVendor('gemini-3.5-flash'), 'gemini');
    assert.equal(classifyModelVendor('gemini-3.0-pro'), 'gemini');
});

test('原有厂商归类不受影响', () => {
    assert.equal(classifyModelVendor('deepseek-v4.1-flash'), 'deepseek');
    assert.equal(classifyModelVendor('glm-5.3'), 'zhipu');
    assert.equal(classifyModelVendor('kimi-k3'), 'moonshot');
    assert.equal(classifyModelVendor('minimax-m3.1-flash'), 'minimax');
    assert.equal(classifyModelVendor('hy3'), 'hunyuan');
    assert.equal(classifyModelVendor('hy4-preview'), 'hunyuan');
    assert.equal(classifyModelVendor('hunyuan-chat'), 'hunyuan');
});

test('档位别名留在「其他」——它们不是具体厂商的模型', () => {
    // fast/balanced/primary/deep/default 是国际站的档位别名，
    // 背后指向的模型由上游决定，不能硬归到 GPT
    for (const id of ['fast-model', 'balanced-model', 'primary-model', 'deep-model', 'default-model']) {
        assert.equal(classifyModelVendor(id), 'others', `${id} 应留在 others`);
    }
});

test('认不出的模型归到 others，不崩', () => {
    assert.equal(classifyModelVendor('step-5-preview'), 'others');
    assert.equal(classifyModelVendor('space-bunny'), 'others');
    assert.equal(classifyModelVendor(''), 'others');
    assert.equal(classifyModelVendor(null), 'others');
    assert.equal(classifyModelVendor(undefined), 'others');
});

test('大小写不敏感', () => {
    assert.equal(classifyModelVendor('GPT-5.5'), 'gpt');
    assert.equal(classifyModelVendor('DeepSeek-V4'), 'deepseek');
    assert.equal(classifyModelVendor('GLM-5.3'), 'zhipu');
});

test('VENDOR_ORDER 覆盖 VENDOR_META 的全部键，且无重复', () => {
    assert.equal(VENDOR_ORDER.length, Object.keys(VENDOR_META).length);
    assert.equal(new Set(VENDOR_ORDER).size, VENDOR_ORDER.length);
    for (const key of VENDOR_ORDER) {
        assert.ok(VENDOR_META[key], `${key} 缺少 VENDOR_META`);
        assert.ok(typeof VENDOR_META[key].label === 'string' && VENDOR_META[key].label.length > 0);
    }
});

test('GPT 排在 DeepSeek 之后、其他厂商之前', () => {
    const idx = (k) => VENDOR_ORDER.indexOf(k);
    assert.ok(idx('gpt') > idx('deepseek'));
    assert.ok(idx('gpt') < idx('others'));
    assert.ok(idx('gpt') < idx('zhipu'));
});

test('others 永远排在最后（兜底分组）', () => {
    assert.equal(VENDOR_ORDER[VENDOR_ORDER.length - 1], 'others');
});

test('每个分类器输出都能在 VENDOR_META 里找到', () => {
    const samples = ['gpt-5.5', 'gemini-3.5-flash', 'deepseek-v4.1-flash', 'glm-5.3', 'kimi-k3', 'minimax-m3', 'hy3', 'unknown-x'];
    for (const id of samples) {
        const vendor = classifyModelVendor(id);
        assert.ok(VENDOR_META[vendor], `${id} → ${vendor} 不在 VENDOR_META 中`);
    }
});
