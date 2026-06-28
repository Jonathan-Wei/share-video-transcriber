# 仓库指南

## 项目结构与模块组织

本仓库提供一个 FastAPI 服务、静态 Web 界面，以及基于 Node.js Playwright 的视频下载 CLI，用于下载分享视频并提取对话文本。

- `server/app.py`：FastAPI 路由入口，保持薄路由，不放具体业务实现。
- `server/config.py`：环境变量、路径和 ASR 配置读取。
- `server/asr.py`：远程/本地 ASR 状态检查、音频提取和转写调用。
- `server/tasks.py`：下载任务、历史任务加载和转写任务编排。
- `server/files.py`、`server/schemas.py`：文件路径/元数据工具与请求模型。
- `server/static/`：浏览器端页面资源，包括 `index.html`、`app.js`、`styles.css`。
- `src/cli.js`：Node.js CLI 入口，仅处理参数和输出。
- `src/downloader.js`、`src/assets.js`：Playwright 下载编排、视频/封面/字幕保存。
- `src/extractors.js`、`src/video-candidates.js`：通用内容提取、候选视频去重与质量排序。
- `src/platforms/`：按平台拆分的解析与接口适配，包括 `douyin.js`、`bilibili.js`、`kuaishou.js`、`wechat.js`、`generic.js`。
- `downloads/`：运行时生成的视频、元数据、音频和转写结果。
- `models/`：可选本地 ASR 模型目录，在 Docker 中以只读方式挂载。
- `tests/`：自动化测试，目前使用 Node 内置测试框架。
- `Dockerfile`、`docker-compose.yml`：容器化部署配置。

## 构建、测试与开发命令

- `npm install`：安装 Node.js 依赖。
- `python3 -m pip install -r requirements.txt`：安装 Python API 依赖。
- `npm run install:browsers`：为本地非 Docker 运行安装 Playwright Chromium。
- `npm test`：运行 Node 内置测试，覆盖 CLI 工具函数和平台分发逻辑。
- `ASR_PRELOAD=0 npm run api`：在 `127.0.0.1:8000` 启动本地 API。
- `npm run api:server`：在 `0.0.0.0:8000` 启动 API。
- `npm run download -- "https://example.com/share"`：运行 CLI 下载器。
- `docker compose up -d --build`：构建并启动 Docker 服务。
- `docker compose logs -f`：查看实时运行日志。

## 编码风格与命名约定

JavaScript 使用 ES modules。CLI 入口保持轻量，下载流程放在 `src/downloader.js`，平台差异放在 `src/platforms/`。新增平台时优先添加独立平台文件，并通过 `src/platforms/index.js` 分发。优先使用 `const`/`let`、`async`/`await` 和清晰的 camelCase 命名。

Python 使用 4 空格缩进；FastAPI 请求模型放在 `server/schemas.py`；配置读取集中在 `server/config.py`；函数和变量使用 snake_case。不要把运行时生成文件、模型权重或缓存混入源码改动。

## 前端设计规范

所有前端页面、组件、交互和样式变更必须先阅读并遵循仓库根目录的 `DESIGN.md` 设计系统。新增或调整 `server/static/index.html`、`server/static/app.js`、`server/static/styles.css` 时，应优先复用 `DESIGN.md` 中定义的布局原则、视觉风格、颜色、字体、间距、控件形态和交互反馈，不要自行引入与设计系统冲突的新视觉语言。

如果功能需求确实需要扩展设计系统，应先更新 `DESIGN.md` 说明新的设计规则，再在前端实现中使用该规则。UI 改动完成后，应检查桌面和移动端视口下的文本换行、按钮尺寸、表单布局、状态提示和内容重叠问题。

## 测试指南

当前测试位于 `tests/cli-utils.test.js`，使用 Node 内置 `node:test`。新增解析规则、平台分发或候选排序逻辑时，应补充聚焦测试。

- CLI/解析测试：`tests/*.test.js`。
- Python API 测试：未来如引入 `pytest`，可使用 `tests/test_api_*.py` 和 FastAPI `TestClient`。

提交前至少运行 `npm test`，并验证 `GET /`、`GET /api/asr/status`，以及被修改的下载或 `/transcribe` 行为。

## 提交与 Pull Request 规范

采用简洁、可读的提交信息，例如：`代码重构`、`Add unified transcribe endpoint`、`Document Docker deployment`。

Pull Request 应包含改动摘要、涉及的命令或环境变量、验证步骤；UI 改动应附截图。若有相关 issue 请关联，并说明 Playwright、FFmpeg、Docker 架构或 ASR provider 相关的平台风险。

## 安全与配置建议

默认 ASR 模式为远程服务，远程地址从 `.env` 读取；`.env.example` 只能保留占位值。远程部署时建议保持 `ASR_PRELOAD=0`，除非确实需要启动阶段健康检查。不要提交视频、转写结果、模型权重、密钥或服务器专用 `.env` 文件。Linux 服务器上保持无界面请求，即 `headful=false`；公开访问时建议配合防火墙或反向代理。
