/**
 * Relay 存储管理器
 * 管理 API Key 鉴权、UpstreamManager 实例及使用量统计
 * @module services/relay/relay-store
 */

import {readFileSync, writeFileSync, mkdirSync, existsSync} from 'fs';
import {join} from 'path';
import logger from '../../utils/logger.js';
import {RELAY_CREDS_DIR} from './config.js';
import {UpstreamManager} from './upstream-manager.js';
import {broadcast} from '../../utils/cluster-broadcaster.js';

const USAGE_FILE = 'usage.json';
const DAILY_USAGE_FILE = 'daily_usage.json';

class RelayStore {
    constructor() {
        this.baseDir = join(process.cwd(), RELAY_CREDS_DIR);
        this.usageFile = join(this.baseDir, USAGE_FILE);
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

        // Daily usage memory buffer
        this._dailyBuffer = {};
        this._dailyDirtyCount = 0;
        this._DAILY_DIRTY_FLUSH_THRESHOLD = 10;

        // Upstream manager
        this.upstreamManager = null;

        this._init();
    }

    _init() {
        if (!existsSync(this.baseDir)) mkdirSync(this.baseDir, {recursive: true});
        this._loadUsage();
        this.upstreamManager = new UpstreamManager(this.baseDir);
    }

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
            } catch {
            }
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

    getUpstreamManager() {
        return this.upstreamManager;
    }

    incrementApiCallCount() {
        this.apiCallCount++;
        this.customApiCallCount++;
        this.dirtyCount++;
        if (this.dirtyCount >= this.DIRTY_FLUSH_THRESHOLD) this._saveUsage();
    }

    incrementTokenUsage(inputTokens, outputTokens, cacheHitTokens = 0) {
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
    recordDailyUsage(inputTokens, outputTokens, cacheHitTokens = 0, model = 'unknown') {
        const now = new Date();
        const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
        const dayKey = String(now.getDate()).padStart(2, '0');

        if (!this._dailyBuffer[monthKey]) this._dailyBuffer[monthKey] = {};
        if (!this._dailyBuffer[monthKey][dayKey]) {
            this._dailyBuffer[monthKey][dayKey] = {api_calls: 0, input_tokens: 0, output_tokens: 0, cache_hit_tokens: 0};
        }
        this._dailyBuffer[monthKey][dayKey].api_calls += 1;
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
     */
    _flushDailyUsage() {
        if (this._dailyDirtyCount === 0) return;

        try {
            let dailyData = {};
            if (existsSync(this.dailyUsageFile)) {
                try { dailyData = JSON.parse(readFileSync(this.dailyUsageFile, 'utf8')); } catch {}
            }

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

            // Cleanup old data (> 3 months)
            const now = new Date();
            const cutoff = new Date(now.getFullYear(), now.getMonth() - 3, 1);
            const cutoffKey = `${cutoff.getFullYear()}-${String(cutoff.getMonth() + 1).padStart(2, '0')}`;
            for (const mk of Object.keys(dailyData)) {
                if (mk < cutoffKey) delete dailyData[mk];
            }

            writeFileSync(this.dailyUsageFile, JSON.stringify(dailyData, null, 2), 'utf8');
            this._dailyBuffer = {};
            this._dailyDirtyCount = 0;
        } catch (err) {
            logger.error(`Failed to flush daily usage: ${err.message}`);
        }
    }

    /**
     * 获取当前 worker 的每日使用内存增量（供 /internal/stats/daily 端点使用）
     */
    getDailyUsageBuffer() {
        return this._dailyBuffer;
    }

    getDailyUsage(monthKey) {
        this._flushDailyUsage();
        if (!existsSync(this.dailyUsageFile)) return null;
        try {
            const dailyData = JSON.parse(readFileSync(this.dailyUsageFile, 'utf8'));
            return dailyData[monthKey] || null;
        } catch {
            return null;
        }
    }

    getAvailableMonths() {
        this._flushDailyUsage();
        if (!existsSync(this.dailyUsageFile)) return [];
        try {
            const dailyData = JSON.parse(readFileSync(this.dailyUsageFile, 'utf8'));
            return Object.keys(dailyData).sort().reverse().slice(0, 3);
        } catch {
            return [];
        }
    }

    // ==================== Multi-process Support ====================

    /**
     * 重新加载配置（多进程同步用）
     */
    reload() {
        this.upstreamManager.reload();
    }
}

export const relayStore = new RelayStore();
