# 仓库指南

## 项目结构与模块组织

本仓库提供一个 FastAPI 服务、静态 Web 界面，以及基于 Node.js Playwright 的视频下载 CLI，用于下载分享视频并提取对话文本。

- `server/app.py`：FastAPI 路由、任务状态、文件服务、下载编排和 ASR 集成。
- `server/static/`：浏览器端页面资源，包括 `index.html`、`app.js`、`styles.css`。
- `src/cli.js`：Node.js CLI 和 Playwright 平台解析逻辑。
- `downloads/`：运行时生成的视频、元数据、音频和转写结果。
- `models/`：可选本地 ASR 模型目录，在 Docker 中以只读方式挂载。
- `Dockerfile`、`docker-compose.yml`：容器化部署配置。

当前没有独立的 `tests/` 目录；新增自动化测试时请放在 `tests/` 下。

## 构建、测试与开发命令

- `npm install`：安装 Node.js 依赖。
- `python3 -m pip install -r requirements.txt`：安装 Python API 依赖。
- `npm run install:browsers`：为本地非 Docker 运行安装 Playwright Chromium。
- `ASR_PRELOAD=0 npm run api`：在 `127.0.0.1:8000` 启动本地 API。
- `npm run api:server`：在 `0.0.0.0:8000` 启动 API。
- `npm run download -- "https://example.com/share"`：运行 CLI 下载器。
- `docker compose up -d --build`：构建并启动 Docker 服务。
- `docker compose logs -f`：查看实时运行日志。

## 编码风格与命名约定

JavaScript 使用 ES modules。CLI 相关改动优先保持在 `src/cli.js`，只有在模块拆分能明显降低复杂度时再新增文件。优先使用 `const`/`let`、`async`/`await` 和清晰的 camelCase 命名。

Python 使用 4 空格缩进；FastAPI 请求模型尽量使用类型声明；函数和变量使用 snake_case；错误信息应明确可定位。不要把生成文件混入源码改动。

## 测试指南

当前未配置自动化测试框架。新增功能时建议补充聚焦测试：

- Python API 测试：`tests/test_api_*.py`，可使用 `pytest` 和 FastAPI `TestClient`。
- CLI 测试：如引入 Playwright Test，可使用 `tests/*.spec.js`。

提交前至少验证 `GET /`、`GET /api/asr/status`，以及被修改的下载或 `/transcribe` 行为。

## 提交与 Pull Request 规范

当前 checkout 没有可读 Git 历史，因此采用简洁的祈使句提交信息，例如：`Add unified transcribe endpoint`、`Document Docker deployment`。

Pull Request 应包含改动摘要、涉及的命令或环境变量、验证步骤；UI 改动应附截图。若有相关 issue 请关联，并说明 Playwright、FFmpeg、Docker 架构或 ASR provider 相关的平台风险。

## 安全与配置建议

默认 ASR 模式为远程服务。远程部署时建议保持 `ASR_PRELOAD=0`，除非确实需要启动阶段健康检查。不要提交视频、转写结果、模型权重、密钥或服务器专用 `.env` 文件。Linux 服务器上保持无界面请求，即 `headful=false`；公开访问时建议配合防火墙或反向代理。
