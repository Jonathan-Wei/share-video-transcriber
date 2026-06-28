import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Optional

from .config import DOWNLOAD_DIR


DEFAULT_PROVIDER = "deepseek"
DEFAULT_TIMEOUT = 60
PROVIDER_DEFAULTS = {
    "deepseek": {
        "base_url": "https://api.deepseek.com",
        "model": "deepseek-chat",
    },
    "aliyun": {
        "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1",
        "model": "qwen-plus",
    },
}


class LLMConfigError(RuntimeError):
    pass


class LLMServiceError(RuntimeError):
    pass


@dataclass(frozen=True)
class RuntimeLLMConfig:
    provider: str
    model: str
    base_url: str
    api_key: str
    timeout: float
    source: str


def default_config_path():
    return DOWNLOAD_DIR / "llm-config.json"


def resolve_config(
    *,
    env: Optional[dict[str, str]] = None,
    config_path: Optional[Path] = None,
    require_api_key: bool = False,
):
    env = os.environ if env is None else env
    config_path = default_config_path() if config_path is None else config_path
    saved = read_saved_config(config_path)
    source = "saved" if any(str(value).strip() for value in saved.values()) else "env"

    provider = select_field(saved, env, "provider", "LLM_PROVIDER", DEFAULT_PROVIDER).lower()
    if provider not in ("deepseek", "aliyun", "custom"):
        raise LLMConfigError("LLM_PROVIDER 只能是 deepseek、aliyun 或 custom")

    defaults = PROVIDER_DEFAULTS.get(provider, {})
    model = select_field(saved, env, "model", "LLM_MODEL", defaults.get("model", ""))
    base_url = select_field(saved, env, "base_url", "LLM_BASE_URL", defaults.get("base_url", ""))
    api_key = select_field(saved, env, "api_key", "LLM_API_KEY", "")
    timeout = parse_timeout(select_field(saved, env, "timeout", "LLM_TIMEOUT", DEFAULT_TIMEOUT))

    missing = []
    if provider == "custom":
        if not model:
            missing.append("LLM_MODEL")
        if not base_url:
            missing.append("LLM_BASE_URL")
    if require_api_key and not api_key:
        missing.append("LLM_API_KEY")
    if missing:
        raise LLMConfigError("缺少 LLM 配置: " + "、".join(missing))

    return RuntimeLLMConfig(
        provider=provider,
        model=model,
        base_url=base_url.rstrip("/"),
        api_key=api_key,
        timeout=timeout,
        source=source,
    )


def read_saved_config(config_path: Path):
    try:
        payload = json.loads(config_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return payload if isinstance(payload, dict) else {}


def select_field(
    saved: dict[str, Any],
    env: dict[str, str],
    saved_key: str,
    env_key: str,
    default: Any,
):
    saved_value = saved.get(saved_key)
    if saved_value is not None and str(saved_value).strip() != "":
        return str(saved_value).strip()
    env_value = env.get(env_key)
    if env_value is not None and str(env_value).strip() != "":
        return str(env_value).strip()
    return default


def parse_timeout(value: Any):
    try:
        timeout = float(value)
    except (TypeError, ValueError) as exc:
        raise LLMConfigError("LLM_TIMEOUT 必须是数字") from exc
    if timeout <= 0:
        raise LLMConfigError("LLM_TIMEOUT 必须大于 0")
    return int(timeout) if timeout.is_integer() else timeout


def save_config(
    payload: dict[str, Any],
    *,
    config_path: Optional[Path] = None,
    env: Optional[dict[str, str]] = None,
):
    env = os.environ if env is None else env
    config_path = default_config_path() if config_path is None else config_path
    existing = read_saved_config(config_path)
    provider = str(payload.get("provider") or existing.get("provider") or env.get("LLM_PROVIDER") or DEFAULT_PROVIDER).strip().lower()
    defaults = PROVIDER_DEFAULTS.get(provider, {})

    if provider not in ("deepseek", "aliyun", "custom"):
        raise LLMConfigError("provider 只能是 deepseek、aliyun 或 custom")

    api_key = str(payload.get("api_key") or "").strip()
    if not api_key:
        api_key = str(existing.get("api_key") or "").strip()

    model = str(payload.get("model") or "").strip() or defaults.get("model", "")
    base_url = str(payload.get("base_url") or "").strip() or defaults.get("base_url", "")
    timeout = parse_timeout(payload.get("timeout") or existing.get("timeout") or env.get("LLM_TIMEOUT") or DEFAULT_TIMEOUT)

    candidate = {
        "provider": provider,
        "api_key": api_key,
        "model": model,
        "base_url": base_url,
        "timeout": timeout,
    }
    if provider == "custom":
        missing = []
        if not model:
            missing.append("model")
        if not base_url:
            missing.append("base_url")
        if missing:
            raise LLMConfigError("custom 配置缺少: " + "、".join(missing))

    config_path.parent.mkdir(parents=True, exist_ok=True)
    config_path.write_text(
        json.dumps(candidate, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    try:
        config_path.chmod(0o600)
    except OSError:
        pass

    config = resolve_config(env=env, config_path=config_path, require_api_key=False)
    return config_response(config)


def config_response(config: RuntimeLLMConfig):
    return {
        "provider": config.provider,
        "model": config.model,
        "base_url": config.base_url,
        "timeout": config.timeout,
        "api_key_configured": bool(config.api_key),
        "api_key_masked": mask_api_key(config.api_key),
        "source": config.source,
    }


def mask_api_key(api_key: str):
    if not api_key:
        return ""
    if len(api_key) <= 7:
        return "****"
    return f"{api_key[:3]}****{api_key[-4:]}"


def chat_completions_url(config: RuntimeLLMConfig):
    base_url = config.base_url.rstrip("/")
    if base_url.endswith("/chat/completions"):
        return base_url
    return f"{base_url}/chat/completions"


def build_rewrite_payload(
    config: RuntimeLLMConfig,
    *,
    text: str,
    source: str,
    style: str,
):
    return {
        "model": config.model,
        "messages": [
            {"role": "system", "content": build_system_prompt(source, style)},
            {"role": "user", "content": text},
        ],
        "temperature": 0.7,
        "max_tokens": 1200,
    }


def build_system_prompt(source: str, style: str):
    source_prompt = {
        "caption": "你正在改写短视频原始文案。请保留视频主题、关键信息和原本意图。",
        "transcript": "你正在改写 ASR 声音对话。请保留事实和语义，不编造视频中没有的信息。",
    }.get(source, "请改写用户提供的文本。")
    style_prompt = {
        "social": "输出适合短视频或社媒发布的自然中文文案。",
        "summary": "输出简洁摘要，便于快速了解内容。",
        "polished": "输出更正式、通顺、克制的中文表达。",
    }.get(style, "输出适合社媒发布的自然中文文案。")
    return f"{source_prompt}{style_prompt}只返回改写结果，不要解释过程。"


def extract_message_text(payload: Any):
    try:
        text = payload["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError) as exc:
        raise LLMServiceError("模型返回格式无法解析") from exc
    if not isinstance(text, str) or not text.strip():
        raise LLMServiceError("模型返回内容为空")
    return text.strip()


def rewrite_text(
    config: RuntimeLLMConfig,
    *,
    text: str,
    source: str,
    style: str,
    post: Optional[Callable[..., Any]] = None,
):
    if post is None:
        import requests

        post = requests.post
    payload = build_rewrite_payload(config, text=text, source=source, style=style)
    try:
        response = post(
            chat_completions_url(config),
            headers={
                "Authorization": f"Bearer {config.api_key}",
                "Content-Type": "application/json",
            },
            json=payload,
            timeout=config.timeout,
        )
        response.raise_for_status()
        return extract_message_text(response.json())
    except LLMServiceError:
        raise
    except Exception as exc:
        raise LLMServiceError(f"模型服务请求失败: {exc}") from exc
