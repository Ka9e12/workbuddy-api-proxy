/**
 * GitHub API 服务
 * @module services/copilot/github-api
 */

import { request, readBody } from '../../utils/http-client.js';
import {
    GITHUB_API_BASE_URL,
    GITHUB_BASE_URL,
    GITHUB_CLIENT_ID,
    GITHUB_APP_SCOPES,
    githubHeaders,
    standardHeaders
} from './config.js';

function applyNetworkOptions(options, proxyUrl, networkOptions = {}) {
    if (proxyUrl) options.proxyUrl = proxyUrl;
    if (typeof networkOptions.rejectUnauthorized === 'boolean') {
        options.rejectUnauthorized = networkOptions.rejectUnauthorized;
    }
    if (typeof networkOptions.timeout === 'number' && networkOptions.timeout > 0) {
        options.timeout = networkOptions.timeout;
    }
    return options;
}

/**
 * 获取设备代码
 * @param {string} [proxyUrl] - 代理地址
 * @param {number} [timeout=30000] - 请求超时（毫秒），默认 30s
 * @param {object} [networkOptions] - 网络选项
 * @param {boolean} [networkOptions.rejectUnauthorized] - 是否校验 TLS 证书
 * @returns {Promise<{device_code: string, user_code: string, verification_uri: string, expires_in: number, interval: number}>}
 */
export async function getDeviceCode(proxyUrl, timeout = 30000, networkOptions = {}) {
    const requestTimeout = typeof networkOptions.timeout === 'number' && networkOptions.timeout > 0
        ? networkOptions.timeout
        : timeout;
    const options = applyNetworkOptions({
        method: 'POST',
        headers: {
            ...standardHeaders(),
            'accept': 'application/json'
        },
        body: JSON.stringify({
            client_id: GITHUB_CLIENT_ID,
            scope: GITHUB_APP_SCOPES
        }),
        timeout: requestTimeout
    }, proxyUrl, networkOptions);

    const response = await request(`${GITHUB_BASE_URL}/login/device/code`, options);

    if (response.status !== 200) {
        throw new Error(`Failed to get device code: ${response.status}`);
    }

    const body = await readBody(response.body, requestTimeout);
    return JSON.parse(body);
}

/**
 * 轮询获取访问令牌
 * @param {string} deviceCode - 设备代码
 * @param {number} interval - 轮询间隔（秒）
 * @param {number} expiresIn - 过期时间（秒）
 * @returns {Promise<{access_token: string, token_type: string, scope: string}>}
 */
export async function pollAccessToken(deviceCode, interval = 5, expiresIn = 900) {
    const startTime = Date.now();
    const expiresAt = startTime + expiresIn * 1000;

    while (Date.now() < expiresAt) {
        await new Promise(resolve => setTimeout(resolve, interval * 1000));

        const response = await request(`${GITHUB_BASE_URL}/login/oauth/access_token`, {
            method: 'POST',
            headers: {
                ...standardHeaders(),
                'accept': 'application/json'
            },
            body: JSON.stringify({
                client_id: GITHUB_CLIENT_ID,
                device_code: deviceCode,
                grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
            })
        });

        const body = await readBody(response.body);
        const data = JSON.parse(body);

        if (data.error) {
            if (data.error === 'authorization_pending') {
                continue;
            } else if (data.error === 'slow_down') {
                interval += 5;
                continue;
            } else {
                throw new Error(`Failed to get access token: ${data.error}`);
            }
        }

        if (data.access_token) {
            return data;
        }
    }

    throw new Error('Device code expired');
}

/**
 * 获取用户信息
 * @param {string} githubToken - GitHub token
 * @param {string} vsCodeVersion - VS Code 版本
 * @returns {Promise<{login: string, id: number, avatar_url: string}>}
 */
export async function getUser(githubToken, vsCodeVersion, proxyUrl, networkOptions = {}) {
    const timeout = typeof networkOptions.timeout === 'number' && networkOptions.timeout > 0
        ? networkOptions.timeout
        : 30000;
    const response = await request(`${GITHUB_API_BASE_URL}/user`, applyNetworkOptions({
        method: 'GET',
        headers: githubHeaders(githubToken, vsCodeVersion),
        timeout
    }, proxyUrl, networkOptions));

    const body = await readBody(response.body, timeout);
    
    if (response.status !== 200) {
        let errorMessage = `Failed to get user: ${response.status}`;
        try {
            const errorData = JSON.parse(body);
            if (errorData.message) {
                errorMessage += ` - ${errorData.message}`;
            }
        } catch (e) {
            errorMessage += ` - ${body}`;
        }
        throw new Error(errorMessage);
    }

    return JSON.parse(body);
}

/**
 * 获取 Copilot token
 * @param {string} githubToken - GitHub token
 * @param {string} vsCodeVersion - VS Code 版本
 * @param {string} [proxyUrl] - 代理地址
 * @returns {Promise<{token: string, expires_at: number, refresh_in: number}>}
 */
export async function getCopilotToken(githubToken, vsCodeVersion, proxyUrl, networkOptions = {}) {
    const timeout = typeof networkOptions.timeout === 'number' && networkOptions.timeout > 0
        ? networkOptions.timeout
        : 30000;
    const options = applyNetworkOptions({
        method: 'GET',
        headers: githubHeaders(githubToken, vsCodeVersion),
        timeout
    }, proxyUrl, networkOptions);

    const response = await request(`${GITHUB_API_BASE_URL}/copilot_internal/v2/token`, options);

    if (response.status !== 200) {
        throw new Error(`Failed to get Copilot token: ${response.status}`);
    }

    const body = await readBody(response.body, timeout);
    return JSON.parse(body);
}

/**
 * 获取 Copilot 使用情况
 * @param {string} githubToken - GitHub token
 * @param {string} vsCodeVersion - VS Code 版本
 * @returns {Promise<object>}
 */
export async function getCopilotUsage(githubToken, vsCodeVersion) {
    const response = await request(`${GITHUB_API_BASE_URL}/copilot/usage`, {
        method: 'GET',
        headers: githubHeaders(githubToken, vsCodeVersion)
    });

    if (response.status !== 200) {
        throw new Error(`Failed to get Copilot usage: ${response.status}`);
    }

    const body = await readBody(response.body);
    return JSON.parse(body);
}
