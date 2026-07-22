/**
 * Echo Handler - 回显处理器 (测试用)
 *
 * 收到消息后直接回复同样的内容。
 * 用于测试企业微信连通性和延迟。
 *
 * 用法: config.json 中设置 handler.name = "echo"
 */

const { logger } = require('../util');

function create(config, wecom, binding) {
    const name = 'echo';

    async function onMessage(wecomId, content, groupId) {
        const elapsed = Date.now();
        logger.info('echo', '收到: from=' + wecomId + ' content=' + content);
        const result = await wecom.sendText('已收到 (' + (Date.now() - elapsed) + 'ms): ' + content);
        logger.info('echo', '回复: ' + (result.ok ? 'ok' : 'fail'));
    }

    async function onEvent(wecomId, event, groupId) {
        logger.info('echo', '事件: ' + event + ' from=' + wecomId);
    }

    function sendMessage(msgType, content, extra) {
        if (msgType === 'markdown') return wecom.sendMarkdown('[echo] ' + content);
        if (msgType === 'markdown_v2') return wecom.sendMarkdownV2('[echo] ' + content);
        return wecom.sendText('[echo] ' + content);
    }

    return { name, onMessage, onEvent, sendMessage };
}

module.exports = { create };
