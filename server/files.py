import json
import re
import uuid
from datetime import datetime, timezone
from pathlib import Path

from fastapi import HTTPException

from .config import DOWNLOAD_DIR


def normalize_result(result: dict):
    normalized = {}
    for key, value in result.items():
        normalized[key] = value
        if key.endswith("Path") and isinstance(value, str):
            normalized[f"{key}Url"] = file_url(value)
    metadata_path = normalized.get("metadataPath")
    if metadata_path:
        metadata = read_metadata(Path(metadata_path))
        normalized["metadata"] = attach_asset_urls(metadata)
    return normalized


def read_metadata(path: Path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


def attach_asset_urls(metadata: dict):
    if not isinstance(metadata, dict):
        return {}

    for section in ("video", "cover"):
        path = metadata.get(section, {}).get("path")
        if path:
            metadata[section]["pathUrl"] = file_url(path)

    for subtitle in metadata.get("subtitles", []):
        path = subtitle.get("path")
        if path:
            subtitle["pathUrl"] = file_url(path)
            subtitle["content"] = read_text_asset(Path(path), max_chars=20000)

    transcript = metadata.get("transcript")
    if isinstance(transcript, dict):
        for key in ("audioPath", "jsonPath", "textPath"):
            path = transcript.get(key)
            if path:
                transcript[f"{key}Url"] = file_url(path)
        text_path = transcript.get("textPath")
        if text_path:
            transcript["content"] = read_text_asset(Path(text_path), max_chars=30000)

    return metadata


def read_text_asset(path: Path, max_chars: int = 20000):
    try:
        return path.read_text(encoding="utf-8", errors="replace")[:max_chars]
    except OSError:
        return ""


def file_url(path: str):
    absolute = Path(path).resolve()
    try:
        relative = absolute.relative_to(DOWNLOAD_DIR.resolve())
    except ValueError:
        return ""
    return f"/api/files/{relative.as_posix()}"


def build_output_path(output_name: str | None, task_id: str):
    DOWNLOAD_DIR.mkdir(parents=True, exist_ok=True)
    name = output_name.strip() if output_name else f"task-{task_id}.mp4"
    if not Path(name).suffix:
        name = f"{name}.mp4"
    return DOWNLOAD_DIR / sanitize_filename(name)


def build_transcribe_path(suffix: str):
    transcribe_dir = DOWNLOAD_DIR / "transcribe"
    transcribe_dir.mkdir(parents=True, exist_ok=True)
    clean_suffix = sanitize_filename(suffix)
    if not clean_suffix.startswith("."):
        clean_suffix = f".{clean_suffix}"
    return transcribe_dir / f"transcribe-{uuid.uuid4().hex}{clean_suffix}"


def safe_download_path(file_path: str):
    path = (DOWNLOAD_DIR / file_path).resolve()
    try:
        path.relative_to(DOWNLOAD_DIR.resolve())
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="非法文件路径") from exc
    return path


def sanitize_filename(name: str):
    return re.sub(r'[\\/:*?"<>|]+', "_", name)


def now_iso():
    return datetime.now(timezone.utc).isoformat()
