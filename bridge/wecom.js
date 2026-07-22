/**
 * 企业微信 API 封装
 *
 * 严格遵循企业微信官方文档:
 * - 消息推送: https://developer.work.weixin.qq.com/document/path/91770
 * - 回调加解密: https://developer.work.weixin.qq.com/document/path/90968
 * - 消息接收: https://developer.work.weixin.qq.com/document/path/90238
 *
 * 限制:
 * - 每条消息最长 2048 字节 (text) / 4096 字节 (markdown)
 * - 频率限制: 20 条/分钟
 * - 文件: 普通文件 < 20M, 语音 < 2M (仅 AMR)
 * - 图片: < 2M, JPG/PNG
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { logger, retry, isServerError } = require('./util');

function createWeCom(config) {
    const { webhook_url } = config.wecom;
    const webhookKey = extractKey(webhook_url);

    // ---- 频率限制 ----
    const RATE_MAX = 20;             // 20条/分钟
    const RATE_WINDOW_MS = 60000;
    const RATE_QUEUE_MAX = 50;       // 队列最大积压
    let msgCount = 0;
    let rateWindowStart = Date.now();
    const pendingQueue = [];          // 等待队列
    let draining = false;

    // ---- 统计 ----
    let stats = { sent: 0, failed: 0, queued: 0, lastError: null, lastOk: null };

    // ========== 消息发送（带队列和重试） ==========

    /** 发送文本消息 */
    async function sendText(content) {
        assertContent(content, 2048);
        return send({ msgtype: 'text', text: { content } });
    }

    /** 发送 Markdown 消息 */
    async function sendMarkdown(content) {
        assertContent(content, 4096);
        return send({ msgtype: 'markdown', markdown: { content } });
    }

    /** 发送 Markdown v2 消息 */
    async function sendMarkdownV2(content) {
        assertContent(content, 4096);
        return send({ msgtype: 'markdown_v2', markdown_v2: { content } });
    }

    /** 发送图文消息 (1-8条) */
    async function sendNews(title, description, url, picurl) {
        if (!title || !url) return { ok: false, error: 'title 和 url 为必填' };
        return send({
            msgtype: 'news',
            news: { articles: [{ title, description: description || '', url, picurl: picurl || '' }] }
        });
    }

    /** 发送多条图文 (最多8条) */
    async function sendNewsMulti(articles) {
        if (!articles || articles.length === 0) return { ok: false, error: 'articles 不能为空' };
        if (articles.length > 8) {
            logger.warn('wecom', '图文消息最多8条，截断中');
            articles = articles.slice(0, 8);
        }
        return send({ msgtype: 'news', news: { articles } });
    }

    /** 发送图片 (base64 + md5) */
    async function sendImage(base64, md5) {
        if (!base64 || !md5) return { ok: false, error: 'base64 和 md5 为必填' };
        return send({ msgtype: 'image', image: { base64, md5 } });
    }

    /** 发送文件 */
    async function sendFile(mediaId) {
        if (!mediaId) return { ok: false, error: 'media_id 为必填' };
        return send({ msgtype: 'file', file: { media_id: mediaId } });
    }

    /** 发送语音 (AMR 格式) */
    async function sendVoice(mediaId) {
        if (!mediaId) return { ok: false, error: 'media_id 为必填' };
        return send({ msgtype: 'voice', voice: { media_id: mediaId } });
    }

    /** 通用发送入口 (带队列) */
    async function send(body) {
        // 1. 参数校验
        if (!webhook_url) return { ok: false, error: 'webhook_url 未配置' };

        // 2. 检查队列积压
        if (pendingQueue.length >= RATE_QUEUE_MAX) {
            stats.failed++;
            return { ok: false, error: '发送队列已满(' + RATE_QUEUE_MAX + ')，请稍后再试' };
        }

        // 3. 如果当前窗口未超限，直接发送
        if (checkRate()) {
            return await doSend(body);
        }

        // 4. 超限则入队等待
        stats.queued++;
        return new Promise((resolve) => {
            pendingQueue.push({ body, resolve, createdAt: Date.now() });
            if (!draining) drainQueue();
        });
    }

    /** 实际发送（单次） */
    async function doSend(body) {
        try {
            const res = await retry(() => axios.post(webhook_url, body, {
                timeout: 5000,
                headers: { 'Content-Type': 'application/json' }
            }), { retries: 2, baseDelay: 500, shouldRetry: isServerError });

            msgCount++;
            if (res.data.errcode === 0) {
                stats.sent++;
                stats.lastOk = Date.now();
                return { ok: true, message_id: String(Date.now()) };
            }

            // 频率超限错误码 45009 或 40209
            if (res.data.errcode === 45009 || res.data.errcode === 40209) {
                logger.warn('wecom', '达到频率限制，暂停发送');
                rateWindowStart = Date.now();
                msgCount = RATE_MAX; // 强制进入限流
                setImmediate(() => drainQueue());
            }

            stats.failed++;
            stats.lastError = res.data.errmsg;
            logger.error('wecom', '发送失败[' + res.data.errcode + ']', res.data.errmsg);
            return { ok: false, error: res.data.errmsg, errcode: res.data.errcode };
        } catch (e) {
            stats.failed++;
            stats.lastError = e.message;
            logger.error('wecom', '发送异常', e.message);
            return { ok: false, error: e.message };
        }
    }

    /** 消费队列 */
    async function drainQueue() {
        if (draining) return;
        draining = true;

        while (pendingQueue.length > 0) {
            // 丢弃超时 (驻留超过30秒)
            const now = Date.now();
            while (pendingQueue.length > 0 && now - pendingQueue[0].createdAt > 30000) {
                const expired = pendingQueue.shift();
                expired.resolve({ ok: false, error: '队列超时' });
                stats.failed++;
            }

            if (pendingQueue.length === 0) break;
            if (!checkRate()) {
                await sleep(1000);
                continue;
            }

            const item = pendingQueue.shift();
            const result = await doSend(item.body);
            item.resolve(result);
        }

        draining = false;
    }

    /** 检查频率 */
    function checkRate() {
        const now = Date.now();
        if (now - rateWindowStart > RATE_WINDOW_MS) {
            msgCount = 0;
            rateWindowStart = now;
        }
        return msgCount < RATE_MAX;
    }

    /** 校验消息长度 */
    function assertContent(content, maxBytes) {
        if (!content) throw new Error('content 不能为空');
        const len = Buffer.byteLength(content, 'utf8');
        if (len > maxBytes) {
            throw new Error('content 过长 (' + len + ' > ' + maxBytes + ' 字节)');
        }
    }

    // ========== 文件上传 ==========

    /** 上传文件获取 media_id (3天有效期) */
    async function uploadMedia(filePath, type) {
        const key = webhookKey;
        if (!key) throw new Error('无法从 webhook_url 提取 key');

        if (!fs.existsSync(filePath)) throw new Error('文件不存在: ' + filePath);
        const stat = fs.statSync(filePath);
        if (stat.size < 5) throw new Error('文件必须大于 5 字节');
        if (type !== 'voice' && stat.size > 20 * 1024 * 1024) throw new Error('文件超过 20M 限制');
        if (type === 'voice' && stat.size > 2 * 1024 * 1024) throw new Error('语音文件超过 2M 限制');

        const uploadUrl = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/upload_media?key=' + key + '&type=' + (type || 'file');
        const FormData = require('form-data');
        const form = new FormData();
        form.append('media', fs.createReadStream(filePath), {
            filename: path.basename(filePath),
            knownLength: stat.size
        });

        const res = await axios.post(uploadUrl, form, {
            headers: form.getHeaders(),
            maxBodyLength: stat.size + 1024,
            timeout: 30000
        });

        if (res.data.errcode === 0) {
            logger.info('wecom', '文件上传成功, media_id=' + res.data.media_id);
            return res.data.media_id;
        }
        throw new Error('上传失败[' + res.data.errcode + ']: ' + res.data.errmsg);
    }

    /** 上传本地图片并发送 */
    async function sendImageFile(filePath) {
        const buf = fs.readFileSync(filePath);
        const base64 = buf.toString('base64');
        const md5 = crypto.createHash('md5').update(buf).digest('hex');
        return sendImage(base64, md5);
    }

    function extractKey(url) {
        if (!url) return '';
        const m = url.match(/key=([^&]+)/);
        return m ? m[1] : '';
    }

    // ========== 回调加解密 ==========

    /**
     * SHA1 签名: sha1(sort(token, timestamp, nonce))
     * 用于 GET URL 验证
     */
    function verifySignature(token, timestamp, nonce, signature) {
        if (!token || !timestamp || !nonce || !signature) return false;
        const hash = sha1Sort([token, timestamp, nonce]);
        return hash === signature.toLowerCase();
    }

    /**
     * 完整签名验证: sha1(sort(token, timestamp, nonce, encrypt))
     * 用于 POST 消息回调
     */
    function verifyFullSignature(token, timestamp, nonce, encrypt, signature) {
        if (!token || !timestamp || !nonce || !encrypt || !signature) return false;
        const hash = sha1Sort([token, timestamp, nonce, encrypt]);
        return hash === signature.toLowerCase();
    }

    function sha1Sort(arr) {
        return crypto.createHash('sha1')
            .update(arr.sort().join(''))
            .digest('hex');
    }

    /**
     * AES-256-CBC 解密
     *
     * 明文格式: [16随机字节][4字节网络序长度][msg][receiveId]
     * EncodingAESKey 解码后为 32 字节 AESKey
     * IV 取 AESKey 前 16 字节
     * 填充方式: PKCS#7
     */
    function decrypt(encodingAesKey, encryptedData) {
        if (!encodingAesKey || !encryptedData) {
            throw new Error('encodingAesKey 和 encryptedData 不能为空');
        }

        // 1. EncodingAESKey + "=" 后 Base64 解码得 32 字节 AESKey
        const aesKeyBuf = Buffer.from(encodingAesKey + '=', 'base64');
        if (aesKeyBuf.length !== 32) {
            throw new Error('AESKey 长度错误: 期望 32 字节, 实际 ' + aesKeyBuf.length);
        }

        // 2. IV = AESKey 前 16 字节
        const iv = aesKeyBuf.subarray(0, 16);

        // 3. AES-256-CBC 解密
        const decipher = crypto.createDecipheriv('aes-256-cbc', aesKeyBuf, iv);
        decipher.setAutoPadding(true);
        let plain;
        try {
            plain = decipher.update(encryptedData, 'base64', 'utf8') + decipher.final('utf8');
        } catch (e) {
            throw new Error('AES 解密失败: ' + e.message);
        }

        // 4. 解析明文结构: 去掉前16随机字节
        const contentBody = plain.substring(16);

        // 5. 读4字节网络字节序 (Big Endian) 的 msg_len
        const msgLen = (contentBody.charCodeAt(0) << 24) |
                       (contentBody.charCodeAt(1) << 16) |
                       (contentBody.charCodeAt(2) << 8) |
                       contentBody.charCodeAt(3);

        if (msgLen <= 0 || msgLen > contentBody.length - 4) {
            throw new Error('msg_len 异常: ' + msgLen + ' (剩余长度 ' + (contentBody.length - 4) + ')');
        }

        // 6. 截取消息
        return contentBody.substring(4, 4 + msgLen);
    }

    /** 简单 XML 解析（非递归，仅取第一层节点） */
    function parseXml(xml) {
        if (!xml) return {};
        const result = {};
        const re = /<(\w+)>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/\1>/gi;
        let m;
        while ((m = re.exec(xml)) !== null) {
            result[m[1]] = m[2].trim();
        }
        return result;
    }

    /** 构建被动回复 XML */
    function buildReplyXml(toUser, fromUser, content) {
        const ts = Math.floor(Date.now() / 1000);
        return '<xml>\n<ToUserName><![CDATA[' + toUser + ']]></ToUserName>\n' +
            '<FromUserName><![CDATA[' + fromUser + ']]></FromUserName>\n' +
            '<CreateTime>' + ts + '</CreateTime>\n' +
            '<MsgType><![CDATA[text]]></MsgType>\n' +
            '<Content><![CDATA[' + (content || '') + ']]></Content>\n</xml>';
    }

    /** 构建加密的被动回复 XML */
    function encryptReplyXml(plainXml, token, encodingAesKey) {
        const aesKeyBuf = Buffer.from(encodingAesKey + '=', 'base64');
        const iv = aesKeyBuf.subarray(0, 16);

        // 构建待加密明文: [16随机][4字节len][msg][receiveId]
        const msgBuf = Buffer.from(plainXml, 'utf8');
        const receiveId = config.wecom.corp_id || '';
        const receiveIdBuf = Buffer.from(receiveId, 'utf8');

        const random = crypto.randomBytes(16);
        const lenBuf = Buffer.alloc(4);
        lenBuf.writeUInt32BE(msgBuf.length, 0);
        const toEncrypt = Buffer.concat([random, lenBuf, msgBuf, receiveIdBuf]);

        const cipher = crypto.createCipheriv('aes-256-cbc', aesKeyBuf, iv);
        const encrypted = Buffer.concat([cipher.update(toEncrypt), cipher.final()]);
        const encryptBase64 = encrypted.toString('base64');

        const timestamp = String(Math.floor(Date.now() / 1000));
        const nonce = String(Math.floor(Math.random() * 1000000));
        const signature = sha1Sort([token, timestamp, nonce, encryptBase64]);

        return '<xml>\n<Encrypt><![CDATA[' + encryptBase64 + ']]></Encrypt>\n' +
            '<MsgSignature><![CDATA[' + signature + ']]></MsgSignature>\n' +
            '<TimeStamp>' + timestamp + '</TimeStamp>\n' +
            '<Nonce><![CDATA[' + nonce + ']]></Nonce>\n</xml>';
    }

    /** 获取统计信息 */
    function getStats() {
        return {
            sent: stats.sent,
            failed: stats.failed,
            queued: stats.queued,
            queuePending: pendingQueue.length,
            rateRemaining: Math.max(0, RATE_MAX - msgCount),
            rateWindowRemaining: Math.max(0, RATE_WINDOW_MS - (Date.now() - rateWindowStart)),
            lastError: stats.lastError,
            lastOk: stats.lastOk
        };
    }

    function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

    return {
        sendText, sendMarkdown, sendMarkdownV2, sendNews, sendNewsMulti,
        sendImage, sendImageFile, sendFile, sendVoice, send,
        uploadMedia,
        verifySignature, verifyFullSignature, decrypt,
        parseXml, buildReplyXml, encryptReplyXml,
        getStats,
        _resetStats: () => { stats = { sent: 0, failed: 0, queued: 0, lastError: null, lastOk: null }; }
    };
}

module.exports = { createWeCom };
