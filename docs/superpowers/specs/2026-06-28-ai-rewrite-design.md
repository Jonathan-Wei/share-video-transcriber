# AI 文案改写功能设计

## 背景

当前服务已经能下载分享视频、展示平台解析出的原始文案，并通过 ASR 提取声音对话。新增能力是在这些文本被提取出来以后，允许用户通过大模型生成改写版本。

本次采用方案 A：新增统一后端改写接口，前端在“文案”和“声音对话”两类文本旁分别提供 AI 改写入口。模型调用通过 OpenAI-compatible Chat Completions 形态适配阿里、DeepSeek 和自定义大模型服务。

## 目标

- 支持对视频原始文案改写。
- 支持对 ASR 声音对话改写。
- 支持国内阿里和 DeepSeek 模型配置。
- 支持自定义 OpenAI-compatible 服务地址、模型和密钥。
- 前端在任务预览内直接展示改写结果，并提供复制入口。
- 第一版不把改写结果写回元数据文件，避免引入历史版本管理和任务状态扩展。

## 非目标

- 不做批量改写队列。
- 不做多版本改写历史保存。
- 不新增用户账号、权限或密钥管理后台。
- 不实现流式输出。

## 后端设计

新增 `server/llm.py`，职责包括：

- 读取和归一化 LLM 配置。
- 根据 provider 生成默认 base URL 和默认模型。
- 校验必填配置。
- 构造 Chat Completions 请求。
- 提取模型返回文本。
- 将网络错误、配置错误和模型响应错误转换为清晰的异常。

新增 `server/schemas.py` 模型：

- `RewriteSource = Literal["caption", "transcript"]`
- `RewriteStyle = Literal["social", "summary", "polished"]`
- `RewriteRequest`
- `RewriteResponse`

新增接口：

```http
POST /api/ai/rewrite
Content-Type: application/json
```

请求示例：

```json
{
  "text": "原始文案或声音对话",
  "source": "caption",
  "style": "social"
}
```

响应示例：

```json
{
  "text": "改写后的文本",
  "provider": "deepseek",
  "model": "deepseek-chat"
}
```

输入约束：

- `text` 必填，去除首尾空白后不能为空。
- `text` 长度上限为 20000 字符。
- `source` 必须是 `caption` 或 `transcript`。
- `style` 默认 `social`。

错误处理：

- 配置缺失返回 503，提示具体缺少的配置项。
- 模型服务请求失败返回 502。
- 模型返回格式无法解析返回 502。
- 输入校验失败返回 422，由 Pydantic 处理。

## 配置设计

新增环境变量：

```dotenv
LLM_PROVIDER=deepseek
LLM_API_KEY=
LLM_MODEL=deepseek-chat
LLM_BASE_URL=
LLM_TIMEOUT=60
```

provider 规则：

| Provider | 默认 Base URL | 默认模型 | 备注 |
| --- | --- | --- | --- |
| `deepseek` | `https://api.deepseek.com` | `deepseek-chat` | 使用 OpenAI-compatible `/chat/completions` |
| `aliyun` | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-plus` | 使用阿里百炼兼容模式 |
| `custom` | 必填 `LLM_BASE_URL` | 必填 `LLM_MODEL` | 适配自建或其他兼容服务 |

所有 provider 都需要 `LLM_API_KEY`。`LLM_BASE_URL` 如果配置，将覆盖 provider 默认地址。调用时拼接 `/chat/completions`，但如果用户配置的地址已经以 `/chat/completions` 结尾，则直接使用。

## Prompt 设计

后端根据 `source` 和 `style` 生成系统提示词。

`source=caption` 时强调保留视频主题和关键信息，适合发布文案。

`source=transcript` 时强调保留事实和语义，不编造视频中没有的信息，适合把口语转成更顺的发布文案或摘要。

`style` 含义：

- `social`：短视频/社媒发布文案，默认风格。
- `summary`：简洁摘要，适合快速了解内容。
- `polished`：更正式、通顺、克制的表达。

模型参数第一版固定：

- `temperature`: `0.7`
- `max_tokens`: `1200`

## 前端设计

修改 `server/static/app.js`：

- 在“文案”文本旁增加“AI 改写”按钮。
- 在“声音对话”内容旁增加“AI 改写”按钮。
- 点击按钮后调用 `/api/ai/rewrite`。
- 按钮进入 loading 状态，防止重复提交。
- 改写结果显示在对应原文下方。
- 提供“复制”按钮。
- 错误通过 `alert(error.message)` 展示，保持现有前端错误风格一致。

修改 `server/static/styles.css`：

- 增加改写结果区域、操作按钮行、复制按钮和 loading 状态样式。
- 保持当前白底、浅灰字段块和蓝色主按钮风格。

修改 `server/static/index.html`：

- 更新静态资源版本号，避免浏览器缓存旧 JS/CSS。

## 数据流

```text
任务预览中的文案/声音对话
        |
        v
用户点击 AI 改写
        |
        v
POST /api/ai/rewrite
        |
        v
server/llm.py 读取配置并调用模型
        |
        v
前端展示改写文本并允许复制
```

## 测试计划

新增 Python 测试，优先覆盖不依赖外部网络的行为：

- DeepSeek provider 默认配置解析。
- 阿里 provider 默认配置解析。
- Custom provider 缺少 base URL 或 model 时抛出配置错误。
- Chat Completions URL 拼接规则。
- 改写请求 payload 包含正确 model、messages、temperature 和 max_tokens。
- 模型响应文本提取。

实现时如果当前项目没有 Python 测试框架，将补充最小 `pytest` 配置或用标准库单元测试，避免引入重型依赖。

提交前验证：

- `npm test`
- `python3 -m unittest discover -s tests -p 'test_*.py'`
- `ASR_PRELOAD=0 npm run api` 启动检查
- 手动访问 `GET /`、`GET /api/asr/status`

## 后续扩展

第一版默认不保存改写结果。如果后续需要可追溯改写记录，应新增任务级 rewrite history，并把结果写入元数据 JSON。
