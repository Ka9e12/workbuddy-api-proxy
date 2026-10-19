/**
 * 环境变量解析工具
 *
 * 设计纪律：非法值一律「告警 + 回退默认」，**绝不抛异常**。
 * 理由：PM2 集群下一个 worker 因环境变量写错而启动失败，会让 max_restarts 耗尽，
 * 表现为「整轮任务无声炸掉」——正是要避免的失效模式。
 * @module utils/env
 */

import logger from './logger.js';

/**
 * 读取整型环境变量；非法/越界值打 warn 并回退默认
 * @param {string} name - 变量名
 * @param {Object} [spec]
 * @param {number} spec.default - 默认值
 * @param {number} [spec.min] - 下界（含）
 * @param {number} [spec.max] - 上界（含）
 * @returns {number}
 */
export function intEnv(name, {default: def, min = -Infinity, max = Infinity} = {}) {
    const raw = process.env[name];
    if (raw === undefined || raw === null || String(raw).trim() === '') return def;

    const n = Number(String(raw).trim());
    if (!Number.isInteger(n)) {
        logger.warn(`环境变量 ${name}="${raw}" 不是整数，回退默认值 ${def}`);
        return def;
    }
    if (n < min || n > max) {
        logger.warn(`环境变量 ${name}=${n} 超出范围 [${min}, ${max}]，回退默认值 ${def}`);
        return def;
    }
    return n;
}

/**
 * 读取布尔环境变量；'1'/'true'/'yes'/'on'（忽略大小写）为 true
 * @param {string} name - 变量名
 * @param {boolean} [def=false] - 缺省值
 * @returns {boolean}
 */
export function boolEnv(name, def = false) {
    const raw = process.env[name];
    if (raw === undefined || raw === null || String(raw).trim() === '') return def;
    const v = String(raw).trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(v)) return true;
    if (['0', 'false', 'no', 'off'].includes(v)) return false;
    logger.warn(`环境变量 ${name}="${raw}" 不是合法布尔值，回退默认值 ${def}`);
    return def;
}
