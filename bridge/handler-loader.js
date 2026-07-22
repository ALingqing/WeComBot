/**
 * Handler 加载器
 *
 * Handler 是插件化的消息处理器, 负责将企业微信消息转发到后端服务。
 * 你可以编写自己的 Handler 对接任意系统。
 *
 * 内置 Handler:
 *   - webhook: 通过 HTTP POST 转发事件到指定 URL (默认)
 *   - echo:    回显测试
 *
 * 自定义 Handler:
 *   在 handlers/ 目录下创建 js 文件, config.handler.name 配置为文件名(不含 .js)
 *   例如 handlers/myapp.js → handler.name = "myapp"
 *
 * Handler 接口:
 *   {
 *     name: 'myapp',
 *     // 收到企业微信消息时
 *     onMessage(wecomId, content, groupId) => Promise,
 *     // 收到企业微信事件时
 *     onEvent(wecomId, event, groupId, eventKey) => Promise,
 *     // 后端调用 /api/send 时实际发消息
 *     sendMessage(type, content, extra) => Promise
 *   }
 */

const fs = require('fs');
const path = require('path');
const { logger } = require('./util');

/** 内置 handler 白名单 (防止加载任意文件) */
const BUILTIN_HANDLERS = ['webhook', 'echo'];

function loadHandler(config, wecom, binding) {
    const handlerName = config.handler && config.handler.name ? config.handler.name : 'webhook';

    // 只允许加载内置 handler
    if (!BUILTIN_HANDLERS.includes(handlerName)) {
        logger.warn('handler', '未知 handler: ' + handlerName + ', 可选: ' + BUILTIN_HANDLERS.join(', '));
        logger.info('handler', '使用默认 webhook handler');
        return loadBuiltin('webhook', config, wecom, binding);
    }

    return loadBuiltin(handlerName, config, wecom, binding);
}

function loadBuiltin(name, config, wecom, binding) {
    const filePath = path.join(__dirname, 'handlers', name + '.js');
    if (!fs.existsSync(filePath)) {
        logger.error('handler', '内置 handler 文件缺失: ' + filePath);
        return createNullHandler();
    }

    try {
        const mod = require(filePath);
        const instance = (typeof mod.create === 'function') ? mod.create(config, wecom, binding) : mod;

        if (!instance || !instance.name) {
            throw new Error('Handler 必须暴露 name 属性');
        }

        // 接口校验
        const required = ['onMessage', 'onEvent', 'sendMessage'];
        const missing = required.filter(r => typeof instance[r] !== 'function');
        if (missing.length > 0) {
            throw new Error('Handler 缺少方法: ' + missing.join(', '));
        }

        logger.info('handler', '加载成功: ' + name);
        return instance;
    } catch (e) {
        logger.error('handler', '加载失败: ' + name + ' - ' + e.message);
        return createNullHandler();
    }
}

function createNullHandler() {
    return {
        name: 'null',
        onMessage: async () => {},
        onEvent: async () => {},
        sendMessage: async () => ({ ok: false, error: '无 handler' })
    };
}

module.exports = { loadHandler };
