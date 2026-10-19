/**
 * 核心凭证验证
 * 管理员登录验证、网关令牌验证
 * 从环境变量加载凭证配置
 * @module services/gateway/auth
 */

import {createHash, randomBytes, timingSafeEqual} from 'crypto';
import {existsSync, mkdirSync, writeFileSync, readFileSync} from 'fs';
import {join} from 'path';
import {rsaKeyManager} from './rsa-keys.js';
import logger from '../../utils/logger.js';
import {broadcast} from '../../utils/cluster-broadcaster.js';

const GATEWAY_DIR = '.gateway';
const GATEWAY_TOKEN_FILE = 'gateway_token.json';

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
let gatewayToken = null;
let gatewayTokenHash = null;
let gatewayTokenPrefix = null;
let _initialized = false;

/**
 * 生成网关令牌（格式：sk-xxx）
 * @returns {string}
 */
function generateGatewayToken() {
    return 'sk-' + randomBytes(16).toString('hex');
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
 * 加载或生成网关令牌
 * 支持持久化：若文件已存在且包含有效 token_hash，从文件加载
 * 不再支持环境变量配置，统一自动生成
 */
function _loadGatewayToken() {
    const baseDir = join(process.cwd(), GATEWAY_DIR);
    const tokenFile = join(baseDir, GATEWAY_TOKEN_FILE);

    if (!existsSync(baseDir)) {
        mkdirSync(baseDir, {recursive: true});
    }

    // 尝试从文件加载已有令牌
    if (existsSync(tokenFile)) {
        try {
            const data = JSON.parse(readFileSync(tokenFile, 'utf8'));
            if (data.token_hash) {
                gatewayTokenHash = data.token_hash;
                gatewayTokenPrefix = data.token_prefix || 'sk-****';
                gatewayToken = data.token_plain || null;
                logger.info('Gateway token loaded from file');
                return;
            }
        } catch (err) {
            logger.error('Failed to load gateway token file:', err.message);
        }
    }

    // 首次运行或文件损坏，生成新令牌
    gatewayToken = generateGatewayToken();
    gatewayTokenHash = createHash('sha256').update(gatewayToken).digest('hex');
    gatewayTokenPrefix = gatewayToken.substring(0, 12) + '****';

    _saveGatewayToken();

    logger.info('========================================');
    logger.info('  Gateway token auto-generated');
    logger.info(`  Token: ${gatewayToken}`);
    logger.info('  Please save this token, it will not be shown again.');
    logger.info('========================================');
}

/**
 * 保存网关令牌到文件
 */
function _saveGatewayToken() {
    const baseDir = join(process.cwd(), GATEWAY_DIR);
    const tokenFile = join(baseDir, GATEWAY_TOKEN_FILE);

    writeFileSync(
        tokenFile,
        JSON.stringify(
            {
                token_hash: gatewayTokenHash,
                token_prefix: gatewayTokenPrefix,
                token_plain: gatewayToken,
                created_at: new Date().toISOString()
            },
            null,
            2
        ),
        'utf8'
    );
}

/**
 * 初始化鉴权配置
 */
export function initGatewayAuth() {
    if (_initialized) return;

    // 确保 RSA 密钥对已初始化
    rsaKeyManager.init();

    // 加载或生成管理员凭证
    _loadAdminCredentials();

    // 加载或生成网关令牌
    _loadGatewayToken();

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
 * 网关令牌认证是否启用
 * @returns {boolean}
 */
export function isGatewayAuthEnabled() {
    return gatewayTokenHash !== null;
}

/**
 * 获取网关令牌哈希（供各 store 透传使用）
 * @returns {string|null}
 */
export function getGatewayTokenHash() {
    return gatewayTokenHash;
}

/**
 * 获取网关令牌前缀（用于日志显示）
 * @returns {string|null}
 */
export function getGatewayTokenPrefix() {
    return gatewayTokenPrefix;
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
 * @param {string} token - 客户端提供的令牌
 * @returns {boolean}
 */
export function verifyGatewayToken(token) {
    if (!isGatewayAuthEnabled()) return false;
    if (typeof token !== 'string' || !token) return false;
    const hash = createHash('sha256').update(token).digest('hex');
    return timingSafeEqualHex(hash, gatewayTokenHash);
}

/**
 * 从请求头提取并验证网关令牌
 * @param {object} headers - HTTP 请求头
 * @returns {{authenticated: boolean, error?: string}}
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

    if (!verifyGatewayToken(token)) {
        logger.warn('Gateway authentication failed: invalid token');
        return {authenticated: false, error: 'Invalid gateway token'};
    }

    return {authenticated: true};
}

/**
 * 获取网关令牌信息（供前端管理页面使用）
 * @returns {{prefix: string, hash: string, key: string|null, apiKeyPlain: string|null}}
 */
export function getGatewayApiKeyInfo() {
    return {
        prefix: gatewayTokenPrefix,
        hash: gatewayTokenHash,
        key: gatewayToken,
        apiKeyPlain: gatewayToken
    };
}

/**
 * 重新生成网关令牌
 * 影响所有端点鉴权，调用后旧令牌立即失效
 * @returns {string} 新生成的令牌明文
 */
export function regenerateGatewayToken() {
    gatewayToken = generateGatewayToken();
    gatewayTokenHash = createHash('sha256').update(gatewayToken).digest('hex');
    gatewayTokenPrefix = gatewayToken.substring(0, 12) + '****';

    _saveGatewayToken();

    logger.info('Gateway token regenerated');

    // 广播到其他 worker 同步令牌
    broadcast('gateway-token-regenerated').catch(() => {});

    return gatewayToken;
}

/**
 * 从文件重新加载网关令牌（多进程同步用）
 * 仅从文件读取，不生成新令牌
 */
export function reloadGatewayToken() {
    _reloadGatewayToken();
}

/**
 * 内部实现：从文件重新加载网关令牌
 */
function _reloadGatewayToken() {
    const baseDir = join(process.cwd(), GATEWAY_DIR);
    const tokenFile = join(baseDir, GATEWAY_TOKEN_FILE);

    if (!existsSync(tokenFile)) {
        logger.warn('Gateway token file not found during reload');
        return;
    }

    try {
        const data = JSON.parse(readFileSync(tokenFile, 'utf8'));
        if (data.token_hash) {
            gatewayTokenHash = data.token_hash;
            gatewayTokenPrefix = data.token_prefix || 'sk-****';
            gatewayToken = data.token_plain || null;
            logger.info('Gateway token reloaded from file (cluster sync)');
        }
    } catch (err) {
        logger.error('Failed to reload gateway token:', err.message);
    }
}
