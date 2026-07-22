# WeCom Bridge

[![CI](https://github.com/ALingqing/WeComBot/actions/workflows/ci.yml/badge.svg)](https://github.com/ChenRayMinecraft/WeComBot/actions/workflows/ci.yml)
[![Release](https://github.com/ALingqing/WeComBot/actions/workflows/release.yml/badge.svg)](https://github.com/ChenRayMinecraft/WeComBot/actions/workflows/release.yml)
[![npm version](https://img.shields.io/badge/npm-1.0.0-blue)]()
[![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)]()
[![License](https://img.shields.io/badge/license-MIT-green)]()

企业微信通用消息桥接器。接收企业微信群消息, 通过 Handler 转发到任意后端服务。

## 架构

```
后端服务 (你的应用)
    |
    | POST /api/send (发消息到企微)
    | POST /api/bind  (绑定管理)
    | 接收 POST event_url (消息事件)
    v
WeCom Bridge
    |
    | 企业微信 Webhook (发消息)
    | 企业微信回调    (收消息)
    v
企业微信群
```

## 快速开始

```bash
git clone https://github.com/ChenRayMinecraft/WeComBot.git
cd WeComBot/bridge
npm install

# 编辑配置
cp config.json config.json.bak
# 修改 wecom.webhook_url 为企业微信群机器人地址

npm start
```

## 配置

```json
{
  "server": {
    "host": "0.0.0.0",
    "port": 5700
  },
  "wecom": {
    "webhook_url": "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=YOUR_KEY",
    "corp_id": "",
    "agent_id": "",
    "secret": "",
    "token": "",
    "encoding_aes_key": ""
  },
  "handler": {
    "name": "webhook",
    "config": {
      "event_url": "http://your-backend:8080/wecom-event",
      "secret": "",
      "timeout": 5000
    }
  },
  "binding": {
    "enabled": false,
    "mode": "TWO_WAY",
    "admin_users": []
  }
}
```

## API 参考

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/send` | POST | 发送消息到企业微信 |
| `/api/send_raw` | POST | 发送原始消息体 |
| `/api/wecom/cb` | GET | 企业微信 URL 验证 |
| `/api/wecom/cb` | POST | 企业微信消息回调 |
| `/api/bind` | POST | 绑定管理 |
| `/api/bindings` | GET | 绑定列表 |
| `/api/status` | GET | 详细状态 |
| `/api/health` | GET | 健康检查 |
| `/api/metrics` | GET | Prometheus 指标 |

### 发送消息

```bash
curl -X POST http://localhost:5700/api/send \
  -H 'Content-Type: application/json' \
  -d '{"type":"text","content":"hello"}'
```

### 绑定

```bash
# 生成验证码
curl -X POST http://localhost:5700/api/bind \
  -H 'Content-Type: application/json' \
  -d '{"action":"generate","external_id":"player123"}'

# 验证绑定
curl -X POST http://localhost:5700/api/bind \
  -H 'Content-Type: application/json' \
  -d '{"action":"bind","wecom_id":"user1","code":"482731"}'
```

## Handler 开发

在 `bridge/handlers/` 下创建 js 文件:

```js
module.exports = {
    name: 'myapp',
    async onMessage(wecomId, content, groupId) {
        // 收到企业微信消息
    },
    async onEvent(wecomId, event, groupId) {
        // 收到企业微信事件
    },
    sendMessage(type, content, extra) {
        // 发消息到企业微信
    }
};
```

## 企业微信官方文档

- [消息推送配置说明](https://developer.work.weixin.qq.com/document/path/91770)
- [接收消息](https://developer.work.weixin.qq.com/document/path/90238)
- [加解密方案](https://developer.work.weixin.qq.com/document/path/90968)
- [全局错误码](https://developer.work.weixin.qq.com/document/path/90313)

## 项目结构

```
WeComBot/
  .github/workflows/     GitHub Actions CI/CD
  .vscode/               VS Code 调试配置
  bridge/                桥接器
    handlers/            Handler 插件
    index.js             入口
    api.js               HTTP API
    wecom.js             企业微信 API
    binding.js           绑定系统
    handler-loader.js    Handler 加载器
    util.js              工具函数
    config.json          配置
    package.json         npm 包
  README.md
  LICENSE
```

## License

MIT
