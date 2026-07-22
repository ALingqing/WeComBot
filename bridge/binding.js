/**
 * 绑定系统 (可选功能)
 *
 * 管理外部用户 ID 与 企业微信用户 ID 的绑定关系。
 * 支持 TWO_WAY (验证码) 和 TRUST (直接绑定) 两种模式。
 *
 * 数据持久化到 data.json, 每次变更自动写盘。
 * 验证码 5 分钟过期, 过期自动清理。
 */

const fs = require('fs');
const path = require('path');
const { logger } = require('./util');

function createBinding(config) {
    const bc = config.binding || {};
    const mode = bc.mode || 'TWO_WAY';
    const adminUsers = bc.admin_users || [];
    const dataFile = path.join(__dirname, 'data.json');
    let data = null;

    function ensureLoaded() {
        if (data) return;
        data = loadData();
    }

    function loadData() {
        try {
            if (fs.existsSync(dataFile)) {
                const raw = fs.readFileSync(dataFile, 'utf8');
                const parsed = JSON.parse(raw);
                if (!parsed.bindings || typeof parsed.bindings !== 'object') parsed.bindings = {};
                if (!parsed.codes || typeof parsed.codes !== 'object') parsed.codes = {};
                return parsed;
            }
        } catch (e) {
            logger.warn('binding', '数据文件损坏, 重置: ' + e.message);
        }
        return { bindings: {}, codes: {} };
    }

    function saveData() {
        try {
            const tmp = dataFile + '.tmp';
            fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
            fs.renameSync(tmp, dataFile);
        } catch (e) {
            logger.error('binding', '保存失败: ' + e.message);
        }
    }

    function cleanExpiredCodes() {
        ensureLoaded();
        const now = Date.now();
        let changed = false;
        for (const [code, info] of Object.entries(data.codes)) {
            if (now - info.created_at > 5 * 60 * 1000) {
                delete data.codes[code];
                changed = true;
            }
        }
        if (changed) saveData();
    }

    function generateCode(externalId) {
        ensureLoaded();
        cleanExpiredCodes();
        const code = String(Math.floor(100000 + Math.random() * 900000));
        data.codes[code] = { external_id: externalId, created_at: Date.now() };
        saveData();
        setTimeout(() => {
            ensureLoaded();
            if (data.codes[code]) {
                delete data.codes[code];
                saveData();
            }
        }, 5 * 60 * 1000);
        return code;
    }

    function bindWithCode(wecomId, code) {
        ensureLoaded();
        cleanExpiredCodes();
        const info = data.codes[code];
        if (!info) return null;
        if (Date.now() - info.created_at > 5 * 60 * 1000) {
            delete data.codes[code];
            saveData();
            return null;
        }
        delete data.codes[code];
        if (data.bindings[wecomId]) {
            logger.info('binding', '覆盖旧绑定: ' + wecomId);
        }
        data.bindings[wecomId] = {
            external_id: info.external_id,
            bind_at: Date.now(),
            admin: adminUsers.includes(wecomId)
        };
        saveData();
        return info.external_id;
    }

    function bindDirect(wecomId, externalId) {
        ensureLoaded();
        if (!externalId || !externalId.trim()) return null;
        if (data.bindings[wecomId]) {
            logger.info('binding', '覆盖旧绑定: ' + wecomId);
        }
        data.bindings[wecomId] = {
            external_id: externalId.trim(),
            bind_at: Date.now(),
            admin: adminUsers.includes(wecomId)
        };
        saveData();
        return externalId;
    }

    function unbind(wecomId) {
        ensureLoaded();
        const info = data.bindings[wecomId];
        if (!info) return null;
        delete data.bindings[wecomId];
        saveData();
        return info.external_id;
    }

    function getBinding(wecomId) {
        ensureLoaded();
        return data.bindings[wecomId] || null;
    }

    function findByExternalId(externalId) {
        ensureLoaded();
        for (const [wecomId, info] of Object.entries(data.bindings)) {
            if (info.external_id === externalId) return { wecom_id: wecomId, ...info };
        }
        return null;
    }

    function listBindings() {
        ensureLoaded();
        return Object.entries(data.bindings).map(([wecomId, info]) => ({
            wecom_id: wecomId,
            external_id: info.external_id,
            bind_at: new Date(info.bind_at).toISOString(),
            admin: !!info.admin
        }));
    }

    function count() {
        ensureLoaded();
        return Object.keys(data.bindings).length;
    }

    function isAdmin(wecomId) {
        return adminUsers.includes(wecomId);
    }

    return {
        generateCode, bindWithCode, bindDirect,
        unbind, getBinding, findByExternalId,
        listBindings, count, isAdmin
    };
}

module.exports = { createBinding };