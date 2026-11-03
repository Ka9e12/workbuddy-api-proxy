import test from 'node:test';
import assert from 'node:assert/strict';
import {summarizePackages} from '../src/services/codebuddy/billing.js';

/**
 * 国际站与国内站的积分包结构完全一致（实测两边字段列表逐字相同），
 * 所以这里重点验证"两个站点能走同一套汇总逻辑"，以及国际站特有的
 * 长期有效包、字段缺 Precise 变体等情况不会出错。
 */
function pkg({size, remain, used, createdAt, endAt, name = '积分包', precise = false}) {
    const p = {
        CycleCapacitySize: String(size),
        CycleCapacityRemain: String(remain),
        PackageName: name
    };
    if (used !== undefined) p.CycleCapacityUsed = String(used);
    if (createdAt) p.CreateTime = String(createdAt.getTime());
    if (endAt) p.DeductionEndTime = String(endAt.getTime());
    if (precise) {
        p.CycleCapacitySizePrecise = String(size);
        p.CycleCapacityRemainPrecise = String(remain);
    }
    return p;
}

const NOW = new Date(2026, 9, 19, 12, 0, 0);
const inMonth = (day) => new Date(2026, 9, day, 10, 0, 0);
const daysAfterNow = (d) => new Date(NOW.getTime() + d * 86400000);

test('国际站真实形态：Bonus Pack 250 + Free Plan 100，都是满额', () => {
    // 实测国际站返回的数据（2026-10-19），字段名与国内站完全一致
    const summary = summarizePackages(
        [
            pkg({size: 250, remain: 250, used: 0, createdAt: inMonth(19), endAt: daysAfterNow(14), name: 'Bonus Pack'}),
            pkg({
                size: 100,
                remain: 100,
                used: 0,
                createdAt: inMonth(19),
                endAt: new Date(2035, 0, 1),
                name: 'Free Plan Subscription'
            })
        ],
        NOW
    );
    assert.equal(summary.capacity, 350);
    assert.equal(summary.remaining, 350);
    assert.equal(summary.used, 0);
    assert.equal(summary.packages, 2);
    assert.equal(summary.month, '2026-10');
});

test('国际站 Free Plan 到 2035 年作废：不会判成已过期，且不会被当最近到期', () => {
    const summary = summarizePackages(
        [
            pkg({size: 250, remain: 250, used: 0, createdAt: inMonth(19), endAt: daysAfterNow(14), name: 'Bonus Pack'}),
            pkg({
                size: 100,
                remain: 100,
                used: 0,
                createdAt: inMonth(19),
                endAt: new Date(2035, 0, 1),
                name: 'Free Plan Subscription'
            })
        ],
        NOW
    );
    // 最近到期应取 14 天后那个 Bonus Pack，而不是 2035 年的 Free Plan
    assert.equal(summary.soonestExpiry.name, 'Bonus Pack');
    assert.ok(Math.abs(summary.soonestExpiry.daysLeft - 14) < 0.01);
    // 但 350 分都还在账上，长期有效那个没被误判掉
    assert.equal(summary.remaining, 350);
});

test('国际站包用完时从"最近作废"里消失，但仍计入已花', () => {
    const summary = summarizePackages(
        [
            pkg({size: 250, remain: 0, used: 250, createdAt: inMonth(1), endAt: daysAfterNow(5), name: 'Bonus Pack'}),
            pkg({size: 100, remain: 100, used: 0, createdAt: inMonth(19), endAt: daysAfterNow(30), name: 'Free Plan'})
        ],
        NOW
    );
    assert.equal(summary.capacity, 350);
    assert.equal(summary.remaining, 100);
    assert.equal(summary.used, 250);
    // packages 是"本月领取的包数"，用完的那个也是本月领的，所以是 2
    assert.equal(summary.packages, 2);
    // 还留着余额的只有 1 个
    assert.equal(summary.livePackages, 1);
    // 用完的包不再提醒作废
    assert.equal(summary.soonestExpiry.name, 'Free Plan');
});

test('国际站 Free Plan 真实字段原样：周期结束 2026-11-30，而不是 2035 年的订阅到期日', () => {
    // 2026-11-03 实测数据原样（截取账本相关字段）。
    // DeductionEndTime 是 2035-01-19（订阅到期），CycleEndTime 是本月底。
    // "这笔额度什么时候清零"必须看 CycleEndTime。
    const summary = summarizePackages(
        [
            {
                CreateTime: 1792414855000,
                CycleStartTime: '2026-11-01 00:00:00',
                CycleEndTime: '2026-11-30 23:59:59',
                DeductionEndTime: 2052824453000,
                CapacitySize: 100,
                CapacityRemain: 100,
                CapacityUsed: 0,
                CycleCapacitySize: 100,
                CycleCapacityRemain: 95,
                CycleCapacityUsed: 4,
                CycleCapacitySizePrecise: '100',
                CycleCapacityRemainPrecise: '95.71000018',
                CycleCapacityUsedPrecise: '4.28999982',
                PackageName: 'Free Plan Subscription'
            }
        ],
        new Date(2026, 10, 3, 10, 0, 0)
    );
    assert.equal(summary.soonestExpiry.cycleBased, true);
    assert.equal(summary.soonestExpiry.name, 'Free Plan Subscription');
    // 2026-11-03 10:00 → 2026-11-30 23:59:59（北京时间）约 27.5 天
    assert.ok(summary.soonestExpiry.daysLeft > 27 && summary.soonestExpiry.daysLeft < 28,
        '应为约 27.6 天，实际 ' + summary.soonestExpiry.daysLeft);
    // 余额取的是本周期剩余
    assert.ok(Math.abs(summary.available - 95.71) < 1e-6);
});

test('国际站某些包没有 Precise 字段时也能读', () => {
    // 实测国际站 Bonus Pack 只有 CycleCapacitySize，没有 Precise 变体
    const summary = summarizePackages(
        [pkg({size: 250, remain: 250, used: 0, createdAt: inMonth(19), endAt: daysAfterNow(14), precise: false})],
        NOW
    );
    assert.equal(summary.capacity, 250);
    assert.equal(summary.remaining, 250);
});

test('国际站包用 Precise 字段时不丢小数', () => {
    const summary = summarizePackages(
        [
            {
                CycleCapacitySize: '250',
                CycleCapacityRemain: '249',
                CycleCapacitySizePrecise: '250.5',
                CycleCapacityRemainPrecise: '249.75',
                PackageName: 'Bonus Pack',
                CreateTime: String(inMonth(19).getTime()),
                DeductionEndTime: String(daysAfterNow(14).getTime())
            }
        ],
        NOW
    );
    assert.equal(summary.capacity, 250.5);
    assert.equal(summary.remaining, 249.75);
});
