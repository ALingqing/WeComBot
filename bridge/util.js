/**
 * 工具模块
 * 分级日志、指数退避重试、配置校验、字符串工具
 */

const LEVELS = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };
const LEVEL_NAMES = ['DEBUG', 'INFO', 'WARN', 'ERROR'];
let currentLevel = process.env.LOG_LEVEL || 'INFO';
const TRUNCATE_LOG = 200;

// ========== 日志 ==========

function log(level, module, message, data) {
    const lv = LEVELS[level];
    if (lv === undefined || lv < LEVELS[currentLevel]) return;

    const ts = new Date().toISOString().replace('T', ' ').substring(0, 19);
    const prefix = '[' + ts + '][' + level.padEnd(5) + '][' + module + ']';
    let output = prefix + ' ' + message;

    if (data !== undefined) {
        try {
            const str = typeof data === 'string' ? data : JSON.stringify(data);
            output += ' ' + (str.length > TRUNCATE_LOG ? str.substring(0, TRUNCATE_LOG) + '...' : str);
        } catch (_) {
            output += ' [data omitted]';
        }
    }

    if (lv >= LEVELS.ERROR) {
        console.error(output);
    } else if (lv >= LEVELS.WARN) {
        console.warn(output);
    } else {
        console.log(output);
    }
}

const logger = {
    debug: (m, msg, d) => log('DEBUG', m, msg, d),
    info:  (m, msg, d) => log('INFO',  m, msg, d),
    warn:  (m, msg, d) => log('WARN',  m, msg, d),
    error: (m, msg, d) => log('ERROR', m, msg, d),
    setLevel: (l) => { if (LEVELS[l]) currentLevel = l; }
};

// ========== 重试 ==========

/**
 * 带指数退避的异步重试
 *
 * @param {Function} fn       异步函数, 签名: fn(attemptNumber) => Promise
 * @param {Object}   opts
 * @param {number}   opts.retries      最大重试次数 (默认 3)
 * @param {number}   opts.baseDelay    初始延迟 ms (默认 1000)
 * @param {number}   opts.maxDelay     最大延迟 ms (默认 10000)
 * @param {Function} opts.shouldRetry  判断是否应重试, 签名: err => boolean
 * @returns {Promise}
 */
async function retry(fn, opts) {
    const { retries = 3, baseDelay = 1000, maxDelay = 10000 } = opts || {};
    const shouldRetry = (opts && opts.shouldRetry) ? opts.shouldRetry : isServerError;
    let lastErr;

    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            return await fn(attempt);
        } catch (err) {
            lastErr = err;
            if (attempt >= retries) break;
            if (!shouldRetry(err)) break;
            const delay = Math.min(baseDelay * Math.pow(2, attempt), maxDelay);
            logger.warn('retry', 'attempt ' + (attempt + 1) + '/' + retries +
                ' 失败, ' + delay + 'ms 后重试: ' + err.message);
            await sleep(delay);
        }
    }
    throw lastErr;
}

/** 判断是否为可重试的服务器错误 */
function isServerError(err) {
    if (!err) return false;
    // HTTP 5xx
    if (err.response && err.response.status >= 500) return true;
    // 网络错误
    if (err.code === 'ECONNREFUSED' || err.code === 'ECONNRESET' ||
        err.code === 'ETIMEDOUT' || err.code === 'ENOTFOUND' ||
        err.code === 'EAI_AGAIN' || err.code === 'ECONNABORTED') return true;
    return false;
}

// ========== 配置校验 ==========

/** 校验 config.json 完整性 */
function validateConfig(config) {
    const errors = [];
    if (!config) return ['config 为空'];

    if (!config.server) errors.push('server 配置缺失');
    if (!config.wecom) errors.push('wecom 配置缺失');

    if (config.wecom && config.wecom.webhook_url) {
        const url = config.wecom.webhook_url;
        if (!url.startsWith('https://qyapi.weixin.qq.com/')) {
            errors.push('webhook_url 格式异常, 应以 https://qyapi.weixin.qq.com/ 开头');
        }
        if (!url.includes('key=')) {
            errors.push('webhook_url 缺少 key 参数');
        }
    }

    // Token 和 AES Key 必须成对出现
    const hasToken = !!(config.wecom && config.wecom.token);
    const hasAes = !!(config.wecom && config.wecom.encoding_aes_key);
    if (hasToken !== hasAes) {
        errors.push('token 和 encoding_aes_key 必须同时配置或同时留空');
    }

    if (config.handler && config.handler.name) {
        const valid = ['webhook', 'echo'];
        if (!valid.includes(config.handler.name)) {
            errors.push('未知 handler: ' + config.handler.name + ', 可用: ' + valid.join(', '));
        }
    }

    if (config.handler && config.handler.name === 'webhook' && !config.handler.config) {
        errors.push('webhook handler 需要 handler.config 配置');
    }

    if (config.binding && config.binding.enabled) {
        const validModes = ['TWO_WAY', 'TRUST'];
        if (config.binding.mode && !validModes.includes(config.binding.mode)) {
            errors.push('未知 binding.mode: ' + config.binding.mode + ', 可用: ' + validModes.join(', '));
        }
    }

    return errors;
}

// ========== 字符串工具 ==========

function truncate(str, max) {
    if (!str) return '';
    if (str.length <= max) return str;
    return str.substring(0, max) + '...';
}

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

module.exports = { logger, retry, isServerError, validateConfig, truncate, sleep };
