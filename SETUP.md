# GitHub 仓库设置指南

## 1. 创建 GitHub 仓库

1. 打开 https://github.com/new
2. 仓库名: `WeComBot`
3. 描述: 企业微信通用消息桥接器
4. 设为 Public
5. 不要勾选任何初始化选项

## 2. 推送代码

```bash
# 安装 Git: https://git-scm.com/download/win

cd "C:\Users\aqing\Desktop\新建文件夹 (4)\WeComBot"

git init
git checkout -b main
git add -A
git commit -m "Initial commit: WeCom Bridge v1.0.0"

git remote add origin https://github.com/ChenRayMinecraft/WeComBot.git
git push -u origin main
```

## 3. 创建 Tag 发布

```bash
git tag v1.0.0
git push origin v1.0.0
```

这会触发 `.github/workflows/release.yml` 自动创建 Release。

## 4. 配置 Secrets (可选)

如果要在 CI 中发布 npm 包:

- 去 https://github.com/ChenRayMinecraft/WeComBot/settings/secrets/actions
- 添加 `NPM_TOKEN` (GitHub Packages token)

## 5. 验证

- CI: https://github.com/ChenRayMinecraft/WeComBot/actions
- Release: https://github.com/ChenRayMinecraft/WeComBot/releases
- 包: https://github.com/ChenRayMinecraft/WeComBot/pkgs/npm/wecom-bridge
