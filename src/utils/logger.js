/**
 * 异步日志系统模块
 * 使用 process.nextTick 实现异步日志，避免阻塞事件循环
 * 支持日志级别控制
 * @module utils/logger
 */

// 日志级别常量
const LOG_LEVELS = {
    DEBUG: 0,
    INFO: 1,
    WARN: 2,
    ERROR: 3,
    NONE: 4
};

// 默认日志级别
const DEFAULT_LOG_LEVEL = process.env.LOG_LEVEL ? 
    (LOG_LEVELS[process.env.LOG_LEVEL.toUpperCase()] !== undefined ? 
        LOG_LEVELS[process.env.LOG_LEVEL.toUpperCase()] : LOG_LEVELS.INFO) : 
    LOG_LEVELS.INFO;

// 当前日志级别
let currentLogLevel = DEFAULT_LOG_LEVEL;

/**
 * 设置日志级别
 * @param {string} level - 日志级别: debug, info, warn, error, none
 */
export function setLogLevel(level) {
    const upperLevel = level.toUpperCase();
    if (LOG_LEVELS[upperLevel] !== undefined) {
        currentLogLevel = LOG_LEVELS[upperLevel];
    }
}

/**
 * 异步日志记录函数
 * @param {string} level - 日志级别
 * @param {string} message - 日志消息
 * @param {...any} args - 额外参数
 */
function logAsync(level, message, ...args) {
    // 检查日志级别
    if (LOG_LEVELS[level.toUpperCase()] < currentLogLevel) {
        return;
    }

    // 使用 process.nextTick 实现异步日志，避免阻塞事件循环
    process.nextTick(() => {
        const timestamp = new Date().toISOString();
        const levelStr = level.toUpperCase().padEnd(5);
        const logMessage = `[${timestamp}] ${levelStr} ${message}`;

        // 使用 console.log 确保所有级别的日志都能正常输出
        console.log(logMessage, ...args);
    });
}

/**
 * 调试级别日志
 * @param {string} message - 日志消息
 * @param {...any} args - 额外参数
 */
export function debug(message, ...args) {
    logAsync('DEBUG', message, ...args);
}

/**
 * 信息级别日志
 * @param {string} message - 日志消息
 * @param {...any} args - 额外参数
 */
export function info(message, ...args) {
    logAsync('INFO', message, ...args);
}

/**
 * 警告级别日志
 * @param {string} message - 日志消息
 * @param {...any} args - 额外参数
 */
export function warn(message, ...args) {
    logAsync('WARN', message, ...args);
}

/**
 * 错误级别日志
 * @param {string} message - 日志消息
 * @param {...any} args - 额外参数
 */
export function error(message, ...args) {
    logAsync('ERROR', message, ...args);
}

/**
 * 兼容性日志函数（保持向后兼容）
 * @param {string} message - 日志消息
 * @param {...any} args - 额外参数
 */
export function log(message, ...args) {
    logAsync('INFO', message, ...args);
}

// 导出默认日志函数
export default {
    debug,
    info,
    warn,
    error,
    log,
    setLogLevel
};