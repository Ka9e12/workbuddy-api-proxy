/**
 * 核心凭证验证
 * 管理员登录验证、网关令牌验证
 * 从环境变量加载凭证配置
 * @module services/gateway/auth
 */

import {createHash, timingSafeEqual} from 'crypto';
import {existsSync, readFileSync, writeFileSync} from 'fs';
import {join} from 'path';
import {rsaKeyManager} from './rsa-keys.js';
import {ApiKeyStore, apiKeyStore, maskToken, normalizeScope} from './api-key-store.js';
import logger from '../../utils/logger.js';
import {broadcast} from '../../utils/cluster-broadcaster.js';

const GATEWAY_DIR = '.gateway';
export {ApiKeyStore, GATEWAY_DIR};

/**
 * 十六进制摘要的常量时间比较，消除计时侧信道。
 * 长度检查放在 Buffer.from 之后：非法 hex 会被静默截断而非抛错，
 * 必须靠长度不等提前返回，避免 timingSafeEqual 抛 RangeError。
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function timingSafeEqualHex(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    const ba = Buffer.from(a, 'hex');
    const bb = Buffer.from(b, 'hex');
    if (ba.length === 0 || ba.length !== bb.length) return false;
    return timingSafeEqual(ba, bb);
}

/** 测试专用导出（下划线前缀表示内部实现，不应在业务代码里直接调用） */
export {timingSafeEqualHex as _timingSafeEqualHex};

// 缓存的配置值
let adminUsername = 'admin';
let adminPasswordHash = null;
let store = apiKeyStore;
let _initialized = false;

/**
 * 当前使用的 Key 存储（测试可替换）
 * @returns {ApiKeyStore}
 */
function keyStore() {
    return store;
}

/**
 * 取磁盘顺序上的第一条 Key
 * 面板、指南、copilot/relay 的展示都按它来，语义是「默认 Key」
 * @returns {Object|null}
 */
function firstKey() {
    return keyStore().list()[0] || null;
}

/**
 * 加载管理员凭证
 * 配置了 ADMIN_PASSWORD 则启用管理后台登录；未配置则禁用（首页与管理面板直接开放）
 */
function _loadAdminCredentials() {
    if (process.env.ADMIN_PASSWORD) {
        adminUsername = process.env.ADMIN_USERNAME || 'admin';
        adminPasswordHash = createHash('sha256').update(process.env.ADMIN_PASSWORD).digest('hex');
        logger.info('Admin credentials loaded from ADMIN_PASSWORD env');
        return;
    }

    // 未配置密码：禁用管理后台认证，任何人都可直接访问首页与管理面板
    adminPasswordHash = null;
    logger.warn(
        'ADMIN_PASSWORD not set — admin panel authentication is DISABLED. ' +
            'Anyone with network access can view/edit credentials and API keys. ' +
            'Set ADMIN_PASSWORD in .env to re-enable login.'
    );
}

/**
 * 初始化鉴权配置
 * @param {Object} [opts]
 * @param {string} [opts.gatewayDir] - 覆盖 `.gateway` 目录（测试用）
 */
export function initGatewayAuth(opts = {}) {
    if (_initialized) return;

    // 确保 RSA 密钥对已初始化
    rsaKeyManager.init();

    // 加载或生成管理员凭证
    _loadAdminCredentials();

    // 加载多 Key 存储（内部完成旧单令牌文件的迁移）
    store = opts.gatewayDir ? new ApiKeyStore(opts.gatewayDir) : apiKeyStore;
    store.init();

    _initialized = true;
}

/**
 * 管理后台认证是否启用
 * @returns {boolean}
 */
export function isAdminAuthEnabled() {
    return adminPasswordHash !== null;
}

/**
 * 更新 .env 文件中的某个变量
 * @param {string} key - 变量名
 * @param {string|null} value - 值；null 表示注释掉该行（禁用）
 * @returns {boolean} 是否写入成功
 */
function updateEnvVar(key, value) {
    const envFile = join(process.cwd(), '.env');
    if (!existsSync(envFile)) return false;
    try {
        const lines = readFileSync(envFile, 'utf8').split('\n');
        let found = false;
        const out = lines.map((line) => {
            const trimmed = line.trim();
            // 兼容 "#KEY=..." 与 "# KEY=..." 两种注释写法
            const uncommented = trimmed.replace(/^#\s*/, '');
            const keyOf = uncommented.split('=')[0].trim();
            if (keyOf !== key) return line;
            found = true;
            if (value === null) {
                // 已注释则保持原样，否则加 # 注释掉
                return trimmed.startsWith('#') ? line : '#' + line;
            }
            // 生效：标准格式写回
            return `${key}=${value}`;
        });
        if (!found && value !== null) {
            out.push(`${key}=${value}`);
        }
        writeFileSync(envFile, out.join('\n'), 'utf8');
        return true;
    } catch (err) {
        logger.error(`更新 .env 变量 ${key} 失败:`, err.message);
        return false;
    }
}

/**
 * 清除管理员账号密码，恢复免密登录
 * 同时清空内存凭证与 .env 文件中的 ADMIN_PASSWORD / ADMIN_USERNAME
 * @returns {{success: boolean, envUpdated: boolean, error?: string}}
 */
export function clearAdminCredentials() {
    // 1. 清内存
    adminPasswordHash = null;
    adminUsername = 'admin';
    delete process.env.ADMIN_PASSWORD;
    delete process.env.ADMIN_USERNAME;

    // 2. 更新 .env 文件（注释掉相关行，保留原值便于恢复）
    const envUpdated = updateEnvVar('ADMIN_PASSWORD', null) & updateEnvVar('ADMIN_USERNAME', null);

    logger.warn('管理后台凭证已清除，已恢复免密登录（.env 已更新）');
    return {success: true, envUpdated: envUpdated === 1};
}

/**
 * 设置管理员账号密码，启用登录校验
 * 同时更新内存凭证与 .env 文件
 * @param {string} username - 用户名
 * @param {string} password - 明文密码
 * @returns {{success: boolean, envUpdated: boolean, error?: string}}
 */
export function setAdminCredentials(username, password) {
    if (!password || !String(password).trim()) {
        return {success: false, envUpdated: false, error: '密码不能为空'};
    }
    const user = (username && String(username).trim()) || 'admin';

    // 1. 更新内存
    adminUsername = user;
    adminPasswordHash = createHash('sha256').update(String(password)).digest('hex');
    process.env.ADMIN_USERNAME = user;
    process.env.ADMIN_PASSWORD = String(password);

    // 2. 写回 .env
    const u = updateEnvVar('ADMIN_USERNAME', user);
    const p = updateEnvVar('ADMIN_PASSWORD', String(password));

    logger.info(`管理后台已设置账号密码（用户名: ${user}），登录校验已启用`);
    return {success: true, envUpdated: u && p};
}

/**
 * 重新加载管理员凭证（多进程同步用）
 * 收到 admin-credentials-cleared 广播时调用：无条件清空内存凭证，恢复免密
 * （广播语义为"已清除"，其他 worker 的 process.env 仍是旧值，不能据此重读）
 */
export function reloadAdminCredentials() {
    adminPasswordHash = null;
    adminUsername = 'admin';
    delete process.env.ADMIN_PASSWORD;
    delete process.env.ADMIN_USERNAME;
    logger.warn('Admin credentials cleared via cluster sync — 免密登录已生效');
}

/**
 * 从广播同步设置的管理员凭证（多进程同步用）
 * @param {string} username
 * @param {string} passwordHash - 已计算的 SHA256 哈希
 */
export function reloadAdminCredentialsFromSync(username, passwordHash) {
    adminUsername = username || 'admin';
    adminPasswordHash = passwordHash || null;
    logger.info('Admin credentials updated via cluster sync');
}

/**
 * 网关鉴权是否启用
 * 只要至少有一条 Key 就启用；Key 列表永不为空（删除最后一条被拒绝）
 * @returns {boolean}
 */
export function isGatewayAuthEnabled() {
    return keyStore().list().length > 0;
}

/**
 * 获取默认 Key 的哈希（供各 store 透传使用）
 * @returns {string|null}
 */
export function getGatewayTokenHash() {
    return firstKey()?.token_hash || null;
}

/**
 * 获取默认 Key 的前缀（用于日志显示）
 * @returns {string|null}
 */
export function getGatewayTokenPrefix() {
    return firstKey()?.token_prefix || null;
}

/**
 * 按明文令牌解析出 Key 记录
 * @param {string} token
 * @returns {{id: string, label: string, allowedCredentialFiles: null|string[]}|null}
 */
export function resolveGatewayKey(token) {
    return keyStore().resolve(token);
}

/**
 * 验证管理员凭证
 * 未配置 ADMIN_PASSWORD（免密模式）时：任何提交都通过（允许留空直接登录）
 * @param {string} username - 用户名
 * @param {string} encryptedPassword - RSA 加密后的密码（Base64），或明文密码（非安全上下文降级）
 * @returns {{valid: boolean, error?: string}}
 */
export function verifyAdminCredentials(username, encryptedPassword) {
    // 免密模式：未设置密码，任何提交直接通过
    if (!isAdminAuthEnabled()) {
        return {valid: true};
    }

    // 验证用户名
    if (username !== adminUsername) {
        return {valid: false, error: 'Invalid credentials'};
    }

    let password;

    // 非字符串（undefined/对象等）直接拒绝，避免下面的正则对隐式字符串化产生误判
    if (typeof encryptedPassword !== 'string') {
        return {valid: false, error: 'Invalid credentials'};
    }

    // 判断是否为 RSA 加密数据（Base64 且长度 > 512 字节，RSA-4096 加密结果约 512+ 字节）
    const isBase64 = /^[A-Za-z0-9+/]*={0,2}$/.test(encryptedPassword);
    const isLikelyEncrypted = isBase64 && Buffer.from(encryptedPassword, 'base64').length >= 512;

    if (isLikelyEncrypted) {
        // RSA 解密
        const decrypted = rsaKeyManager.decrypt(encryptedPassword);
        if (decrypted !== null) {
            password = decrypted;
        } else {
            return {valid: false, error: 'Decryption failed'};
        }
    } else {
        // 明文密码（非安全上下降级）
        password = encryptedPassword;
    }

    // SHA256 哈希比对（常量时间，消除计时侧信道）
    const hash = createHash('sha256').update(password).digest('hex');
    if (timingSafeEqualHex(hash, adminPasswordHash)) {
        logger.info(`Admin login successful: ${username}`);
        return {valid: true};
    }

    return {valid: false, error: 'Invalid credentials'};
}

/**
 * 验证网关令牌
 * 只回 boolean：多 Key 后调用方（如 WS 升级）不需要知道是哪条 Key，
 * 需要作用域的地方用 resolveGatewayKey。
 * @param {string} token - 客户端提供的令牌
 * @returns {boolean}
 */
export function verifyGatewayToken(token) {
    return resolveGatewayKey(token) !== null;
}

/**
 * 从请求头提取并验证网关令牌
 * @param {object} headers - HTTP 请求头
 * @returns {{authenticated: boolean, key?: Object, error?: string}}
 */
export function authenticateGatewayRequest(headers) {
    if (!isGatewayAuthEnabled()) {
        return {authenticated: false, error: 'Gateway authentication is not configured'};
    }

    // 提取 token：优先 Authorization: Bearer，兼容 x-api-key
    let token = null;
    const auth = headers['authorization'];
    if (auth) {
        token = auth.startsWith('Bearer ') ? auth.slice(7) : auth;
    }
    if (!token) {
        token = headers['x-api-key'];
    }

    if (!token) {
        return {authenticated: false, error: 'Missing API key. Set Authorization: Bearer <token>'};
    }

    const key = resolveGatewayKey(token);
    if (!key) {
        logger.warn('Gateway authentication failed: invalid token');
        return {authenticated: false, error: 'Invalid gateway token'};
    }

    return {authenticated: true, key};
}

/**
 * 获取默认 Key 的信息（供前端管理页面使用）
 * @returns {{prefix: string, hash: string, key: string|null, apiKeyPlain: string|null}}
 */
export function getGatewayApiKeyInfo() {
    const key = firstKey();
    return {
        prefix: key?.token_prefix || 'sk-****',
        hash: key?.token_hash || null,
        key: key?.token_plain || null,
        apiKeyPlain: key?.token_plain || null
    };
}

/**
 * 列出全部 Key（面板用）
 * @returns {Array<{id, label, prefix, plain, createdAt, allowedCredentialFiles}>}
 */
export function listGatewayApiKeys() {
    return keyStore().list().map((k) => ({
        id: k.id,
        label: k.label,
        prefix: k.token_prefix,
        plain: k.token_plain,
        createdAt: k.created_at,
        allowedCredentialFiles: k.allowed_credential_files ?? null
    }));
}

/**
 * 新建 Key
 * @param {Object} [opts]
 * @returns {Object}
 */
export function createGatewayApiKey(opts) {
    const created = keyStore().create(opts);
    broadcast('gateway-api-keys-changed').catch(() => {});
    return created;
}

/**
 * 更新 Key（label / 允许的 CodeBuddy 账号）
 * @param {string} id
 * @param {Object} patch
 * @returns {Object|null}
 */
export function updateGatewayApiKey(id, patch) {
    if (patch && Object.prototype.hasOwnProperty.call(patch, 'allowedCredentialFiles')) {
        // 走一遍清洗，把非法文件名挡在存储层之前
        patch = {...patch, allowedCredentialFiles: normalizeScope(patch.allowedCredentialFiles)};
    }
    const updated = keyStore().update(id, patch);
    if (updated) broadcast('gateway-api-keys-changed').catch(() => {});
    return updated;
}

/**
 * 删除 Key
 * @param {string} id
 * @returns {{ok: boolean, error?: string}}
 */
export function deleteGatewayApiKey(id) {
    const result = keyStore().remove(id);
    if (result.ok) broadcast('gateway-api-keys-changed').catch(() => {});
    return result;
}

/**
 * 重置指定 Key 的明文
 * @param {string} id
 * @returns {Object|null}
 */
export function regenerateApiKey(id) {
    const updated = keyStore().regenerate(id);
    if (updated) broadcast('gateway-api-keys-changed').catch(() => {});
    return updated;
}

/**
 * 重置默认（第一条）Key，兼容三个面板既有的「重置 API Key」按钮
 * @returns {string|null} 新明文
 */
export function regenerateGatewayToken() {
    const result = keyStore().regenerateFirst();
    if (!result) return null;
    logger.info('Gateway token regenerated');
    broadcast('gateway-api-keys-changed').catch(() => {});
    return result.token;
}

/**
 * 从文件重新加载 Key 列表（多进程同步用）
 */
export function reloadGatewayToken() {
    keyStore().reload();
}

/** 别名：语义更清晰的同义入口 */
export const reloadGatewayApiKeys = reloadGatewayToken;

/**
 * 掩码工具透出（面板侧统一口径）
 */
export {maskToken};
