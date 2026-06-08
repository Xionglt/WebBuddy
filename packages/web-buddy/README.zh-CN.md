# Web Buddy

[English](./README.md) | 简体中文

`web-buddy` 是 [multi-functional-agent](../../README.md) 项目的 Agent Runtime，提供基于 CLI 的 Agent 循环、工具调用和 MCP 集成能力，用于网页自动化任务（如表单填写、页面交互等）。

## 项目概述

Web Buddy 源自 Claude Code 2.1.88 恢复源码的重构版本，整理为标准 npm 工程，便于：

- 本地开发与调试
- Agent 循环执行
- MCP 服务集成（计划接入 Playwright MCP）

当前已验证通过：

- `npm install`
- `npm run build`
- `node dist/cli.js --help`

## 环境要求

- Node.js `>= 18`
- npm `>= 9`

## 快速开始

```bash
cp .env.example .env   # 填入你的 API 凭证
npm install
npm run build
npm start
```

或使用便捷脚本（自动加载 `.env`）：

```bash
chmod +x start.sh bin/web-buddy-glm.sh
./start.sh
```

## 环境变量

| 变量 | 说明 |
|------|------|
| `ANTHROPIC_BASE_URL` | Anthropic 兼容 API 地址 |
| `ANTHROPIC_AUTH_TOKEN` | API 认证 Token |
| `ANTHROPIC_MODEL` | 模型名称（默认 `glm-4.7`） |
| `API_TIMEOUT_MS` | 请求超时（毫秒） |
| `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` | 关闭非必要遥测 |

参考 [`.env.example`](./.env.example) 模板。

## 常用命令

| 命令 | 说明 |
|------|------|
| `npm run build` | 从源码构建 `dist/` |
| `npm start` | 启动 CLI |
| `npm run dev` | 通过 `start.sh` 启动（自动加载 `.env`） |

## 目录结构

```text
packages/web-buddy/
├── bin/           # CLI 启动脚本
├── src/           # 恢复后的源码模块
├── scripts/       # 构建脚本
├── vendor/        # 原生/vendor 源码
├── dist/          # 构建产物（生成）
└── package.json
```

## 说明

本仓库不是 Anthropic 官方 Claude Code 源码，而是从 sourcemap 恢复并重构的项目，适合在 multi-functional-agent 生态中做研究、调试和扩展。
