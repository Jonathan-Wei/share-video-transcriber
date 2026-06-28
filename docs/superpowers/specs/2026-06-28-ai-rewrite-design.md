# AI 文案改写功能设计

## 背景

当前服务已经能下载分享视频、展示平台解析出的原始文案，并通过 ASR 提取声音对话。新增能力是在这些文本被提取出来以后，允许用户通过大模型生成改写版本。

本次采用方案 A：新增统一后端改写接口，前端在“文案”和“声音对话”两类文本旁分别提供 AI 改写入口。模型调用通过 OpenAI-compatible Chat Completions 形态适配阿里、DeepSeek 和自定义大模型服务。

## 目标

- 支持对视频原始文案改写。
- 支持对 ASR 声音对话改写。
- 支持国内阿里和 DeepSeek 模型配置。
- 支持自定义 OpenAI-compatible 服务地址、模型和密钥。
- 支持用户在前端页面直接配置模型厂商、模型名、接口地址、API Key 和超时时间。
- 前端在任务预览内直接展示改写结果，并提供复制入口。
- 第一版不把改写结果写回元数据文件，避免引入历史版本管理和任务状态扩展。

## 非目标

- 不做批量改写队列。
- 不做多版本改写历史保存。
- 不新增用户账号或权限系统；公开访问部署仍需依赖防火墙、反向代理或内网访问控制。
- 不实现流式输出。

## 后端设计

新增 `server/llm.py`，职责包括：

- 读取环境变量和前端保存的 LLM 配置。
- 根据 provider 生成默认 base URL 和默认模型。
- 校验必填配置。
- 保存前端提交的模型配置。
- 返回脱敏后的当前模型配置。
- 构造 Chat Completions 请求。
- 提取模型返回文本。
- 将网络错误、配置错误和模型响应错误转换为清晰的异常。

新增 `server/schemas.py` 模型：

- `RewriteSource = Literal["caption", "transcript"]`
- `RewriteStyle = Literal["social", "summary", "polished"]`
- `RewriteRequest`
- `RewriteResponse`
- `LLMProvider = Literal["deepseek", "aliyun", "custom"]`
- `LLMConfigRequest`
- `LLMConfigResponse`

新增改写接口：

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

新增模型配置接口：

```http
GET /api/ai/config
```

返回脱敏后的当前配置：

```json
{
  "provider": "deepseek",
  "model": "deepseek-chat",
  "base_url": "https://api.deepseek.com",
  "timeout": 60,
  "api_key_configured": true,
  "api_key_masked": "sk-****abcd",
  "source": "saved"
}
```

```http
PUT /api/ai/config
Content-Type: application/json
```

请求示例：

```json
{
  "provider": "aliyun",
  "api_key": "sk-xxx",
  "model": "qwen-plus",
  "base_url": "",
  "timeout": 60
}
```

保存规则：

- `provider` 必填，可选 `deepseek`、`aliyun`、`custom`。
- `api_key` 提交空字符串时，如果已有保存的 API Key，则保留旧值，便于用户只调整模型名或超时时间。
- `api_key` 提交非空字符串时，覆盖旧值。
- `custom` 必须提供 `model` 和 `base_url`。
- `deepseek` 和 `aliyun` 未提供 `model` 或 `base_url` 时使用 provider 默认值。
- GET 接口永远不返回明文 API Key。

## 配置设计

保留环境变量作为默认配置和无人值守部署方式：

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
| `custom` | 必填 Base URL | 必填模型名 | 适配自建或其他兼容服务 |

所有 provider 都需要有效 API Key，来源可以是前端保存配置或 `LLM_API_KEY`。Base URL 调用时拼接 `/chat/completions`，但如果用户配置的地址已经以 `/chat/completions` 结尾，则直接使用。

新增前端配置持久化文件：

```text
DOWNLOAD_DIR/llm-config.json
```

配置读取按字段合并，而不是整块覆盖：

1. 前端保存的非空字段
2. 环境变量
3. provider 默认值

`llm-config.json` 属于运行时数据，不提交到源码仓库。Docker 部署时它会随 `./downloads:/data/downloads` 挂载持久化。

安全约束：

- API Key 只在服务端保存和使用。
- 前端 GET 配置接口只展示是否已配置和脱敏后的尾号。
- `llm-config.json` 会包含服务端可用的 API Key，创建或更新时应尽量以仅当前用户可读写的权限保存。
- 如果服务公开到公网，必须通过防火墙、反向代理认证或内网限制保护配置页面。

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

- 新增模型配置页面状态和表单提交逻辑。
- 页面加载时调用 `GET /api/ai/config`，展示当前 provider、model、base URL、timeout 和 API Key 配置状态。
- 用户保存配置时调用 `PUT /api/ai/config`。
- 保存成功后刷新配置状态，并让后续改写调用使用新配置。
- 在“文案”文本旁增加“AI 改写”按钮。
- 在“声音对话”内容旁增加“AI 改写”按钮。
- 点击按钮后调用 `/api/ai/rewrite`。
- 按钮进入 loading 状态，防止重复提交。
- 改写结果显示在对应原文下方。
- 提供“复制”按钮。
- 错误通过 `alert(error.message)` 展示，保持现有前端错误风格一致。

修改 `server/static/styles.css`：

- 增加模型配置区域、配置表单、改写结果区域、操作按钮行、复制按钮和 loading 状态样式。
- 保持当前白底、浅灰字段块和蓝色主按钮风格。

修改 `server/static/index.html`：

- 在页面上增加“模型配置”区域，放在新建任务表单下方或任务队列上方。
- 配置区域包含 provider 下拉框、模型名、Base URL、API Key、超时时间和保存按钮。
- `deepseek` 和 `aliyun` 选中后自动提示默认模型与默认地址；`custom` 要求用户填写模型名和 Base URL。
- 更新静态资源版本号，避免浏览器缓存旧 JS/CSS。

## 数据流

```text
前端模型配置表单
        |
        v
PUT /api/ai/config
        |
        v
DOWNLOAD_DIR/llm-config.json
        |
        v
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
- 保存前端配置时会写入 `llm-config.json`。
- GET 配置接口不会返回明文 API Key。
- `api_key` 为空时保留已保存的旧密钥。
- 前端保存配置后会刷新当前配置状态。

实现时如果当前项目没有 Python 测试框架，将补充最小 `pytest` 配置或用标准库单元测试，避免引入重型依赖。

提交前验证：

- `npm test`
- `python3 -m unittest discover -s tests -p 'test_*.py'`
- `ASR_PRELOAD=0 npm run api` 启动检查
- 手动访问 `GET /`、`GET /api/asr/status`

## 后续扩展

第一版默认不保存改写结果。如果后续需要可追溯改写记录，应新增任务级 rewrite history，并把结果写入元数据 JSON。
