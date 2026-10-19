/**
 * 速率限制
 * 滑动窗口算法，防止暴力破解
 * @module services/gateway/rate-limit
 */

import logger from '../../utils/logger.js';
import {intEnv} from '../../utils/env.js';

// 默认配置
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_WINDOW_MS = 60000;   // 60 秒
const DEFAULT_BLOCK_MS = 300000;   // 5 分钟
const CLEANUP_INTERVAL_MS = 60000; // 清理间隔

/**
 * 速率限制器
 */
class RateLimiter {
    constructor() {
        this.maxAttempts = intEnv('RATE_LIMIT_MAX_ATTEMPTS', {default: DEFAULT_MAX_ATTEMPTS, min: 1});
        this.windowMs = intEnv('RATE_LIMIT_WINDOW_MS', {default: DEFAULT_WINDOW_MS, min: 1});
        this.blockMs = intEnv('RATE_LIMIT_BLOCK_MS', {default: DEFAULT_BLOCK_MS, min: 0});

        // key -> { timestamps: number[], blockedUntil: number }
        this.entries = new Map();

        // 定时清理过期条目
        this._cleanupTimer = setInterval(() => this._cleanup(), CLEANUP_INTERVAL_MS);
        this._cleanupTimer.unref();
    }

    /**
     * 检查是否允许请求
     * @param {string} key - 限流标识（通常为 IP 地址）
     * @returns {{allowed: boolean, retryAfterMs: number}}
     */
    checkRateLimit(key) {
        const now = Date.now();
        const entry = this.entries.get(key);

        // 没有记录，允许
        if (!entry) {
            return {allowed: true, retryAfterMs: 0};
        }

        // 还在封禁期内
        if (entry.blockedUntil && now < entry.blockedUntil) {
            return {allowed: false, retryAfterMs: entry.blockedUntil - now};
        }

        // 清除过期的封禁
        if (entry.blockedUntil && now >= entry.blockedUntil) {
            entry.blockedUntil = 0;
            entry.timestamps = [];
        }

        // 计算窗口内的失败次数
        const windowStart = now - this.windowMs;
        entry.timestamps = entry.timestamps.filter(ts => ts > windowStart);

        if (entry.timestamps.length >= this.maxAttempts) {
            entry.blockedUntil = now + this.blockMs;
            logger.warn(`Rate limit exceeded for ${key}, blocked for ${this.blockMs / 1000}s`);
            return {allowed: false, retryAfterMs: this.blockMs};
        }

        return {allowed: true, retryAfterMs: 0};
    }

    /**
     * 记录一次失败
     * @param {string} key - 限流标识
     */
    recordFailure(key) {
        const now = Date.now();
        let entry = this.entries.get(key);

        if (!entry) {
            entry = {timestamps: [], blockedUntil: 0};
            this.entries.set(key, entry);
        }

        // 清除过期的封禁
        if (entry.blockedUntil && now >= entry.blockedUntil) {
            entry.blockedUntil = 0;
            entry.timestamps = [];
        }

        entry.timestamps.push(now);

        // 检查是否触发封禁
        const windowStart = now - this.windowMs;
        entry.timestamps = entry.timestamps.filter(ts => ts > windowStart);

        if (entry.timestamps.length >= this.maxAttempts && !entry.blockedUntil) {
            entry.blockedUntil = now + this.blockMs;
            logger.warn(`Rate limit triggered for ${key}, blocked for ${this.blockMs / 1000}s`);
        }
    }

    /**
     * 记录一次成功（清除失败计数）
     * @param {string} key - 限流标识
     */
    recordSuccess(key) {
        this.entries.delete(key);
    }

    /**
     * 获取速率限制状态
     * @param {string} key - 限流标识
     * @returns {{blocked: boolean, retryAfterMs: number}}
     */
    getRateLimitStatus(key) {
        const result = this.checkRateLimit(key);
        return {blocked: !result.allowed, retryAfterMs: result.retryAfterMs};
    }

    /**
     * 清理过期条目，防止内存泄漏
     */
    _cleanup() {
        const now = Date.now();
        for (const [key, entry] of this.entries) {
            // 已过封禁期且无近期失败记录
            if (entry.blockedUntil && now >= entry.blockedUntil) {
                const windowStart = now - this.windowMs;
                entry.timestamps = entry.timestamps.filter(ts => ts > windowStart);
                if (entry.timestamps.length === 0) {
                    this.entries.delete(key);
                } else {
                    entry.blockedUntil = 0;
                }
            } else if (!entry.blockedUntil) {
                // 无封禁，清理过期的失败记录
                const windowStart = now - this.windowMs;
                entry.timestamps = entry.timestamps.filter(ts => ts > windowStart);
                if (entry.timestamps.length === 0) {
                    this.entries.delete(key);
                }
            }
        }
    }
}

// 两个独立的速率限制器：管理员登录 + API 认证
export const adminRateLimiter = new RateLimiter();
export const apiRateLimiter = new RateLimiter();
