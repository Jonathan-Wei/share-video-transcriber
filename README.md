# Share Video Transcriber

这是一个基于 Playwright、FastAPI 和 FFmpeg 的视频处理服务，支持解析抖音、哔哩哔哩、快手、微信视频号分享链接，下载视频及相关元数据，并通过 ASR 服务提取视频或音频中的对话文本。

项目同时提供：

- Web 操作界面
- REST API
- Node.js 命令行工具
- Docker / Docker Compose 部署
- 远程 ASR 和本地 faster-whisper 两种转写方式

默认使用远程 ASR 服务，适合部署到无 GPU 的 Linux 服务器。

## 功能特性

- 支持直接输入视频链接或包含链接的分享文本
- 自动识别抖音、哔哩哔哩、快手和微信视频号
- 自动跟随短链接跳转并解析真实页面
- 使用 Playwright 捕获页面网络请求和视频资源
- 下载视频、封面、字幕和元数据 JSON
- 提供任务创建、状态查询、历史记录和文件下载接口
- 支持 URL、音频文件、视频文件三种转写方式
- 转写场景自动优先下载低画质、带音轨的视频，减少流量和处理时间
- 默认调用远程 ASR，支持切换到本地 faster-whisper
- 支持 Docker 健康检查、数据持久化和容器自动重启

## 工作流程

### 视频下载

```text
分享链接或分享文本
        |
        v
识别平台并解析短链接
        |
        v
Playwright 打开页面并监听网络请求
        |
        v
筛选视频、封面和字幕资源
        |
        v
下载文件并保存元数据
```

### 对话转写

```text
URL / 音频文件 / 视频文件
        |
        v
URL 场景优先下载低质量带音轨视频
        |
        v
FFmpeg 提取 16 kHz 单声道 WAV
        |
        v
远程 ASR（默认）或本地 faster-whisper
        |
        v
返回 {"text": "转写内容"}
```

## 支持平台

| 平台 | 链接识别 | 视频下载 | 封面/字幕 | 备注 |
| --- | --- | --- | --- | --- |
| 抖音 | 支持 | 支持 | 视页面资源而定 | 支持分享文本和短链接 |
| 哔哩哔哩 | 支持 | 支持 | 视页面资源而定 | 部分 DASH 视频可能只有独立视频流 |
| 快手 | 支持 | 支持 | 视页面资源而定 | 页面风控可能影响解析 |
| 微信视频号 | 支持 | 支持 | 视页面资源而定 | 可能受登录状态和页面策略影响 |

平台页面、反爬策略和资源接口可能随时变化。登录验证、验证码、地区限制或视频权限均可能导致解析失败。

## Docker 快速启动

推荐使用 Docker Compose 部署。

### 1. 准备配置

```bash
cp .env.example .env
mkdir -p downloads models
```

默认配置来自 `.env`。远程 ASR 地址只在 `.env` / `.env.example` 中维护：

```dotenv
HOST_PORT=8000
ASR_PRELOAD=0
ASR_PROVIDER=remote
REMOTE_ASR_URL=你的远程ASR服务地址
REMOTE_ASR_PATH=/api/v1/asr
REMOTE_ASR_LANG=auto
REMOTE_ASR_TIMEOUT=300
```

### 2. 构建并启动

```bash
docker compose up -d --build
```

### 3. 访问服务

- Web 页面：<http://127.0.0.1:8000/>
- API 文档：<http://127.0.0.1:8000/docs>
- ASR 状态：<http://127.0.0.1:8000/api/asr/status>

部署到服务器后，将 `127.0.0.1` 替换为服务器 IP 或域名：

```text
http://服务器IP:8000/
```

### 4. 运维命令

```bash
# 查看容器状态
docker compose ps

# 查看实时日志
docker compose logs -f

# 重启服务
docker compose restart

# 停止并删除容器
docker compose down

# 更新代码后重新构建
docker compose up -d --build
```

下载结果会持久化到宿主机的 `./downloads` 目录。

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `HOST_PORT` | `8000` | Docker 映射到宿主机的端口 |
| `ASR_PROVIDER` | `remote` | ASR 类型，可选 `remote` 或 `local` |
| `ASR_PRELOAD` | `0` | 是否在服务启动时检查或加载 ASR，`1` 为启用 |
| `REMOTE_ASR_URL` | 见 `.env` | 远程 ASR 服务地址 |
| `REMOTE_ASR_PATH` | `/api/v1/asr` | 远程 ASR 接口路径 |
| `REMOTE_ASR_LANG` | `auto` | 远程 ASR 识别语言 |
| `REMOTE_ASR_TIMEOUT` | `300` | 远程 ASR 请求超时时间，单位秒 |
| `DOWNLOAD_DIR` | `/data/downloads` | 容器内下载目录 |
| `ASR_MODEL_DIR` | `/models/faster-whisper-base` | 本地 ASR 模型目录 |

`ASR_PRELOAD=0` 更适合默认的远程 ASR 模式，可以避免启动阶段因远程服务暂时不可用而影响容器启动。设置为 `1` 时：

- `remote` 模式会在启动时请求远程 ASR 的 `/health` 接口
- `local` 模式会在启动时加载 faster-whisper 模型

## API 使用

### 接口列表

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/` | Web 操作页面 |
| `GET` | `/api/asr/status` | 查询 ASR 配置和可用状态 |
| `POST` | `/api/downloads` | 创建下载任务 |
| `GET` | `/api/downloads` | 查询下载记录 |
| `GET` | `/api/downloads/{task_id}` | 查询单个任务 |
| `POST` | `/api/downloads/{task_id}/transcribe` | 转写已下载任务 |
| `POST` | `/transcribe` | 统一 URL/音频/视频转写接口 |
| `GET` | `/api/files/{file_path}` | 下载生成的文件 |

完整请求模型和在线调试页面可访问 `/docs`。

### 创建下载任务

```bash
curl -X POST http://127.0.0.1:8000/api/downloads \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://v.douyin.com/xxxx/",
    "output_name": "example",
    "headful": false,
    "transcribe": false,
    "asr_model": "base",
    "timeout": 30000
  }'
```

主要参数：

| 参数 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `url` | string | 必填 | 视频链接或分享文本 |
| `output_name` | string | 空 | 输出文件名，不包含扩展名 |
| `headful` | boolean | `false` | 是否显示浏览器窗口，服务器环境应保持 `false` |
| `transcribe` | boolean | `false` | 下载后是否立即转写 |
| `asr_model` | string | `base` | 本地 ASR 模型标识 |
| `timeout` | integer | `30000` | 页面处理超时，范围 1000～120000 毫秒 |

创建任务后，通过返回的 `id` 查询状态：

```bash
curl http://127.0.0.1:8000/api/downloads/任务ID
```

### 统一转写接口

接口地址：

```text
POST /transcribe
Content-Type: multipart/form-data
```

请求参数：

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `type` | string | 必填，可选 `url`、`audio`、`video` |
| `url` | string | `type=url` 时必填 |
| `file` | file | `type=audio` 或 `type=video` 时必填 |

URL 转写：

```bash
curl -X POST http://127.0.0.1:8000/transcribe \
  -F "type=url" \
  -F "url=https://v.douyin.com/xxxx/"
```

音频转写：

```bash
curl -X POST http://127.0.0.1:8000/transcribe \
  -F "type=audio" \
  -F "file=@./sample.mp3"
```

视频转写：

```bash
curl -X POST http://127.0.0.1:8000/transcribe \
  -F "type=video" \
  -F "file=@./sample.mp4"
```

成功响应：

```json
{
  "text": "识别出的对话文本"
}
```

URL 转写会自动使用低质量下载策略。该策略优先选择体积较小且包含音轨的单文件视频，避免选择只有画面的 DASH 视频流。

## 本地开发

### 环境要求

- Node.js 18 或更高版本
- Python 3.10 或更高版本
- FFmpeg
- Chromium，由 Playwright 安装

### 安装依赖

```bash
npm install
npm run install:browsers

python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

### 启动 API 服务

仅本机访问：

```bash
npm run api
```

允许局域网或服务器外部访问：

```bash
npm run api:server
```

## 命令行工具

### 基本用法

```bash
npm run download -- "https://v.douyin.com/xxxx/"
```

也可以传入完整分享文本：

```bash
npm run download -- "复制这段内容，打开抖音查看 https://v.douyin.com/xxxx/"
```

### 常用示例

```bash
# 指定输出文件名
npm run download -- "视频链接" --output my-video

# 指定下载目录
npm run download -- "视频链接" --dir ./downloads

# 使用低质量带音轨资源
npm run download -- "视频链接" --quality low

# 输出 JSON 结果
npm run download -- "视频链接" --json

# 显示浏览器窗口，适合本地排查
npm run download -- "视频链接" --headful
```

### CLI 参数

| 参数 | 说明 |
| --- | --- |
| `-o, --output <name>` | 输出文件名，不包含扩展名 |
| `-d, --dir <path>` | 下载目录，默认 `./downloads` |
| `--timeout <ms>` | 页面加载和解析超时 |
| `--quality <best\|low>` | 视频质量策略，默认 `best` |
| `--headful` | 显示 Chromium 窗口 |
| `--json` | 使用 JSON 格式输出结果 |

## 输出文件

一次下载可能产生以下文件：

```text
downloads/
├── example.mp4
├── example.json
├── example-cover.jpg
└── example-subtitle.vtt
```

其中元数据 JSON 包含平台、原始链接、页面地址、标题、作者、下载文件和资源地址等信息。封面和字幕是否存在取决于目标页面实际暴露的资源。

## 使用本地 ASR

默认远程 ASR 不需要本机 GPU。如果需要切换到本地 faster-whisper：

1. 将完整模型文件放入 `./models/faster-whisper-base`
2. 修改 `.env`

```dotenv
ASR_PROVIDER=local
ASR_PRELOAD=1
```

3. 重新创建容器

```bash
docker compose up -d --force-recreate
```

当前本地实现默认使用 CPU 和 `int8` 计算。即使服务器安装了 GPU，也不会自动启用 CUDA；如需 GPU 推理，需要进一步调整本地模型初始化参数和 Docker CUDA 运行环境。

## 导出和导入 Docker 镜像

### 构建并导出

```bash
docker compose build
docker save -o share-video-transcriber-latest.tar share-video-transcriber:latest
gzip share-video-transcriber-latest.tar
```

生成文件：

```text
share-video-transcriber-latest.tar.gz
```

将镜像文件、`docker-compose.yml` 和 `.env` 上传到服务器。

### 在服务器导入并启动

```bash
gunzip share-video-transcriber-latest.tar.gz
docker load -i share-video-transcriber-latest.tar
mkdir -p downloads models
docker compose up -d
```

### CPU 架构注意事项

在 Apple Silicon Mac 上直接构建的镜像通常是 `arm64`，不能直接运行在常见的 `x86_64/amd64` Linux 服务器上。面向 amd64 服务器时应构建对应架构镜像：

```bash
docker buildx build \
  --platform linux/amd64 \
  -t share-video-transcriber:latest \
  --load .
```

随后再执行 `docker save`。

## Linux 服务器部署建议

- Chromium 以无界面模式运行，不需要安装桌面环境
- 建议至少预留 2 GB 内存，并保留 `shm_size: 1gb`
- 确保服务器可以访问目标视频平台和远程 ASR 地址
- 对公网开放时，建议使用 Nginx 或 Caddy 配置 HTTPS 和访问控制
- 不建议直接将未鉴权的接口暴露到公网
- 定期清理 `downloads` 目录，避免磁盘占满
- 如需处理大文件，应同步调整反向代理的请求体大小和超时时间

## 常见问题

### Web 页面可以打开，但下载失败

查看服务日志：

```bash
docker compose logs -f
```

常见原因包括链接已失效、页面要求登录、触发验证码、网络无法访问平台或平台页面结构发生变化。

### 转写接口失败

先检查 ASR 状态：

```bash
curl http://127.0.0.1:8000/api/asr/status
```

然后确认：

- 容器能够访问 `REMOTE_ASR_URL`
- 远程接口路径与 `REMOTE_ASR_PATH` 一致
- FFmpeg 能够从上传文件或下载视频中提取音轨
- 远程 ASR 的请求和响应格式与当前实现兼容

### `ASR_PRELOAD` 应该设置为多少

- 默认远程 ASR：建议保持 `0`
- 希望启动时立即检查远程 ASR：设置为 `1`
- 本地 ASR 且希望启动后立即可用：设置为 `1`

### 无界面的 Linux 服务器是否影响功能

正常的视频解析、下载和转写不依赖图形桌面，Playwright 会使用 headless Chromium。只有在平台要求人工登录、扫码或处理验证码时，无界面环境的排查和交互能力会受到限制。

## 项目结构

```text
.
├── server/                 # FastAPI 服务和 Web 页面
├── src/                    # Node.js CLI、平台解析和下载逻辑
├── downloads/              # 默认下载与任务结果目录
├── models/                 # 可选的本地 ASR 模型
├── Dockerfile              # 服务镜像定义
├── docker-compose.yml      # Docker Compose 配置
├── package.json            # Node.js 依赖和脚本
├── requirements.txt        # Python 依赖
└── .env.example            # Docker 环境变量示例
```

## 安全说明

本项目会访问用户提供的外部 URL，并允许上传媒体文件。生产环境中应增加鉴权、请求频率限制、文件大小限制、域名或平台白名单、日志审计和定期文件清理策略。
