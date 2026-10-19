import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {planArrivalWait} from '../src/services/codebuddy/growth.js';

/**
 * 定时调度相关的纯函数与脚本契约。
 * 计划任务注册本身依赖 Windows + 提权，无法在 CI 跑；改为断言脚本的文本契约。
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');

test('planArrivalWait：旅行中且到站很近 → 等待', () => {
    const now = Date.now();
    const r = planArrivalWait({state: 'traveling', arriveAt: now + 60000}, now);
    assert.equal(r.shouldWait, true);
    assert.ok(r.waitMs > 0 && r.waitMs <= 60000);
});

test('planArrivalWait：到站时间超过上限 → 不等待（交由下次触发）', () => {
    const now = Date.now();
    const r = planArrivalWait({state: 'traveling', arriveAt: now + 60 * 60 * 1000}, now);
    assert.equal(r.shouldWait, false);
    assert.equal(r.reason, 'beyond-cap');
});

test('planArrivalWait：非旅行中/已到站 → 不等待', () => {
    assert.equal(planArrivalWait({state: 'idle', arriveAt: Date.now() + 60000}).shouldWait, false);
    assert.equal(planArrivalWait({state: 'arrived'}).shouldWait, false);
    assert.equal(planArrivalWait(null).shouldWait, false);
});

test('planArrivalWait：arriveAt 为秒级时间戳也能正确处理', () => {
    const now = Date.now();
    const r = planArrivalWait({state: 'traveling', arriveAt: Math.floor((now + 60000) / 1000)}, now);
    assert.equal(r.shouldWait, true);
});

test('schedule.ps1 含关键契约：独立触发器、-StartWhenAvailable、ExecutionTimeLimit、WorkingDirectory', () => {
    const ps = readFileSync(join(projectRoot, 'scripts', 'schedule.ps1'), 'utf8');
    assert.match(ps, /-StartWhenAvailable/, '必须支持错过补跑');
    assert.match(ps, /-WorkingDirectory/, '脚本内路径基于 cwd，必须设工作目录');
    assert.match(ps, /ExecutionTimeLimit/, '必须设执行时限，防止挂住的任务占位');
    // 成长任务：多个独立 -Daily 触发器
    const growthTriggers = (ps.match(/New-ScheduledTaskTrigger -Daily -At/g) || []).length;
    assert.ok(growthTriggers >= 5, `签到1 + 成长4 应至少 5 个独立触发器，实际 ${growthTriggers}`);
    assert.match(ps, /WorkBuddyApiProxy-Checkin/);
    assert.match(ps, /WorkBuddyApiProxy-Growth/);
});

test('billing-task.mjs 存在且支持 checkin / growth 两种模式', () => {
    const src = readFileSync(join(projectRoot, 'scripts', 'billing-task.mjs'), 'utf8');
    assert.match(src, /checkin/);
    assert.match(src, /growth/);
    assert.match(src, /--wait-arrival/);
});

/**
 * 回归：Windows PowerShell 5.1 默认按 ANSI 读取 .ps1，无 BOM 的 UTF-8 中文会变乱码，
 * 进而导致解析器报"缺少 }"这类莫名其妙的语法错误（本项目实际踩过）。
 * 所有含中文的 .ps1 必须带 UTF-8 BOM。
 */
test('PowerShell 脚本带 UTF-8 BOM（否则中文乱码会导致语法解析失败）', () => {
    for (const name of ['schedule.ps1', 'startup.ps1']) {
        const buf = readFileSync(join(projectRoot, 'scripts', name));
        const hasBom = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
        assert.equal(hasBom, true, `${name} 缺少 UTF-8 BOM`);
    }
});
