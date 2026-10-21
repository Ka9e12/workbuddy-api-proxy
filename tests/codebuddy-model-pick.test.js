import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

/**
 * 模型勾选列表的联动逻辑
 *
 * 分组框（厂商标题左边）与组内单个模型必须双向一致：
 * - 勾分组框 → 组内全部勾上
 * - 取消分组框 → 组内全部取消
 * - 手点组内几个 → 分组框变半选
 * - 组内全勾 → 分组框自动全选
 *
 * 直接从模板里抽出这三个函数，在最小 DOM 替身上跑。
 * 这样测的是真正会部署到浏览器的那份代码，而不是复制粘贴的副本。
 */

const html = readFileSync(new URL('../src/templates/codebuddy-admin.html', import.meta.url), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];

/** 从模板脚本里按函数名截出完整定义（靠花括号配平找结尾） */
function extractFunction(name) {
    const marker = `function ${name}`;
    const start = script.indexOf(marker);
    if (start < 0) throw new Error(`模板里找不到 ${marker}`);
    let depth = 0;
    let seenBrace = false;
    for (let i = start; i < script.length; i++) {
        if (script[i] === '{') {
            depth++;
            seenBrace = true;
        } else if (script[i] === '}') {
            depth--;
            if (seenBrace && depth === 0) return script.slice(start, i + 1);
        }
    }
    throw new Error(`${marker} 没有闭合`);
}

const FN_SOURCE = [
    extractFunction('getSelectedProbeModels'),
    extractFunction('updateProbeSelection'),
    extractFunction('toggleVendorModels')
].join('\n\n');

/** 极简 checkbox：只要 checked / indeterminate / data-vendor */
class FakeCheckbox {
    constructor({value = '', checked = false, attrs = {}} = {}) {
        this.value = value;
        this.checked = checked;
        this.indeterminate = false;
        this._attrs = attrs;
    }
    getAttribute(name) {
        return this._attrs[name] == null ? null : this._attrs[name];
    }
}

/**
 * 极简 document：只实现这三个函数用到的那几个查询
 * @param {FakeCheckbox[]} modelBoxes
 * @param {FakeCheckbox[]} vendorBoxes
 * @param {FakeCheckbox} allBox
 */
function makeDocument(modelBoxes, vendorBoxes, allBox) {
    return {
        querySelectorAll(selector) {
            if (selector === 'input.model-pick:checked') return modelBoxes.filter((b) => b.checked);
            const byVendor = selector.match(/^input\.model-pick\[data-vendor="([^"]+)"\]$/);
            if (byVendor) return modelBoxes.filter((b) => b.getAttribute('data-vendor') === byVendor[1]);
            if (selector === 'input.model-pick') return modelBoxes;
            if (selector === 'input.vendor-pick') return vendorBoxes;
            return [];
        },
        getElementById(id) {
            if (id === 'modelPickCount') return {textContent: ''};
            if (id === 'modelTestStartBtn') return {disabled: false, textContent: ''};
            if (id === 'modelTestCostHint') return {textContent: ''};
            if (id === 'modelPickAll') return allBox;
            return null;
        }
    };
}

/**
 * 按 renderModelPicker 的结构造一份 DOM，并求出三个函数
 * @param {Object<string,string[]>} modelIdsByVendor
 * @param {Set<string>} [preChecked]
 * @param {Set<string>} [blocked] - 标成「已知不可用」（灰色）的模型 id
 */
function setup(modelIdsByVendor, preChecked = new Set(), blocked = new Set()) {
    const modelBoxes = [];
    const vendorBoxes = [];
    for (const [vendor, ids] of Object.entries(modelIdsByVendor)) {
        for (const id of ids) {
            modelBoxes.push(
                new FakeCheckbox({
                    value: id,
                    checked: preChecked.has(id),
                    attrs: {'data-vendor': vendor, 'data-blocked': blocked.has(id) ? '1' : '0'}
                })
            );
        }
        vendorBoxes.push(new FakeCheckbox({attrs: {'data-vendor': vendor}}));
    }
    const allBox = new FakeCheckbox();
    const doc = makeDocument(modelBoxes, vendorBoxes, allBox);

    const api = new Function(
        'document',
        `${FN_SOURCE}\n\nreturn {getSelectedProbeModels, updateProbeSelection, toggleVendorModels};`
    )(doc);

    const boxesOf = (vendor) => modelBoxes.filter((b) => b.getAttribute('data-vendor') === vendor);
    const vendorBox = (vendor) => vendorBoxes.find((b) => b.getAttribute('data-vendor') === vendor);
    return {api, modelBoxes, vendorBoxes, allBox, boxesOf, vendorBox};
}

const VENDORS = {
    deepseek: ['deepseek-v4-pro', 'deepseek-v4-flash', 'deepseek-v4.1-flash', 'deepseek-v3-2-volc'],
    zhipu: ['glm-5.3', 'glm-5.2', 'glm-5.1'],
    hunyuan: ['hy3', 'hy4-preview']
};

test('勾选厂商分组 → 组内全部被勾上，其它组不受影响', () => {
    const {api, boxesOf, vendorBox} = setup(VENDORS);
    const box = vendorBox('deepseek');
    box.checked = true;
    api.toggleVendorModels(box);

    assert.equal(boxesOf('deepseek').every((b) => b.checked), true, '4 个 deepseek 应全部勾选');
    assert.equal(boxesOf('zhipu').some((b) => b.checked), false, '其它厂商不该被连带');
    assert.equal(boxesOf('hunyuan').some((b) => b.checked), false);
    assert.equal(api.getSelectedProbeModels().length, 4);
});

test('取消厂商分组 → 组内全部取消', () => {
    const {api, boxesOf, vendorBox} = setup(VENDORS, new Set(VENDORS.deepseek));
    const box = vendorBox('deepseek');
    box.checked = false;
    api.toggleVendorModels(box);

    assert.equal(boxesOf('deepseek').some((b) => b.checked), false);
    assert.equal(api.getSelectedProbeModels().length, 0);
});

test('手点组内单个模型 → 分组框变半选', () => {
    const {api, modelBoxes, vendorBox} = setup(VENDORS);
    modelBoxes.find((b) => b.value === 'glm-5.3').checked = true;
    api.updateProbeSelection();

    const zhipu = vendorBox('zhipu');
    assert.equal(zhipu.checked, false, '只勾了一个不该显示全选');
    assert.equal(zhipu.indeterminate, true, '应显示半选');
    assert.equal(api.getSelectedProbeModels().length, 1);
});

test('组内全勾后 → 分组框自动变全选', () => {
    const {api, boxesOf, vendorBox} = setup(VENDORS);
    for (const b of boxesOf('hunyuan')) b.checked = true;
    api.updateProbeSelection();

    const hunyuan = vendorBox('hunyuan');
    assert.equal(hunyuan.checked, true);
    assert.equal(hunyuan.indeterminate, false);
});

test('分组之间互不干扰', () => {
    const {api, boxesOf, vendorBox} = setup(VENDORS);
    const zhipu = vendorBox('zhipu');
    zhipu.checked = true;
    api.toggleVendorModels(zhipu);

    assert.equal(boxesOf('zhipu').every((b) => b.checked), true);
    assert.equal(boxesOf('deepseek').some((b) => b.checked), false);
    assert.equal(boxesOf('hunyuan').some((b) => b.checked), false);
});

test('记住的勾选能正确还原分组框状态', () => {
    const {api, vendorBox} = setup(VENDORS, new Set(VENDORS.zhipu));
    api.updateProbeSelection();
    assert.equal(vendorBox('zhipu').checked, true);
});

test('组内清空后分组框回到未选', () => {
    const {api, boxesOf, vendorBox} = setup(VENDORS, new Set(VENDORS.hunyuan));
    for (const b of boxesOf('hunyuan')) b.checked = false;
    api.updateProbeSelection();

    const hunyuan = vendorBox('hunyuan');
    assert.equal(hunyuan.checked, false);
    assert.equal(hunyuan.indeterminate, false);
});

test('全选框随分组勾选联动', () => {
    const {api, allBox, vendorBox} = setup(VENDORS);
    assert.equal(allBox.checked, false);

    const deepseek = vendorBox('deepseek');
    deepseek.checked = true;
    api.toggleVendorModels(deepseek);
    assert.equal(allBox.indeterminate, true, '只勾一个分组时全选框应为半选');

    for (const vendor of Object.keys(VENDORS)) {
        const box = vendorBox(vendor);
        box.checked = true;
        api.toggleVendorModels(box);
    }
    assert.equal(allBox.checked, true, '全部勾选后全选框应为选中');
    assert.equal(allBox.indeterminate, false);
});

test('灰色的模型也能通过分组框勾上（复测场景）', () => {
    // 用户升级套餐后想整组重测，分组框必须能把灰色的一起勾上，
    // 否则只能一个个手点，很不合理。
    const blocked = new Set(['gpt-5.5', 'gpt-5.4']);
    const {api, boxesOf, vendorBox} = setup({gpt: ['gpt-5.5', 'gpt-5.4', 'gpt-5.6-luna']}, new Set(), blocked);

    const box = vendorBox('gpt');
    box.checked = true;
    api.toggleVendorModels(box);

    assert.equal(boxesOf('gpt').every((b) => b.checked), true, '灰色模型也要被勾上');
    assert.equal(api.getSelectedProbeModels().length, 3);
});

test('分组框的选中状态把灰色模型算进去', () => {
    // 勾上分组框后，如果分组框自己显示成半选，看起来像没生效
    const blocked = new Set(['gpt-5.5']);
    const {api, vendorBox} = setup({gpt: ['gpt-5.5', 'gpt-5.4']}, new Set(), blocked);

    const box = vendorBox('gpt');
    box.checked = true;
    api.toggleVendorModels(box);

    assert.equal(box.checked, true, '全勾上时分组框应显示全选');
    assert.equal(box.indeterminate, false, '不该显示半选');
});

test('取消分组框会把灰色模型也取消', () => {
    const blocked = new Set(['gpt-5.5']);
    const {api, boxesOf, vendorBox} = setup(
        {gpt: ['gpt-5.5', 'gpt-5.4']},
        new Set(['gpt-5.5', 'gpt-5.4']),
        blocked
    );

    const box = vendorBox('gpt');
    box.checked = false;
    api.toggleVendorModels(box);

    assert.equal(boxesOf('gpt').some((b) => b.checked), false);
    assert.equal(api.getSelectedProbeModels().length, 0);
});

test('灰色模型默认不勾，但可以单独点选', () => {
    const blocked = new Set(['gpt-5.5']);
    const {api, modelBoxes} = setup({gpt: ['gpt-5.5', 'gpt-5.4']}, new Set(), blocked);

    // 渲染时灰色的不预勾（这是 renderModelPicker 的行为，这里模拟其效果）
    assert.equal(modelBoxes.find((b) => b.value === 'gpt-5.5').checked, false);

    // 但用户手动点它是允许的
    modelBoxes.find((b) => b.value === 'gpt-5.5').checked = true;
    api.updateProbeSelection();
    assert.deepEqual(api.getSelectedProbeModels(), ['gpt-5.5']);
});
