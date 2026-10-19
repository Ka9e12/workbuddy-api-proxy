/**
 * Copilot 状态管理
 * @module services/copilot/state
 */

import fs from 'fs';
import path from 'path';
import {fileURLToPath} from 'url';
import logger from '../../utils/logger.js';
import {broadcast} from '../../utils/cluster-broadcaster.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 状态文件路径
const STATE_DIR = path.join(__dirname, '../../../.copilot');
const GITHUB_TOKEN_FILE = path.join(STATE_DIR, 'github_token');
const COPILOT_TOKEN_FILE = path.join(STATE_DIR, 'copilot_token');
const USER_INFO_FILE = path.join(STATE_DIR, 'user_info.json');

/**
 * 确保状态目录存在
 */
function ensureStateDir() {
    if (!fs.existsSync(STATE_DIR)) {
        fs.mkdirSync(STATE_DIR, {recursive: true});
    }
}

/**
 * Copilot 状态类
 */
class CopilotState {
    constructor() {
        this.githubToken = null;
        this.copilotToken = null;
        this.copilotTokenExpiresAt = null;
        this.userInfo = null;
        this.accountType = 'individual';
        this.vsCodeVersion = '1.109.2';
        this.models = null;

        this.loadState();
    }

    /**
     * 加载状态
     */
    loadState() {
        try {
            ensureStateDir();

            // 优先从文件加载 GitHub token（推荐方式）
            if (fs.existsSync(GITHUB_TOKEN_FILE)) {
                this.githubToken = fs.readFileSync(GITHUB_TOKEN_FILE, 'utf8').trim();
            }

            // 加载 Copilot token
            if (fs.existsSync(COPILOT_TOKEN_FILE)) {
                const data = JSON.parse(fs.readFileSync(COPILOT_TOKEN_FILE, 'utf8'));
                this.copilotToken = data.token;
                this.copilotTokenExpiresAt = data.expires_at;
            }

            // 加载用户信息
            if (fs.existsSync(USER_INFO_FILE)) {
                this.userInfo = JSON.parse(fs.readFileSync(USER_INFO_FILE, 'utf8'));
            }
        } catch (error) {
            logger.error('Failed to load state:', error);
        }
    }

    /**
     * 保存 GitHub token
     * @param {string} token - GitHub token
     */
    saveGithubToken(token) {
        ensureStateDir();
        fs.writeFileSync(GITHUB_TOKEN_FILE, token, 'utf8');
        this.githubToken = token;
        logger.info('Saved GitHub token to file');
    }

    /**
     * 保存 Copilot token
     * @param {string} token - Copilot token
     * @param {number} expiresAt - 过期时间戳
     */
    saveCopilotToken(token, expiresAt) {
        ensureStateDir();
        const data = {token, expires_at: expiresAt};
        fs.writeFileSync(COPILOT_TOKEN_FILE, JSON.stringify(data), 'utf8');
        this.copilotToken = token;
        this.copilotTokenExpiresAt = expiresAt;
    }

    /**
     * 保存用户信息
     * @param {object} userInfo - 用户信息
     */
    saveUserInfo(userInfo) {
        ensureStateDir();
        fs.writeFileSync(USER_INFO_FILE, JSON.stringify(userInfo, null, 2), 'utf8');
        this.userInfo = userInfo;
        logger.info('Saved user info to file');
    }

    /**
     * 检查 Copilot token 是否过期
     * @returns {boolean}
     */
    isCopilotTokenExpired() {
        if (!this.copilotToken || !this.copilotTokenExpiresAt) {
            return true;
        }
        // 提前 5 分钟刷新
        // Copilot API 返回的 expires_at 是秒级 Unix 时间戳，需要统一单位
        const nowInSeconds = Math.floor(Date.now() / 1000);
        return nowInSeconds >= this.copilotTokenExpiresAt - 5 * 60;
    }

    /**
     * 清除状态
     * 多进程兼容：写空内容而非删除文件，确保其他 worker 能检测到变更
     */
    clearState() {
        this.githubToken = null;
        this.copilotToken = null;
        this.copilotTokenExpiresAt = null;
        this.userInfo = null;
        this.models = null;

        try {
            ensureStateDir();
            // 写空内容而非删除文件，以便集群广播时其他 worker 可以 reload
            fs.writeFileSync(GITHUB_TOKEN_FILE, '', 'utf8');
            fs.writeFileSync(COPILOT_TOKEN_FILE, '{}', 'utf8');
            fs.writeFileSync(USER_INFO_FILE, '{}', 'utf8');
            logger.info('Cleared all state files');
        } catch (error) {
            logger.error('Failed to clear state:', error);
        }

        // 广播到其他 worker 同步状态
        broadcast('copilot-auth-cleared').catch(() => {});
    }

    /**
     * 从磁盘重新加载状态（多进程同步用）
     */
    reload() {
        this.loadState();
    }
}

// 导出单例
export const copilotState = new CopilotState();
