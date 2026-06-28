from typing import Literal

from pydantic import BaseModel, Field


TaskStatus = Literal["queued", "running", "completed", "failed"]


class DownloadRequest(BaseModel):
    url: str = Field(..., min_length=8)
    output_name: str | None = None
    headful: bool = False
    transcribe: bool = False
    asr_model: str = "base"
    timeout: int = Field(default=30000, ge=1000, le=120000)


RewriteSource = Literal["caption", "transcript"]
RewriteStyle = Literal["social", "summary", "polished"]
LLMProvider = Literal["deepseek", "aliyun", "custom"]


class RewriteRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=20000)
    source: RewriteSource
    style: RewriteStyle = "social"


class RewriteResponse(BaseModel):
    text: str
    provider: str
    model: str


class LLMConfigRequest(BaseModel):
    provider: LLMProvider
    api_key: str = ""
    model: str = ""
    base_url: str = ""
    timeout: float = Field(default=60, gt=0)


class LLMConfigResponse(BaseModel):
    provider: str
    model: str
    base_url: str
    timeout: float
    api_key_configured: bool
    api_key_masked: str
    source: str
