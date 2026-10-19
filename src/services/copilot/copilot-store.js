/**
 * Copilot 单租户存储管理器
 * 管理 API Key 鉴权、用量统计、代理配置
 * 同构 credential-store.js / relay-store.js
 * @module services/copilot/copilot-store
 */

import {readFileSync, writeFileSync, existsSync, mkdirSync} from 'fs';
import {join} from 'path';
import logger from '../../utils/logger.js';
import {copilotState} from './state.js';
import {broadcast} from '../../utils/cluster-broadcaster.js';

const COPILOT_DIR = '.copilot';
const USAGE_FILE = 'usage.json';
const PROXY_FILE = 'proxy.json';
const DAILY_USAGE_FILE = 'daily_usage.json';

class CopilotStore {
    constructor() {
        this.baseDir = join(process.cwd(), COPILOT_DIR);
        this.usageFile = join(this.baseDir, USAGE_FILE);
        this.proxyFile = join(this.baseDir, PROXY_FILE);
        this.dailyUsageFile = join(this.baseDir, DAILY_USAGE_FILE);

        // Usage tracking
        this.apiCallCount = 0;
        this.inputTokens = 0;
        this.outputTokens = 0;
        this.cacheHitTokens = 0;
        this.customApiCallCount = 0;
        this.customInputTokens = 0;
        this.customOutputTokens = 0;
        this.customCacheHitTokens = 0;
        this.dirtyCount = 0;
        this.DIRTY_FLUSH_THRESHOLD = 10;

        // Daily usage memory buffer (内存计数，flush 时合并写入文件)
        this._dailyBuffer = {};  // {monthKey: {dayKey: {api_calls, input_tokens, output_tokens, cache_hit_tokens}}}
        this._dailyDirtyCount = 0;
        this._DAILY_DIRTY_FLUSH_THRESHOLD = 10;

        // Proxy config
        this.proxy = null;
        this.skipTlsVerify = false;

        this._init();
    }

    _init() {
        if (!existsSync(this.baseDir)) mkdirSync(this.baseDir, {recursive: true});
        this._loadUsage();
        this._loadProxy();
    }

    // ==================== Usage Stats ====================

    _loadUsage() {
        if (existsSync(this.usageFile)) {
            try {
                const data = JSON.parse(readFileSync(this.usageFile, 'utf8'));
                this.apiCallCount = data.api_call_count || 0;
                this.inputTokens = data.input_tokens || 0;
                this.outputTokens = data.output_tokens || 0;
                this.cacheHitTokens = data.cache_hit_tokens || 0;
                this.customApiCallCount = data.custom_api_call_count || 0;
                this.customInputTokens = data.custom_input_tokens || 0;
                this.customOutputTokens = data.custom_output_tokens || 0;
                this.customCacheHitTokens = data.custom_cache_hit_tokens || 0;
            } catch {}
        }
    }

    _saveUsage() {
        writeFileSync(this.usageFile, JSON.stringify({
            api_call_count: this.apiCallCount,
            input_tokens: this.inputTokens,
            output_tokens: this.outputTokens,
            cache_hit_tokens: this.cacheHitTokens,
            custom_api_call_count: this.customApiCallCount,
            custom_input_tokens: this.customInputTokens,
            custom_output_tokens: this.customOutputTokens,
            custom_cache_hit_tokens: this.customCacheHitTokens
        }, null, 2), 'utf8');
        this.dirtyCount = 0;
    }

    incrementApiCallCount() {
        this.apiCallCount++;
        this.customApiCallCount++;
        this.dirtyCount++;
        if (this.dirtyCount >= this.DIRTY_FLUSH_THRESHOLD) this._saveUsage();
    }

    incrementTokenUsage(inputTokens, outputTokens, cacheHitTokens) {
        const capped = Math.min(cacheHitTokens || 0, inputTokens || 0);
        this.inputTokens += inputTokens || 0;
        this.outputTokens += outputTokens || 0;
        this.cacheHitTokens += capped;
        this.customInputTokens += inputTokens || 0;
        this.customOutputTokens += outputTokens || 0;
        this.customCacheHitTokens += capped;
        this.dirtyCount++;
        if (this.dirtyCount >= this.DIRTY_FLUSH_THRESHOLD) this._saveUsage();
    }

    flushApiCallCounts() {
        if (this.dirtyCount > 0) this._saveUsage();
        this._flushDailyUsage();
    }

    getUsageStats() {
        return {
            api_call_count: this.apiCallCount,
            input_tokens: this.inputTokens,
            output_tokens: this.outputTokens,
            cache_hit_tokens: this.cacheHitTokens,
            custom_api_call_count: this.customApiCallCount,
            custom_input_tokens: this.customInputTokens,
            custom_output_tokens: this.customOutputTokens,
            custom_cache_hit_tokens: this.customCacheHitTokens
        };
    }

    resetCustomStats() {
        this.customApiCallCount = 0;
        this.customInputTokens = 0;
        this.customOutputTokens = 0;
        this.customCacheHitTokens = 0;
        this._saveUsage();
    }

    // ==================== Daily Usage ====================

    /**
     * 记录每日使用量（仅写内存，达到阈值或 flush 时才写入文件）
     */
    recordDailyUsage(inputTokens, outputTokens, cacheHitTokens) {
        const now = new Date();
        const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
        const dayKey = String(now.getDate()).padStart(2, '0');

        if (!this._dailyBuffer[monthKey]) this._dailyBuffer[monthKey] = {};
        if (!this._dailyBuffer[monthKey][dayKey]) {
            this._dailyBuffer[monthKey][dayKey] = {api_calls: 0, input_tokens: 0, output_tokens: 0, cache_hit_tokens: 0};
        }
        this._dailyBuffer[monthKey][dayKey].api_calls++;
        this._dailyBuffer[monthKey][dayKey].input_tokens += inputTokens || 0;
        this._dailyBuffer[monthKey][dayKey].output_tokens += outputTokens || 0;
        this._dailyBuffer[monthKey][dayKey].cache_hit_tokens += Math.min(cacheHitTokens || 0, inputTokens || 0);

        this._dailyDirtyCount++;
        if (this._dailyDirtyCount >= this._DAILY_DIRTY_FLUSH_THRESHOLD) {
            this._flushDailyUsage();
        }
    }

    /**
     * 将内存中的 daily 增量合并写入文件
     * 使用"读取-合并-写入"模式确保不丢失其他 worker 的数据
     */
    _flushDailyUsage() {
        if (this._dailyDirtyCount === 0) return;

        try {
            let dailyData = {};
            if (existsSync(this.dailyUsageFile)) {
                try {
                    dailyData = JSON.parse(readFileSync(this.dailyUsageFile, 'utf8'));
                } catch {}
            }

            // 合并内存增量到文件数据
            for (const [monthKey, monthData] of Object.entries(this._dailyBuffer)) {
                if (!dailyData[monthKey]) dailyData[monthKey] = {};
                for (const [dayKey, dayData] of Object.entries(monthData)) {
                    if (!dailyData[monthKey][dayKey]) {
                        dailyData[monthKey][dayKey] = {api_calls: 0, input_tokens: 0, output_tokens: 0, cache_hit_tokens: 0};
                    }
                    dailyData[monthKey][dayKey].api_calls += dayData.api_calls || 0;
                    dailyData[monthKey][dayKey].input_tokens += dayData.input_tokens || 0;
                    dailyData[monthKey][dayKey].output_tokens += dayData.output_tokens || 0;
                    dailyData[monthKey][dayKey].cache_hit_tokens += dayData.cache_hit_tokens || 0;
                }
            }

            // 清理旧数据（> 3个月）
            const now = new Date();
            const cutoff = new Date(now.getFullYear(), now.getMonth() - 3, 1);
            const cutoffKey = `${cutoff.getFullYear()}-${String(cutoff.getMonth() + 1).padStart(2, '0')}`;
            for (const key of Object.keys(dailyData)) {
                if (key < cutoffKey) delete dailyData[key];
            }

            writeFileSync(this.dailyUsageFile, JSON.stringify(dailyData, null, 2), 'utf8');

            // 清空内存缓冲
            this._dailyBuffer = {};
            this._dailyDirtyCount = 0;
        } catch (err) {
            logger.error(`Failed to flush daily usage: ${err.message}`);
        }
    }

    /**
     * 获取当前 worker 的每日使用内存增量（供 /internal/stats/daily 端点使用）
     * @returns {object}
     */
    getDailyUsageBuffer() {
        return this._dailyBuffer;
    }

    getDailyUsage(month) {
        // 先 flush 确保内存数据已写入
        this._flushDailyUsage();
        if (!existsSync(this.dailyUsageFile)) return {};
        try {
            const dailyData = JSON.parse(readFileSync(this.dailyUsageFile, 'utf8'));
            if (month) return dailyData[month] || {};
            return dailyData;
        } catch { return {}; }
    }

    getAvailableMonths() {
        this._flushDailyUsage();
        if (!existsSync(this.dailyUsageFile)) return [];
        try {
            const dailyData = JSON.parse(readFileSync(this.dailyUsageFile, 'utf8'));
            return Object.keys(dailyData).sort().reverse().slice(0, 3);
        } catch { return []; }
    }

    // ==================== Proxy Config ====================

    _loadProxy() {
        if (existsSync(this.proxyFile)) {
            try {
                const data = JSON.parse(readFileSync(this.proxyFile, 'utf8'));
                // 兼容旧格式（http_proxy/https_proxy）和新格式（proxy）
                this.proxy = data.proxy || data.https_proxy || data.http_proxy || null;
                this.skipTlsVerify = data.skip_tls_verify === true || data.skipTlsVerify === true || data.reject_unauthorized === false || data.rejectUnauthorized === false;
                return;
            } catch {}
        }
        this.proxy = null;
        this.skipTlsVerify = false;
        this._saveProxy();
    }

    _saveProxy() {
        writeFileSync(this.proxyFile, JSON.stringify({
            proxy: this.proxy,
            skip_tls_verify: this.skipTlsVerify,
            updated_at: new Date().toISOString()
        }, null, 2), 'utf8');
    }

    getProxyConfig() {
        return {
            proxy: this.proxy,
            skip_tls_verify: this.skipTlsVerify
        };
    }

    getProxyUrl() {
        return this.proxy || null;
    }

    getRejectUnauthorized() {
        return !this.skipTlsVerify;
    }

    updateProxyConfig(proxy, skipTlsVerify = false) {
        const normalizedProxy = typeof proxy === 'string' && proxy.trim() ? proxy.trim() : null;
        const normalizedSkipTlsVerify = skipTlsVerify === true;
        const changed = this.proxy !== normalizedProxy || this.skipTlsVerify !== normalizedSkipTlsVerify;

        this.proxy = normalizedProxy;
        this.skipTlsVerify = normalizedSkipTlsVerify;
        this._saveProxy();
        logger.info(`Proxy config updated: ${this.proxy || 'direct'}, skip TLS verify: ${this.skipTlsVerify}`);

        // 广播到其他 worker 同步代理配置
        if (changed) broadcast('copilot-proxy-updated').catch(() => {});

        return changed;
    }

    // ==================== Multi-process Support ====================

    /**
     * 重新加载配置（多进程同步用）
     */
    reload() {
        this._loadProxy();
    }

    // ==================== Credential Info (封装 copilotState) ====================

    isAuthenticated() {
        return !!copilotState.githubToken;
    }

    getUserInfo() {
        return copilotState.userInfo;
    }

    getTokenStatus() {
        return {
            hasGithubToken: !!copilotState.githubToken,
            hasCopilotToken: !!copilotState.copilotToken,
            copilotTokenExpired: copilotState.isCopilotTokenExpired(),
            accountType: copilotState.accountType,
            vsCodeVersion: copilotState.vsCodeVersion
        };
    }
}

export const copilotStore = new CopilotStore();
