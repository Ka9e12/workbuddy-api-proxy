/**
 * 通用 Responses API WebSocket 连接池
 * 按连接键维护空闲 WS 连接，支持上下文复用
 * 从 copilot-ws-pool.js 提取，去除 Copilot 特定逻辑
 * @module services/ws/ws-pool
 */

import {connectWebSocket} from './ws-client.js';
import logger from '../../utils/logger.js';
import WebSocket from 'ws';

const DEFAULT_IDLE_TIMEOUT = 60000;
const DEFAULT_MAX_PER_KEY = 5;
const HEALTH_CHECK_TIMEOUT = 3000; // 健康检查 ping 应答超时

class PooledConnection {
    constructor(ws, poolKey) {
        this.ws = ws;
        this.poolKey = poolKey;
        this.busy = false;
        this.createdAt = Date.now();
        this.lastUsedAt = Date.now();
        this.idleTimer = null;
        this.contextKey = null;
        this.lastResponseId = null;
    }
}

export class ResponsesWSPool {
    /**
     * @param {object} [options]
     * @param {number} [options.maxPerKey=5] - 每个 pool key 的最大连接数
     * @param {number} [options.idleTimeout=60000] - 空闲连接超时（毫秒）
     */
    constructor(options = {}) {
        this.maxPerKey = options.maxPerKey || DEFAULT_MAX_PER_KEY;
        this.idleTimeout = options.idleTimeout || DEFAULT_IDLE_TIMEOUT;
        this.pools = new Map();
    }

    _getPool(key) {
        if (!this.pools.has(key)) this.pools.set(key, []);
        return this.pools.get(key);
    }

    _startIdleTimer(conn) {
        if (conn.idleTimer) clearTimeout(conn.idleTimer);
        conn.idleTimer = setTimeout(() => {
            this._removeConnection(conn);
        }, this.idleTimeout);
    }

    _stopIdleTimer(conn) {
        if (conn.idleTimer) {
            clearTimeout(conn.idleTimer);
            conn.idleTimer = null;
        }
    }

    _normalizeContextKey(contextKey) {
        return typeof contextKey === 'string' && contextKey.trim() ? contextKey.trim() : null;
    }

    _normalizeResponseId(responseId) {
        return typeof responseId === 'string' && responseId.trim() ? responseId.trim() : null;
    }

    _bindConnectionContext(conn, contextKey, preserveResponseId = false) {
        const normalizedContextKey = this._normalizeContextKey(contextKey);
        if (conn.contextKey !== normalizedContextKey) {
            conn.contextKey = normalizedContextKey;
            if (!preserveResponseId) conn.lastResponseId = null;
        }
    }

    /**
     * 验证连接是否真正健康（readyState===1 不可靠，死 TCP 连接仍然报 OPEN）
     * @param {PooledConnection} conn
     * @returns {Promise<boolean>}
     */
    async _isConnectionHealthy(conn) {
        const ws = conn.ws;
        if (ws.readyState !== WebSocket.OPEN) return false;
        // 发送 ping，等待 pong — 如果连接已死，pong 不会回来
        try {
            await new Promise((resolve, reject) => {
                const timeout = setTimeout(() => reject(new Error('health check timeout')), HEALTH_CHECK_TIMEOUT);
                const onPong = () => {
                    clearTimeout(timeout);
                    ws.off('pong', onPong);
                    resolve();
                };
                ws.on('pong', onPong);
                try { ws.ping(); } catch (e) { clearTimeout(timeout); reject(e); }
            });
            return true;
        } catch {
            logger.warn(`WS pool: health check failed for connection, removing from pool`);
            this._removeConnection(conn);
            return false;
        }
    }

    _removeConnection(conn) {
        this._stopIdleTimer(conn);
        try { conn.ws.close(); } catch {}
        const pool = this.pools.get(conn.poolKey);
        if (pool) {
            const idx = pool.indexOf(conn);
            if (idx !== -1) pool.splice(idx, 1);
            if (pool.length === 0) this.pools.delete(conn.poolKey);
        }
    }

    /**
     * 获取一个 WS 连接（复用或新建）
     * @param {string} poolKey - 连接池分桶键
     * @param {function} connectFn - 创建新连接的工厂函数 async () => WebSocket
     * @param {object} [options]
     * @param {string} [options.contextKey] - 会话上下文键（用于对话连续性）
     * @param {string} [options.preferredPreviousResponseId] - 优先匹配此 response_id 的连接
     * @returns {Promise<PooledConnection>}
     */
    async acquire(poolKey, connectFn, options = {}) {
        const pool = this._getPool(poolKey);
        const normalizedContextKey = this._normalizeContextKey(options.contextKey);
        const normalizedPreviousResponseId = this._normalizeResponseId(options.preferredPreviousResponseId);

        // 1. 按 previous_response_id 精确匹配
        if (normalizedPreviousResponseId) {
            for (const conn of pool) {
                if (!conn.busy && conn.ws.readyState === 1 && conn.lastResponseId === normalizedPreviousResponseId) {
                    if (!(await this._isConnectionHealthy(conn))) continue;
                    conn.busy = true;
                    conn.lastUsedAt = Date.now();
                    this._stopIdleTimer(conn);
                    this._bindConnectionContext(conn, normalizedContextKey ?? conn.contextKey, true);
                    logger.info(`WS pool: reusing connection by previous_response_id for ${normalizedPreviousResponseId}`);
                    return conn;
                }
            }
        }

        // 2. 按 contextKey 匹配
        if (normalizedContextKey) {
            for (const conn of pool) {
                if (!conn.busy && conn.ws.readyState === 1 && conn.contextKey === normalizedContextKey) {
                    if (!(await this._isConnectionHealthy(conn))) continue;
                    conn.busy = true;
                    conn.lastUsedAt = Date.now();
                    this._stopIdleTimer(conn);
                    return conn;
                }
            }
        }

        // 3. 任何无上下文的空闲连接
        for (const conn of pool) {
            if (!conn.busy && conn.ws.readyState === 1 && !conn.contextKey) {
                if (!(await this._isConnectionHealthy(conn))) continue;
                conn.busy = true;
                conn.lastUsedAt = Date.now();
                this._stopIdleTimer(conn);
                this._bindConnectionContext(conn, normalizedContextKey, false);
                return conn;
            }
        }

        // 4. 任何空闲连接
        for (const conn of pool) {
            if (!conn.busy && conn.ws.readyState === 1) {
                if (!(await this._isConnectionHealthy(conn))) continue;
                conn.busy = true;
                conn.lastUsedAt = Date.now();
                this._stopIdleTimer(conn);
                this._bindConnectionContext(conn, normalizedContextKey, false);
                return conn;
            }
        }

        // 5. 新建连接
        const ws = await connectFn();

        const conn = new PooledConnection(ws, poolKey);
        conn.busy = true;
        this._bindConnectionContext(conn, normalizedContextKey, false);
        pool.push(conn);

        ws.on('close', () => this._removeConnection(conn));
        ws.on('error', (err) => {
            logger.warn(`WS pool: connection error: ${err.message}`);
            this._removeConnection(conn);
        });

        // 超出上限时回收最旧的空闲连接
        while (pool.length > this.maxPerKey) {
            const oldest = pool.find(c => !c.busy);
            if (oldest) this._removeConnection(oldest);
            else break;
        }

        return conn;
    }

    /**
     * 释放连接回池中
     */
    release(conn) {
        if (conn.ws.readyState !== 1) {
            this._removeConnection(conn);
            return;
        }
        conn.busy = false;
        conn.lastUsedAt = Date.now();
        this._startIdleTimer(conn);
    }

    /**
     * 丢弃连接
     */
    discard(conn) {
        this._removeConnection(conn);
    }

    /**
     * 关闭所有连接
     */
    shutdown() {
        for (const [, pool] of this.pools) {
            for (const conn of pool) {
                this._stopIdleTimer(conn);
                try { conn.ws.close(); } catch {}
            }
        }
        this.pools.clear();
    }
}
