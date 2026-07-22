/**
 * WeCom Bridge - 企业微信通用消息桥接器
 *
 * 接收企业微信群消息, 通过 Handler 转发到任意后端服务。
 * 也可以从后端接收消息, 通过企业微信 Webhook 发到群。
 *
 * 特性:
 *   - 插件化 Handler 系统, 可对接任意后端
 *   - 消息队列 + 频率限制 (20条/分钟)
 *   - 企业微信回调 AES 加解密
 *   - 可选绑定系统 (验证码/信任模式)
 *   - 请求日志、健康检查、Prometheus 指标
 *
 * 启动:
 *   npm install
 *   npm start
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const { logger, validateConfig, getDataDir } = require('./util');
const { createWeCom } = require('./wecom');
const { loadHandler } = require('./handler-loader');
const { createBinding } = require('./binding');
const { createApi } = require('./api');

// ---- 加载配置 ----
const configPath = path.join(getDataDir(), 'config.json');
let config;
try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
} catch (e) {
    console.error('[FATAL] 无法加载 config.json: ' + e.message);
    process.exit(1);
}

// ---- 配置校验 ----
const configErrors = validateConfig(config);
if (configErrors.length > 0) {
    for (const err of configErrors) {
        logger.warn('config', '配置警告: ' + err);
    }
}

// ---- 初始化 ----
const wecom = createWeCom(config);
const binding = config.binding && config.binding.enabled ? createBinding(config) : null;
const handler = loadHandler(config, wecom, binding);

// ---- HTTP 服务 ----
const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.text({ type: 'application/xml', limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

createApi(app, config, { wecom, handler, binding });

// ---- 启动 ----
const host = config.server.host || '0.0.0.0';
const port = config.server.port || 5700;
const server = app.listen(port, host, () => {
    logger.info('startup', '=========================================');
    logger.info('startup', '  WeCom Bridge v1.0.0');
    logger.info('startup', '  企业微信通用消息桥接器');
    logger.info('startup', '=========================================');
    logger.info('startup', '  地址:      ' + host + ':' + port);
    logger.info('startup', '  企微:      ' + (config.wecom.webhook_url ? '已配置' : '未配置'));
    logger.info('startup', '  回调:      ' + (config.wecom.token ? '已配置' : '未配置'));
    logger.info('startup', '  Handler:   ' + (handler ? handler.name : '无'));
    logger.info('startup', '  绑定系统:  ' + (binding ? '已启用' : '已禁用'));
    logger.info('startup', '=========================================');
    logger.info('startup', '  端点:');
    logger.info('startup', '  POST /api/send       发消息到企业微信');
    logger.info('startup', '  POST /api/send_raw   发原始消息');
    logger.info('startup', '  GET  /api/wecom/cb   企微 URL 验证');
    logger.info('startup', '  POST /api/wecom/cb   企微消息回调');
    logger.info('startup', '  GET  /api/status     服务状态');
    logger.info('startup', '  GET  /api/health     健康检查');
    logger.info('startup', '  GET  /api/metrics    指标');
    if (binding) {
        logger.info('startup', '  POST /api/bind      绑定管理');
        logger.info('startup', '  GET  /api/bindings  绑定列表');
    }
    logger.info('startup', '=========================================');
});

// ---- 优雅关闭 ----
function shutdown(signal) {
    logger.info('shutdown', '收到 ' + signal + ', 正在关闭...');
    server.close(() => {
        logger.info('shutdown', 'HTTP 服务已关闭');
        process.exit(0);
    });
    // 强制退出
    setTimeout(() => {
        console.error('[FATAL] 强制退出');
        process.exit(1);
    }, 10000);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (err) => {
    logger.error('process', '未捕获异常: ' + err.message);
    console.error(err.stack);
});
process.on('unhandledRejection', (reason) => {
    logger.error('process', '未处理的 Promise 拒绝: ' + (reason ? reason.message || reason : 'unknown'));
});
