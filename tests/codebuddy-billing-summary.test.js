import test from 'node:test';
import assert from 'node:assert/strict';
import {summarizePackages} from '../src/services/codebuddy/billing.js';

/**
 * 构造一个积分包。
 * @param {Object} o
 * @param {number} o.size 面额
 * @param {number} o.remain 剩余
 * @param {number} [o.used] 已用（不传则按 size-remain 推算，与上游一致）
 * @param {Date} [o.createdAt] 创建时间，决定它属于哪个月
 * @param {number} [o.daysLeft] 距作废还有几天（写进 DeductionEndTime）
 * @param {string} [o.cycleEnd] 周期结束时间，北京时间字符串（写进 CycleEndTime）
 * @param {Date} [o.now] 计算 daysLeft 的基准时刻，必须与传给 summarizePackages 的一致
 */
function pkg({size, remain, used, createdAt, daysLeft = null, cycleEnd = null, name = '积分包', cycle = true, now = NOW}) {
    const prefix = cycle ? 'Cycle' : '';
    const p = {
        [`${prefix}CapacitySize`]: String(size),
        [`${prefix}CapacityRemain`]: String(remain),
        PackageName: name
    };
    if (used !== undefined) p[`${prefix}CapacityUsed`] = String(used);
    if (createdAt) p.CreateTime = String(createdAt.getTime());
    if (daysLeft !== null) p.DeductionEndTime = String(now.getTime() + daysLeft * 86400000);
    if (cycleEnd !== null) p.CycleEndTime = cycleEnd;
    return p;
}

/** 固定的"现在"：2026-10-19，本月是 2026-10 */
const NOW = new Date(2026, 9, 19, 12, 0, 0);
const inMonth = (day) => new Date(2026, 9, day, 10, 0, 0);
const prevMonth = (day) => new Date(2026, 8, day, 10, 0, 0);

test('本月口径闭环：本月领取 = 本月已花 + 本月剩余', () => {
    const summary = summarizePackages(
        [
            pkg({size: 500, remain: 461.2, createdAt: inMonth(16), daysLeft: 28}),
            pkg({size: 100, remain: 100, createdAt: inMonth(16), daysLeft: 28}),
            pkg({size: 100, remain: 100, createdAt: inMonth(19), daysLeft: 31})
        ],
        NOW
    );
    assert.equal(summary.month, '2026-10');
    assert.equal(summary.capacity, 700);
    assert.ok(Math.abs(summary.remaining - 661.2) < 1e-9);
    assert.ok(Math.abs(summary.used - 38.8) < 1e-9);
    // 不变量
    assert.ok(Math.abs(summary.capacity - (summary.used + summary.remaining)) < 1e-9);
});

test('往月的包不进本月账本', () => {
    const summary = summarizePackages(
        [
            pkg({size: 100, remain: 0, used: 100, createdAt: prevMonth(15)}),
            pkg({size: 100, remain: 100, createdAt: inMonth(10)})
        ],
        NOW
    );
    // 本月只有一个包
    assert.equal(summary.capacity, 100);
    assert.equal(summary.remaining, 100);
    assert.equal(summary.used, 0);
    assert.equal(summary.packages, 1);
});

test('allTime 保留全部口径，可用来对照', () => {
    const summary = summarizePackages(
        [
            pkg({size: 100, remain: 0, used: 100, createdAt: prevMonth(15)}),
            pkg({size: 500, remain: 0, used: 500, createdAt: prevMonth(20)}),
            pkg({size: 100, remain: 60, createdAt: inMonth(10)})
        ],
        NOW
    );
    assert.equal(summary.capacity, 100); // 本月
    assert.equal(summary.allTime.capacity, 700);
    assert.equal(summary.allTime.remaining, 60);
    assert.equal(summary.allTime.used, 640);
});

test('真实场景：本月 14 个包领 1616，花 738.76，剩 877.24', () => {
    // 按实测数据构造：本月 8 个已用完的 100、1 个 500 剩 461.2、
    // 3 个 100 满额、还有 6 和 10 的小包
    const list = [];
    // 9 月 23 日那个属于上月，不该进本月
    list.push(pkg({size: 100, remain: 0, used: 100, createdAt: prevMonth(23)}));
    // 本月：10-09 ~ 10-15 的 7 个签到包（已用完）
    for (let d = 9; d <= 15; d++) list.push(pkg({size: 100, remain: 0, used: 100, createdAt: inMonth(d)}));
    // 10-16 的 500 包
    list.push(pkg({size: 500, remain: 461.2, createdAt: inMonth(16)}));
    // 10-16 两个满额 100
    list.push(pkg({size: 100, remain: 100, createdAt: inMonth(16)}));
    list.push(pkg({size: 100, remain: 100, createdAt: inMonth(16)}));
    // 10-17 的 6 和 100
    list.push(pkg({size: 6, remain: 6, createdAt: inMonth(17)}));
    list.push(pkg({size: 100, remain: 100, createdAt: inMonth(17)}));
    // 10-18 的 10
    list.push(pkg({size: 10, remain: 10, createdAt: inMonth(18)}));
    // 10-19 的 100
    list.push(pkg({size: 100, remain: 100, createdAt: inMonth(19)}));

    const summary = summarizePackages(list, NOW);
    assert.equal(summary.packages, 14);
    assert.equal(summary.capacity, 1616);
    assert.ok(Math.abs(summary.remaining - 877.2) < 1e-9);
    assert.ok(Math.abs(summary.used - 738.8) < 1e-9);
});

test('可用余额跨月份统计：往月没花完的包也算，这才是"现在能花多少"', () => {
    // 月初的典型场景：本月刚领一个包，但上月还有一大笔没用完。
    // 主卡显示"现在能花的部分"就必须把上月的余额算进去。
    const summary = summarizePackages(
        [
            pkg({size: 500, remain: 198.62, createdAt: prevMonth(25), daysLeft: 15}),
            pkg({size: 108, remain: 108, createdAt: inMonth(1), daysLeft: 29})
        ],
        NOW
    );
    // 本月口径只算本月领的
    assert.equal(summary.capacity, 108);
    assert.equal(summary.remaining, 108);
    // 可用余额是两个包加起来
    assert.ok(Math.abs(summary.available - 306.62) < 1e-9);
    assert.equal(summary.availablePackages, 2);
});

test('可用余额不含已过期的包', () => {
    const summary = summarizePackages(
        [
            pkg({size: 100, remain: 100, createdAt: inMonth(1), daysLeft: -3, name: '已过期'}),
            pkg({size: 100, remain: 50, createdAt: inMonth(1), daysLeft: 10, name: '还没过期'})
        ],
        NOW
    );
    assert.equal(summary.available, 50);
    assert.equal(summary.availablePackages, 1);
});

test('可用余额不含已用完的包，但包含没有作废时间的长期包', () => {
    const summary = summarizePackages(
        [
            pkg({size: 100, remain: 0, used: 100, createdAt: inMonth(1), daysLeft: 10}),
            pkg({size: 100, remain: 100, createdAt: inMonth(1)})
        ],
        NOW
    );
    assert.equal(summary.available, 100);
    assert.equal(summary.availablePackages, 1);
});

test('订阅包取 CycleEndTime 而不是 8 年后的 DeductionEndTime', () => {
    // 国际站 Free Plan 的真实形态：订阅到 2035 年，但额度每月按 Cycle 重置。
    // "这笔额度什么时候清零"要看 CycleEndTime，否则会算出 2999 天这种无意义的数。
    const summary = summarizePackages(
        [
            pkg({
                size: 100,
                remain: 95.71,
                used: 4.29,
                createdAt: inMonth(19),
                daysLeft: 2999, // DeductionEndTime = 2035 年左右
                cycleEnd: '2026-11-30 23:59:59', // 本周期结束（北京时间）
                name: 'Free Plan Subscription'
            })
        ],
        NOW
    );
    assert.equal(summary.soonestExpiry.name, 'Free Plan Subscription');
    assert.equal(summary.soonestExpiry.cycleBased, true);
    // 2026-10-19 12:00 到 2026-11-30 23:59:59（北京时间）约 42 天，远小于 2999
    assert.ok(summary.soonestExpiry.daysLeft > 40 && summary.soonestExpiry.daysLeft < 44,
        '应为约 42 天，实际 ' + summary.soonestExpiry.daysLeft);
});

test('没有 CycleEndTime 的独立包回退 DeductionEndTime', () => {
    const summary = summarizePackages(
        [pkg({size: 250, remain: 250, createdAt: inMonth(19), daysLeft: 14, name: 'Bonus Pack'})],
        NOW
    );
    assert.equal(summary.soonestExpiry.cycleBased, false);
    assert.ok(Math.abs(summary.soonestExpiry.daysLeft - 14) < 0.01);
});

test('国内站形态：CycleEndTime 与 DeductionEndTime 基本一致，判为独立包', () => {
    // 国内站签到包两个字段只差 1 秒，不能当成订阅型——否则会被误标成"本月额度清零"
    const now = NOW;
    const dedEnd = now.getTime() + 15 * 86400000;
    const cycleEndMs = dedEnd + 1000;
    const cnCycleEnd = new Date(cycleEndMs + 8 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ');
    const summary = summarizePackages(
        [
            {
                CycleCapacitySize: '100',
                CycleCapacityRemain: '100',
                CreateTime: String(inMonth(19).getTime()),
                DeductionEndTime: String(dedEnd),
                CycleEndTime: cnCycleEnd,
                PackageName: '签到包'
            }
        ],
        now
    );
    assert.ok(Math.abs(summary.soonestExpiry.daysLeft - 15) < 0.01);
    // 差值只有 1 秒，按独立包处理
    assert.equal(summary.soonestExpiry.cycleBased, false);
});

test('国内站体验版包：订阅到 2034 年但按月重置，按本周期结束算', () => {
    // 实测数据：每月基础 500 分，DeductionEndTime 是 8 年后，CycleEndTime 是本月底。
    // 与签到包的区别就在两个字段差了 2848 天，所以判为订阅型。
    const summary = summarizePackages(
        [
            {
                CycleCapacitySize: '500',
                CycleCapacityRemain: '500',
                CreateTime: String(inMonth(19).getTime()),
                DeductionEndTime: String(new Date(2034, 7, 21).getTime()),
                CycleEndTime: '2026-11-30 23:59:59',
                PackageName: 'CodeBuddy个人体验版'
            }
        ],
        NOW
    );
    assert.equal(summary.soonestExpiry.cycleBased, true);
    // 2026-10-19 12:00 → 2026-11-30 23:59:59（北京时间）约 42 天
    assert.ok(summary.soonestExpiry.daysLeft > 40 && summary.soonestExpiry.daysLeft < 44,
        '应为约 42 天，实际 ' + summary.soonestExpiry.daysLeft);
    assert.equal(summary.soonestExpiry.remain, 500);
});

test('取最接近过期时间的包：签到包先到期时优先它，而不是长期订阅包', () => {
    // 用户口径：主卡"最近一次作废"取最接近过期时间的那个包
    const summary = summarizePackages(
        [
            {
                CycleCapacitySize: '500',
                CycleCapacityRemain: '500',
                CreateTime: String(inMonth(1).getTime()),
                DeductionEndTime: String(new Date(2034, 7, 21).getTime()),
                CycleEndTime: '2026-11-30 23:59:59',
                PackageName: 'CodeBuddy个人体验版'
            },
            pkg({size: 100, remain: 100, createdAt: inMonth(10), daysLeft: 5, name: '签到包'})
        ],
        NOW
    );
    assert.equal(summary.soonestExpiry.name, '签到包');
    assert.equal(summary.soonestExpiry.cycleBased, false);
    assert.ok(Math.abs(summary.soonestExpiry.daysLeft - 5) < 0.01);
});

test('CycleEndTime 格式非法时回退 DeductionEndTime', () => {
    const summary = summarizePackages(
        [pkg({size: 100, remain: 100, createdAt: inMonth(19), daysLeft: 10, cycleEnd: 'not-a-date'})],
        NOW
    );
    assert.equal(summary.soonestExpiry.cycleBased, false);
    assert.ok(Math.abs(summary.soonestExpiry.daysLeft - 10) < 0.01);
});

test('最近作废跨月份统计：往月的包还有余额也算', () => {
    // 这是"本月"和"作废"两个口径的关键区别：作废看的是余额，不是领取月份
    const summary = summarizePackages(
        [
            pkg({size: 500, remain: 200, createdAt: prevMonth(25), daysLeft: 5, name: '上月领的'}),
            pkg({size: 100, remain: 100, createdAt: inMonth(18), daysLeft: 30, name: '本月领的'})
        ],
        NOW
    );
    assert.equal(summary.month, '2026-10');
    assert.equal(summary.capacity, 100); // 本月只算本月领的
    // 但最近作废要盯着上月那个还有 200 分的包
    assert.equal(summary.soonestExpiry.name, '上月领的');
    assert.ok(Math.abs(summary.soonestExpiry.daysLeft - 5) < 0.01);
});

test('最近作废忽略已用完的包', () => {
    const summary = summarizePackages(
        [
            pkg({size: 100, remain: 0, used: 100, createdAt: inMonth(1), daysLeft: 1, name: '用完的'}),
            pkg({size: 100, remain: 100, createdAt: inMonth(18), daysLeft: 20, name: '有余额的'})
        ],
        NOW
    );
    assert.equal(summary.soonestExpiry.name, '有余额的');
});

test('最近作废忽略已过期的包', () => {
    const summary = summarizePackages(
        [
            pkg({size: 100, remain: 100, createdAt: inMonth(1), daysLeft: -3, name: '已过期'}),
            pkg({size: 100, remain: 100, createdAt: inMonth(18), daysLeft: 10, name: '十天后'})
        ],
        NOW
    );
    assert.equal(summary.soonestExpiry.name, '十天后');
});

test('没有可用包时 soonestExpiry 为 null', () => {
    const summary = summarizePackages([pkg({size: 100, remain: 0, used: 100, createdAt: inMonth(5)})], NOW);
    assert.equal(summary.soonestExpiry, null);
    assert.equal(summary.monthLabel, '10 月');
});

test('本月没领过包时全是 0，但不会崩', () => {
    const summary = summarizePackages([pkg({size: 100, remain: 50, createdAt: prevMonth(5), daysLeft: 10})], NOW);
    assert.equal(summary.capacity, 0);
    assert.equal(summary.remaining, 0);
    assert.equal(summary.used, 0);
    assert.equal(summary.packages, 0);
    // 但余额还在，作废倒计时仍在盯着
    assert.equal(summary.livePackages, 1);
    assert.ok(summary.soonestExpiry);
});

test('缺 CreateTime 的包不进本月账本（无法判断归属月份）', () => {
    const summary = summarizePackages([pkg({size: 100, remain: 100})], NOW);
    assert.equal(summary.capacity, 0);
    assert.equal(summary.allTime.capacity, 100);
});

test('剩余超过面额时按面额封顶', () => {
    const summary = summarizePackages([pkg({size: 100, remain: 150, createdAt: inMonth(5)})], NOW);
    assert.equal(summary.remaining, 100);
    assert.ok(summary.used >= 0);
});

test('0 面额的非额度包不参与账本', () => {
    const summary = summarizePackages(
        [pkg({size: 0, remain: 0, createdAt: inMonth(5)}), pkg({size: 100, remain: 100, createdAt: inMonth(5)})],
        NOW
    );
    assert.equal(summary.capacity, 100);
    assert.equal(summary.packages, 1);
});

test('精确值优先于整数值', () => {
    const summary = summarizePackages(
        [
            {
                CycleCapacitySizePrecise: '100.5',
                CycleCapacitySize: '100',
                CycleCapacityRemainPrecise: '50.25',
                CycleCapacityRemain: '50',
                CreateTime: String(inMonth(5).getTime())
            }
        ],
        NOW
    );
    assert.equal(summary.capacity, 100.5);
    assert.equal(summary.remaining, 50.25);
});

test('非 Cycle 前缀的包也能汇总（国际站形态）', () => {
    const summary = summarizePackages([pkg({size: 200, remain: 80, createdAt: inMonth(5), cycle: false})], NOW);
    assert.equal(summary.capacity, 200);
    assert.equal(summary.remaining, 80);
    assert.equal(summary.used, 120);
});

test('空列表返回全 0，不崩', () => {
    const summary = summarizePackages([], NOW);
    assert.equal(summary.remaining, 0);
    assert.equal(summary.capacity, 0);
    assert.equal(summary.used, 0);
    assert.equal(summary.packages, 0);
    assert.equal(summary.soonestExpiry, null);
});

test('月初与月末边界：10-01 00:00 属于本月，09-30 不属于', () => {
    const monthStart = new Date(2026, 9, 1, 0, 0, 0);
    const lastMomentPrev = new Date(2026, 8, 30, 23, 59, 59);
    const summary = summarizePackages(
        [
            pkg({size: 100, remain: 100, createdAt: monthStart}),
            pkg({size: 100, remain: 100, createdAt: lastMomentPrev})
        ],
        NOW
    );
    assert.equal(summary.capacity, 100);
    assert.equal(summary.packages, 1);
});
