/**
 * Webhook Handler - 默认消息处理器
 *
 * 将企业微信消息通过 HTTP POST 转发到指定的后端 URL。
 * 支持重试、签名验证、超时控制。
 *
 * 事件推送格式:
 *   POST {event_url}
 *   {
 *     "type": "message" | "event",
 *     "sub_type": "text" | "subscribe" | "unsubscribe",
 *     "user_id": "xxx",
 *     "group_id": "xxx",
 *     "content": "消息内容",
 *     "time": 1700000000
 *   }
 *
 * 后端也可通过 POST /api/send 发消息到企业微信。
 */

const axios = require('axios');
const crypto = require('crypto');
const { logger, retry, isServerError } = require('../util');

function create(config, wecom, binding) {
    const hc = config.handler.config || {};
    const eventUrl = hc.event_url;
    const secret = hc.secret || '';
    const timeout = hc.timeout || 5000;
    const name = 'webhook';

    /** 收到企业微信消息时 */
    async function onMessage(wecomId, content, groupId) {
        if (!eventUrl) {
            logger.debug('webhook', 'event_url 未配置, 跳过推送');
            return;
        }
        return pushEvent({
            type: 'message',
            sub_type: 'text',
            user_id: wecomId,
            group_id: groupId,
            content: content,
            time: Math.floor(Date.now() / 1000)
        });
    }

    /** 收到企业微信事件时 */
    async function onEvent(wecomId, event, groupId, eventKey) {
        if (!eventUrl) return;
        return pushEvent({
            type: 'event',
            sub_type: event,
            user_id: wecomId,
            group_id: groupId,
            event_key: eventKey || null,
            time: Math.floor(Date.now() / 1000)
        });
    }

    /** 后端调用此方法发消息到企业微信 */
    function sendMessage(msgType, content, extra) {
        if (msgType === 'markdown') return wecom.sendMarkdown(content);
        if (msgType === 'markdown_v2') return wecom.sendMarkdownV2(content);
        if (msgType === 'news') {
            return wecom.sendNews(
                (extra && extra.title) || content,
                extra && extra.description,
                extra && extra.url,
                extra && extra.picurl
            );
        }
        return wecom.sendText(content);
    }

    /** 推送事件到后端 (带重试) */
    async function pushEvent(event) {
        const headers = { 'Content-Type': 'application/json' };
        if (secret) {
            // HMAC-SHA256 签名
            const payload = JSON.stringify(event);
            const sig = crypto.createHmac('sha256', secret).update(payload).digest('hex');
            headers['X-Webhook-Secret'] = secret;
            headers['X-Webhook-Signature'] = sig;
        }

        try {
            const res = await retry(() =>
                axios.post(eventUrl, event, { timeout, headers, validateStatus: () => true }),
                { retries: 2, baseDelay: 500, shouldRetry: isServerError }
            );

            if (res.status >= 200 && res.status < 300) {
                logger.info('webhook', '事件推送成功 [' + event.type + '.' + (event.sub_type || '') + '] -> ' + res.status);
            } else {
                logger.warn('webhook', '事件推送返回 ' + res.status + ' [' + event.type + ']');
            }
            return res.data;
        } catch (e) {
            logger.error('webhook', '事件推送失败 [' + event.type + ']: ' + e.message);
        }
    }

    return { name, onMessage, onEvent, sendMessage };
}

module.exports = { create };
