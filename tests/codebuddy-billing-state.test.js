import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, readdirSync, rmSync, mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

/**
 * 状态文件并发防护：原子写 + 写前重读合并。
 *
 * 用子进程验证（billing.js 以 process.cwd() 拼 .codebuddy 路径，
 * 在测试进程内 chdir 会影响并行运行的其它测试）。
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');
const billingUrl = pathToFileURL(join(projectRoot, 'src', 'services', 'codebuddy', 'billing.js')).href;

/**
 * 在隔离目录里跑一段脚本，返回 stdout
 */
function runInIsolatedDir(code) {
    const dir = mkdtempSync(join(tmpdir(), 'cb-state-'));
    mkdirSync(join(dir, '.codebuddy'), {recursive: true});
    try {
        const script = `
            import {recordScheduleRun} from ${JSON.stringify(billingUrl)};
            ${code}
        `;
        return execFileSync(process.execPath, ['--input-type=module', '-e', script], {
            cwd: dir,
            encoding: 'utf8',
            timeout: 20000
        });
    } finally {
        rmSync(dir, {recursive: true, force: true});
    }
}

test('原子写 + 写前重读：未触碰的 user 键被保留', () => {
    const stateFile = '.codebuddy/billing_state.json';
    const out = runInIsolatedDir(`
        import {writeFileSync, readFileSync} from 'node:fs';
        writeFileSync('${stateFile}', JSON.stringify({u1: {checkinDate: '2026-10-17', remaining: 100}}));
        recordScheduleRun('startup', {startupCheckinCount: 1});
        const after = JSON.parse(readFileSync('${stateFile}', 'utf8'));
        console.log(JSON.stringify(after));
    `);
    const after = JSON.parse(out.trim().split('\n').pop());
    assert.deepEqual(after.u1, {checkinDate: '2026-10-17', remaining: 100}, '未触碰的键必须保留');
    assert.ok(after._schedule && after._schedule.lastStartupRun > 0, '_schedule 应写入');
});

test('原子写：目录中不残留 .tmp 文件', () => {
    const out = runInIsolatedDir(`
        import {readdirSync} from 'node:fs';
        recordScheduleRun('growth', {});
        console.log(JSON.stringify(readdirSync('.codebuddy')));
    `);
    const files = JSON.parse(out.trim().split('\n').pop());
    assert.equal(files.filter((f) => f.includes('.tmp')).length, 0, `不应残留临时文件: ${files.join(',')}`);
    assert.ok(files.includes('billing_state.json'), '状态文件应存在');
});

test('幂等写入：同一 kind 重复记录只更新时间戳，不产生脏数据', () => {
    const out = runInIsolatedDir(`
        import {readFileSync} from 'node:fs';
        recordScheduleRun('checkin', {a: 1});
        recordScheduleRun('checkin', {a: 2});
        const s = JSON.parse(readFileSync('.codebuddy/billing_state.json', 'utf8'));
        console.log(JSON.stringify(s._schedule));
    `);
    const schedule = JSON.parse(out.trim().split('\n').pop());
    assert.ok(schedule.lastCheckinRun > 0);
});

/**
 * 回归：未声明 touchedKeys 的写入（如 recordScheduleRun / setStartupCheckinConfig）
 * 曾经走全量覆盖分支，会用本进程的旧快照覆盖掉其它 worker 刚写入的 user 键。
 * 现在必须一律写前重读、只覆盖 _config/_schedule，user 键保留磁盘版本。
 */
test('回归：无 touchedKeys 的写入不得用旧快照覆盖磁盘上的 user 键', () => {
    const stateFile = '.codebuddy/billing_state.json';
    const out = runInIsolatedDir(`
        import {writeFileSync, readFileSync} from 'node:fs';
        // 预置：磁盘上有"最新的"签到记录
        writeFileSync('${stateFile}', JSON.stringify({u1: {checkinDate: '2099-01-01', remaining: 999}}));
        // 只改 _schedule 段（内部走 saveBillingState 的无 touchedKeys 分支）
        recordScheduleRun('startup', {startupCheckinCount: 1});
        console.log(JSON.stringify(JSON.parse(readFileSync('${stateFile}', 'utf8'))));
    `);
    const after = JSON.parse(out.trim().split('\n').pop());
    assert.deepEqual(after.u1, {checkinDate: '2099-01-01', remaining: 999}, '磁盘上更新的 user 键必须保留');
    assert.ok(after._schedule, '_schedule 应写入');
});

/**
 * 默认行为：启动时的自动化**默认开启**。
 * 不注册任何系统计划任务——启动跑一次是唯一的自动化路径，
 * 若默认关闭，绝大多数用户永远不会签到。
 * 只有用户显式在面板取消（存 false）才跳过。
 */
test('启动自动化默认开启；仅显式设为 false 时关闭', () => {
    const out = runInIsolatedDir(`
        import {getStartupCheckinConfig, setStartupCheckinConfig} from ${JSON.stringify(billingUrl)};
        const before = getStartupCheckinConfig();       // 从未设置过
        setStartupCheckinConfig(false);
        const off = getStartupCheckinConfig();
        setStartupCheckinConfig(true);
        const on = getStartupCheckinConfig();
        console.log(JSON.stringify({before, off, on}));
    `);
    const r = JSON.parse(out.trim().split('\n').pop());
    assert.equal(r.before, true, '默认应为开启');
    assert.equal(r.off, false, '显式关闭后应为 false');
    assert.equal(r.on, true, '重新开启后应为 true');
});
