/**
 * 集群广播工具
 * 用于多进程（PM2 fork模式）间的状态同步和统计聚合
 * 通过 HTTP 广播事件到其他 worker，通过 HTTP 查询聚合统计数据
 * @module utils/cluster-broadcaster
 */

import logger from './logger.js';

const CURRENT_PORT = parseInt(process.env.PORT || '3081', 10);
const ALL_PORTS = (process.env.CLUSTER_PORTS || String(CURRENT_PORT))
    .split(',')
    .map(s => parseInt(s.trim(), 10))
    .filter(n => !isNaN(n) && n > 0);

const INTERNAL_HOST = '127.0.0.1';
const BROADCAST_TIMEOUT = 3000;

/**
 * 向集群中其他所有 worker 广播事件
 * @param {string} eventType - 事件类型
 * @param {object} [data={}] - 附加数据
 */
export async function broadcast(eventType, data = {}) {
    const otherPorts = ALL_PORTS.filter(p => p !== CURRENT_PORT);
    if (otherPorts.length === 0) return;

    const payload = JSON.stringify({type: eventType, ...data, sourcePort: CURRENT_PORT});
    const results = await Promise.allSettled(
        otherPorts.map(port =>
            fetch(`http://${INTERNAL_HOST}:${port}/internal/broadcast`, {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: payload,
                signal: AbortSignal.timeout(BROADCAST_TIMEOUT)
            })
        )
    );

    let failed = 0;
    for (const r of results) {
        if (r.status === 'rejected') failed++;
    }
    if (failed > 0) {
        logger.debug(`Broadcast "${eventType}": ${otherPorts.length - failed}/${otherPorts.length} workers reached`);
    }
}

/**
 * 从所有 worker 收集统计数据并聚合（数值字段求和）
 * @param {string} service - 服务名称 'copilot' | 'codebuddy' | 'relay'
 * @returns {Promise<object>} 聚合后的统计数据
 */
export async function gatherAllStats(service) {
    const results = await Promise.allSettled(
        ALL_PORTS.map(port =>
            fetch(`http://${INTERNAL_HOST}:${port}/internal/stats/${service}`, {
                signal: AbortSignal.timeout(BROADCAST_TIMEOUT)
            }).then(r => r.json())
        )
    );

    const valid = results
        .filter(r => r.status === 'fulfilled' && r.value && typeof r.value === 'object')
        .map(r => r.value);

    return aggregateStats(valid);
}

/**
 * 聚合多个 worker 的统计数据（数值字段求和）
 * @param {Array<object>} statsArray
 * @returns {object}
 */
function aggregateStats(statsArray) {
    if (statsArray.length === 0) return {};
    if (statsArray.length === 1) return statsArray[0];

    const result = {};
    const numericKeys = new Set();

    // 收集所有数值字段名
    for (const stats of statsArray) {
        for (const [key, value] of Object.entries(stats)) {
            if (typeof value === 'number') {
                numericKeys.add(key);
            }
        }
    }

    // 求和
    for (const key of numericKeys) {
        result[key] = 0;
        for (const stats of statsArray) {
            result[key] += stats[key] || 0;
        }
    }

    // 保留非数值字段（取第一个 worker 的值）
    for (const stats of statsArray) {
        for (const [key, value] of Object.entries(stats)) {
            if (!(key in result)) {
                result[key] = value;
            }
        }
    }

    return result;
}

/**
 * 获取当前 worker 端口
 * @returns {number}
 */
export function getCurrentPort() {
    return CURRENT_PORT;
}

/**
 * 获取所有 worker 端口列表
 * @returns {number[]}
 */
export function getAllPorts() {
    return [...ALL_PORTS];
}

/**
 * 是否为集群模式（多个 worker）
 * @returns {boolean}
 */
export function isClusterMode() {
    return ALL_PORTS.length > 1;
}
