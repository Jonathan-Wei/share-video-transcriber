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
