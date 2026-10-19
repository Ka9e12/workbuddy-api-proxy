/**
 * 无状态会话管理
 * 使用 HMAC-SHA256 签名的 Cookie 实现无状态 session
 * @module services/gateway/session
 */

import {createHmac, randomBytes} from 'crypto';
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'fs';
import {join} from 'path';
import logger from '../../utils/logger.js';
import {intEnv} from '../../utils/env.js';

const GATEWAY_DIR = '.gateway';
const SESSION_SECRET_FILE = 'session_secret';
const COOKIE_NAME = 'cap_session';
const DEFAULT_MAX_AGE = 86400000; // 24 小时

let sessionSecret = null;

/**
 * 获取或生成 SESSION_SECRET
 * 优先从环境变量读取，其次从文件读取，最后自动生成
 * @returns {string}
 */
function getSessionSecret() {
    if (sessionSecret) return sessionSecret;

    // 1. 环境变量
    if (process.env.SESSION_SECRET) {
        sessionSecret = process.env.SESSION_SECRET;
        return sessionSecret;
    }

    // 2. 从文件读取
    const baseDir = join(process.cwd(), GATEWAY_DIR);
    const secretFile = join(baseDir, SESSION_SECRET_FILE);

    if (existsSync(secretFile)) {
        try {
            sessionSecret = readFileSync(secretFile, 'utf8').trim();
            return sessionSecret;
        } catch (err) {
            logger.warn('Failed to read session secret file, generating new one');
        }
    }

    // 3. 自动生成并持久化
    if (!existsSync(baseDir)) {
        mkdirSync(baseDir, {recursive: true});
    }
    sessionSecret = randomBytes(32).toString('hex');
    writeFileSync(secretFile, sessionSecret, 'utf8');
    logger.info('Session secret generated and saved');
    return sessionSecret;
}

/**
 * 获取 session 最大有效期（毫秒）
 * @returns {number}
 */
function getMaxAge() {
    return intEnv('SESSION_MAX_AGE', {default: DEFAULT_MAX_AGE, min: 1000});
}

/**
 * 创建 HMAC-SHA256 签名
 * @param {string} payload - 待签名数据
 * @returns {string} 十六进制签名
 */
function sign(payload) {
    const secret = getSessionSecret();
    return createHmac('sha256', secret).update(payload).digest('hex');
}

/**
 * 创建 session token
 * 格式：username.issuedAt.expiry.hmacSignature
 * @param {string} username - 用户名
 * @returns {string} session token
 */
export function createSessionToken(username) {
    const now = Date.now();
    const expiry = now + getMaxAge();
    const payload = `${username}.${now}.${expiry}`;
    const signature = sign(payload);
    return `${payload}.${signature}`;
}

/**
 * 验证 session token
 * @param {string} token - session token
 * @returns {{valid: boolean, username?: string}}
 */
export function verifySessionToken(token) {
    if (!token || typeof token !== 'string') {
        return {valid: false};
    }

    const parts = token.split('.');
    if (parts.length !== 4) {
        return {valid: false};
    }

    const [username, issuedAtStr, expiryStr, signature] = parts;
    const payload = `${username}.${issuedAtStr}.${expiryStr}`;

    // 验证签名
    const expectedSignature = sign(payload);
    if (signature !== expectedSignature) {
        return {valid: false};
    }

    // 验证过期
    const expiry = parseInt(expiryStr, 10);
    if (isNaN(expiry) || Date.now() > expiry) {
        return {valid: false};
    }

    return {valid: true, username};
}

/**
 * 解析请求中的 Cookie 头
 * @param {object} req - HTTP 请求对象
 * @returns {Map<string, string>}
 */
export function parseCookies(req) {
    const cookies = new Map();
    const header = req.headers['cookie'];
    if (!header) return cookies;

    for (const part of header.split(';')) {
        const [name, ...valueParts] = part.trim().split('=');
        if (name && valueParts.length > 0) {
            cookies.set(name.trim(), valueParts.join('=').trim());
        }
    }
    return cookies;
}

/**
 * 获取 session cookie 名称
 * @returns {string}
 */
export function getCookieName() {
    return COOKIE_NAME;
}

/**
 * 生成 Set-Cookie 头字符串
 * @param {string} token - session token
 * @param {boolean} isSecure - 是否通过 HTTPS
 * @returns {string} Set-Cookie 头值
 */
export function createSessionCookie(token, isSecure = false) {
    const maxAge = getMaxAge();
    let cookie = `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(maxAge / 1000)}`;
    if (isSecure) {
        cookie += '; Secure';
    }
    return cookie;
}

/**
 * 生成清除 session cookie 的 Set-Cookie 头
 * @returns {string} Set-Cookie 头值
 */
export function clearSessionCookie() {
    return `${COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
}

/**
 * 检查 session 是否需要续期（超过一半有效期时自动续期）
 * @param {string} token - session token
 * @returns {boolean}
 */
export function shouldRenewSession(token) {
    const parts = token.split('.');
    if (parts.length !== 4) return false;

    const issuedAt = parseInt(parts[1], 10);
    const expiry = parseInt(parts[2], 10);
    if (isNaN(issuedAt) || isNaN(expiry)) return false;

    const maxAge = expiry - issuedAt;
    const elapsed = Date.now() - issuedAt;
    return elapsed > maxAge / 2;
}
