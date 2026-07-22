/**
 * HTTP API 路由
 *
 * 提供以下端点:
 *   发送消息: POST /api/send, /api/send_raw
 *   企微回调: GET/POST /api/wecom/cb
 *   绑定管理: POST /api/bind, GET /api/bindings
 *   状态:     GET /api/status, /api/health, /api/metrics
 */

const crypto = require('crypto');
const { logger, truncate } = require('./util');

function createApi(app, config, { wecom, handler, binding }) {

    // ---- 请求日志中间件 ----
    app.use((req, res, next) => {
        const start = Date.now();
        res.on('finish', () => {
            const ms = Date.now() - start;
            logger.info('http', req.method + ' ' + req.path + ' -> ' + res.statusCode + ' (' + ms + 'ms)');
        });
        next();
    });

    // ---- 全局错误捕获 ----
    app.use((err, req, res, _next) => {
        logger.error('http', '未捕获异常: ' + err.message);
        res.status(500).json({ ok: false, error: '内部错误: ' + err.message });
    });

    // ============================================================
    //  消息发送
    // ============================================================

    /** POST /api/send - 发送消息到企业微信 */
    app.post('/api/send', async (req, res) => {
        try {
            const { type, content, title, description, url, picurl, base64, md5, media_id } = req.body;

            if (!type) {
                return res.json({ ok: false, error: 'type 为必填 (text|markdown|markdown_v2|news|image|file)' });
            }

            let result;
            switch (type) {
                case 'text':
                    if (!content) return res.json({ ok: false, error: 'content 为必填' });
                    result = await wecom.sendText(content);
                    break;
                case 'markdown':
                    if (!content) return res.json({ ok: false, error: 'content 为必填' });
                    result = await wecom.sendMarkdown(content);
                    break;
                case 'markdown_v2':
                    if (!content) return res.json({ ok: false, error: 'content 为必填' });
                    result = await wecom.sendMarkdownV2(content);
                    break;
                case 'news':
                    if (!title && !content) return res.json({ ok: false, error: 'title 或 content 为必填' });
                    result = await wecom.sendNews(title || content, description, url, picurl);
                    break;
                case 'image':
                    if (!base64 || !md5) return res.json({ ok: false, error: 'base64 和 md5 为必填' });
                    result = await wecom.sendImage(base64, md5);
                    break;
                case 'file':
                    if (!media_id) return res.json({ ok: false, error: 'media_id 为必填' });
                    result = await wecom.sendFile(media_id);
                    break;
                default:
                    return res.json({ ok: false, error: '不支持的 type: ' + type });
            }

            logger.info('api.send', type + ' -> ' + (result.ok ? 'ok' : 'fail'));
            res.json(result);
        } catch (e) {
            logger.error('api.send', '异常: ' + e.message);
            res.json({ ok: false, error: e.message });
        }
    });

    /** POST /api/send_raw - 发送原始消息体 */
    app.post('/api/send_raw', async (req, res) => {
        try {
            const body = req.body;
            if (!body || !body.msgtype) {
                return res.json({ ok: false, error: 'body 必须包含 msgtype 字段' });
            }
            const result = await wecom.send(body);
            res.json(result);
        } catch (e) {
            res.json({ ok: false, error: e.message });
        }
    });

    // ============================================================
    //  企业微信回调
    // ============================================================

    /** GET /api/wecom/cb - URL 验证 (企业微信配置回调时自动触发) */
    app.get('/api/wecom/cb', (req, res) => {
        const { msg_signature, timestamp, nonce, echostr } = req.query;

        if (!msg_signature || !timestamp || !nonce || !echostr) {
            logger.warn('cb.get', '参数不完整', req.query);
            return res.status(400).send('missing params');
        }

        const token = config.wecom.token;
        if (!token) {
            // 未配置 token 时直接返回
            logger.warn('cb.get', 'token 未配置, 直接返回 echostr');
            return res.send(decodeURIComponent(echostr));
        }

        // 验证签名
        if (!wecom.verifySignature(token, timestamp, nonce, msg_signature)) {
            logger.error('cb.get', '签名验证失败');
            return res.status(403).send('verify failed');
        }

        const decoded = decodeURIComponent(echostr);

        // 有 AES Key 时需要解密
        if (config.wecom.encoding_aes_key) {
            try {
                const plain = wecom.decrypt(config.wecom.encoding_aes_key, decoded);
                logger.info('cb.get', 'URL 验证成功 (已解密)');
                return res.send(plain);
            } catch (e) {
                logger.error('cb.get', '解密失败: ' + e.message);
                return res.status(500).send('decrypt failed');
            }
        }

        logger.info('cb.get', 'URL 验证成功');
        res.send(decoded);
    });

    /** POST /api/wecom/cb - 接收企业微信消息回调 */
    app.post('/api/wecom/cb', async (req, res) => {
        // 无论处理成功与否, 始终返回 200 避免企业微信重试
        const respondOk = () => {
            res.set('Content-Type', 'application/xml; charset=utf-8');
            const corpId = config.wecom.corp_id || '';

            if (config.wecom.encoding_aes_key && config.wecom.token) {
                try {
                    const replyXml = wecom.buildReplyXml(corpId, 'system', 'ok');
                    const encrypted = wecom.encryptReplyXml(
                        replyXml,
                        config.wecom.token,
                        config.wecom.encoding_aes_key
                    );
                    return res.send(encrypted);
                } catch (_) {
                    // 加密失败时回退明文
                }
            }
            res.send(wecom.buildReplyXml(corpId, 'system', 'ok'));
        };

        try {
            let rawBody = '';
            if (typeof req.body === 'string') {
                rawBody = req.body;
            } else if (Buffer.isBuffer(req.body)) {
                rawBody = req.body.toString('utf8');
            } else if (typeof req.body === 'object' && req.body !== null) {
                rawBody = JSON.stringify(req.body);
            } else {
                rawBody = String(req.body || '');
            }

            if (!rawBody) {
                logger.warn('cb.post', '空请求体');
                return respondOk();
            }

            const { msg_signature, timestamp, nonce } = req.query;

            // ---- 解密流程 ----
            let xml = rawBody;
            if (config.wecom.encoding_aes_key && config.wecom.token && msg_signature) {
                const parsed = wecom.parseXml(xml);
                const encrypt = parsed.Encrypt;
                if (encrypt) {
                    // 验证完整签名 (包含 Encrypt)
                    const sigOk = wecom.verifyFullSignature(
                        config.wecom.token, timestamp, nonce, encrypt, msg_signature
                    );
                    if (!sigOk) {
                        logger.warn('cb.post', '签名验证失败, 跳过处理');
                        return respondOk();
                    }
                    xml = wecom.decrypt(config.wecom.encoding_aes_key, encrypt);
                    logger.info('cb.post', '解密成功');
                }
            }

            // ---- 解析 XML ----
            const msg = wecom.parseXml(xml);
            const msgType = msg.MsgType;
            const fromUser = msg.FromUserName;
            const content = msg.Content;
            const event = msg.Event;
            const eventKey = msg.EventKey;
            const msgId = msg.MsgId;
            const groupId = msg.ChatId || '';

            logger.info('cb.post',
                'type=' + msgType +
                ' from=' + fromUser +
                (groupId ? ' group=' + groupId : '') +
                ' content=' + truncate(content, 60)
            );

            // ---- 基于 MsgId 去重 ----
            if (msgId) {
                const dedupKey = 'cb_' + msgId;
                if (global.__callbackDedup && global.__callbackDedup[dedupKey]) {
                    logger.debug('cb.post', '重复消息, 跳过: ' + msgId);
                    return respondOk();
                }
                if (!global.__callbackDedup) global.__callbackDedup = {};
                global.__callbackDedup[dedupKey] = true;
                setTimeout(() => { delete global.__callbackDedup[dedupKey]; }, 6000);
            }

            // ---- 路由处理 ----
            if (msgType === 'text' && content) {
                await handleMessage(fromUser, content.trim(), groupId);
            } else if (msgType === 'event') {
                await handleEvent(fromUser, event, groupId, eventKey);
            } else {
                logger.info('cb.post', '未处理的消息类型: ' + msgType);
            }

            respondOk();
        } catch (e) {
            logger.error('cb.post', '处理异常: ' + e.message);
            respondOk();
        }
    });

    // ============================================================
    //  消息/事件处理
    // ============================================================

    /** 处理企业微信消息 */
    async function handleMessage(fromUser, content, groupId) {
        try {
            // 1. 绑定命令
            if (binding && (content.startsWith('bind ') || content.startsWith('绑定'))) {
                const code = content.replace(/^(bind|绑定)\s*/i, '').trim();
                if (!code) {
                    await safeReply('格式: bind <验证码>');
                    return;
                }
                let externalId = binding.bindWithCode(fromUser, code);
                if (externalId) {
                    await safeReply('绑定成功, 外部ID: ' + externalId);
                    logger.info('binding', '绑定成功: ' + fromUser + ' -> ' + externalId);
                } else if (config.binding && config.binding.mode === 'TRUST') {
                    externalId = binding.bindDirect(fromUser, code);
                    if (externalId) {
                        await safeReply('绑定成功, 外部ID: ' + externalId);
                    } else {
                        await safeReply('绑定失败');
                    }
                } else {
                    await safeReply('验证码无效或已过期');
                }
                return;
            }

            // 2. 解绑
            if (binding && (content === 'unbind' || content === '解绑')) {
                const eid = binding.unbind(fromUser);
                await safeReply(eid ? '已解绑: ' + eid : '未找到绑定记录');
                return;
            }

            // 3. 查询绑定
            if (binding && (content === 'mybind' || content === '我的绑定')) {
                const info = binding.getBinding(fromUser);
                if (info) {
                    await safeReply('外部ID: ' + info.external_id);
                } else {
                    await safeReply('未绑定');
                }
                return;
            }

            // 4. 转发给外部 handler
            if (handler && handler.onMessage) {
                await handler.onMessage(fromUser, content, groupId);
            }
        } catch (e) {
            logger.error('handleMsg', '异常: ' + e.message);
        }
    }

    /** 处理企业微信事件 */
    async function handleEvent(fromUser, event, groupId, eventKey) {
        try {
            logger.info('handleEvent', 'event=' + event + ' from=' + fromUser);

            // 退群自动解绑
            if (binding && event === 'unsubscribe') {
                const eid = binding.unbind(fromUser);
                if (eid) logger.info('binding', '退群自动解绑: ' + fromUser + ' -> ' + eid);
            }

            // 转发给 handler
            if (handler && handler.onEvent) {
                await handler.onEvent(fromUser, event, groupId, eventKey);
            }
        } catch (e) {
            logger.error('handleEvent', '异常: ' + e.message);
        }
    }

    /** 安全回复（忽略错误） */
    async function safeReply(content) {
        try { await wecom.sendText(content); } catch (_) {}
    }

    // ============================================================
    //  绑定管理 API
    // ============================================================

    /** POST /api/bind - 绑定管理 */
    app.post('/api/bind', async (req, res) => {
        if (!binding) {
            return res.json({ ok: false, error: '绑定系统未启用, 设置 binding.enabled = true' });
        }
        try {
            const { action, wecom_id, code, external_id } = req.body;
            if (!action) return res.json({ ok: false, error: 'action 为必填' });

            let result;
            switch (action) {
                case 'generate':
                    if (!external_id) return res.json({ ok: false, error: 'external_id 为必填' });
                    result = { ok: true, code: binding.generateCode(external_id) };
                    break;
                case 'bind':
                    if (!wecom_id || !code) return res.json({ ok: false, error: 'wecom_id 和 code 为必填' });
                    const eid = binding.bindWithCode(wecom_id, code);
                    result = eid ? { ok: true, external_id: eid } : { ok: false, error: '验证码无效' };
                    break;
                case 'unbind':
                    if (!wecom_id) return res.json({ ok: false, error: 'wecom_id 为必填' });
                    const uid = binding.unbind(wecom_id);
                    result = uid ? { ok: true, external_id: uid } : { ok: false, error: '未绑定' };
                    break;
                case 'query':
                    if (!wecom_id) return res.json({ ok: false, error: 'wecom_id 为必填' });
                    const info = binding.getBinding(wecom_id);
                    result = info ? { ok: true, data: info } : { ok: false, error: '未绑定' };
                    break;
                default:
                    result = { ok: false, error: '未知 action: ' + action };
            }
            res.json(result);
        } catch (e) {
            res.json({ ok: false, error: e.message });
        }
    });

    /** GET /api/bindings - 获取所有绑定 */
    app.get('/api/bindings', (req, res) => {
        if (!binding) return res.json({ ok: false, error: '绑定系统未启用' });
        try {
            const list = binding.listBindings();
            res.json({ ok: true, count: list.length, data: list });
        } catch (e) {
            res.json({ ok: false, error: e.message });
        }
    });

    // ============================================================
    //  状态与监控
    // ============================================================

    /** GET /api/status - 详细状态 */
    app.get('/api/status', (req, res) => {
        const ws = wecom.getStats ? wecom.getStats() : {};
        res.json({
            ok: true,
            adapter: 'wecom-bridge',
            version: '1.0.0',
            node_version: process.version,
            uptime: Math.floor(process.uptime()),
            timestamp: Date.now(),
            config: {
                wecom_configured: !!config.wecom.webhook_url,
                callback_configured: !!(config.wecom.token && config.wecom.encoding_aes_key),
                handler: handler ? handler.name : null,
                binding_enabled: !!binding,
                binding_mode: config.binding ? config.binding.mode : null
            },
            stats: {
                wecom: ws,
                memory: {
                    rss: Math.round(process.memoryUsage().rss / 1024 / 1024) + 'MB',
                    heap: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + 'MB'
                }
            }
        });
    });

    /** GET /api/health - 健康检查 */
    app.get('/api/health', (req, res) => {
        res.json({ status: 'ok', uptime: Math.floor(process.uptime()), timestamp: Date.now() });
    });

    /** GET /api/metrics - Prometheus 风格指标 */
    app.get('/api/metrics', (req, res) => {
        const ws = wecom.getStats ? wecom.getStats() : {};
        let m = '';
        m += '# HELP wecom_sent_total 已发送消息总数\n';
        m += '# TYPE wecom_sent_total counter\n';
        m += 'wecom_sent_total ' + (ws.sent || 0) + '\n';
        m += '# HELP wecom_failed_total 发送失败总数\n';
        m += '# TYPE wecom_failed_total counter\n';
        m += 'wecom_failed_total ' + (ws.failed || 0) + '\n';
        m += '# HELP wecom_queue_pending 等待队列长度\n';
        m += '# TYPE wecom_queue_pending gauge\n';
        m += 'wecom_queue_pending ' + (ws.queuePending || 0) + '\n';
        m += '# HELP wecom_rate_remaining 当前窗口剩余条数\n';
        m += '# TYPE wecom_rate_remaining gauge\n';
        m += 'wecom_rate_remaining ' + (ws.rateRemaining || 0) + '\n';
        m += '# HELP wecom_bindings 绑定总数\n';
        m += '# TYPE wecom_bindings gauge\n';
        m += 'wecom_bindings ' + (binding ? binding.listBindings().length : 0) + '\n';
        m += '# HELP process_uptime_seconds 进程运行时间\n';
        m += '# TYPE process_uptime_seconds gauge\n';
        m += 'process_uptime_seconds ' + Math.floor(process.uptime()) + '\n';
        res.set('Content-Type', 'text/plain; charset=utf-8');
        res.send(m);
    });

    // 404 兜底
    app.use((req, res) => {
        res.status(404).json({ ok: false, error: 'Not Found: ' + req.method + ' ' + req.path });
    });

    return app;
}

module.exports = { createApi };