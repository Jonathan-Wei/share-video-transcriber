import asyncio
import json
import os
import re
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field


ROOT = Path(__file__).resolve().parents[1]


def load_dotenv(path: Path):
    if not path.exists():
        return

    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[len("export ") :].strip()
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip("'\"")
        if key and key not in os.environ:
            os.environ[key] = value


load_dotenv(ROOT / ".env")

DOWNLOAD_DIR = Path(os.getenv("DOWNLOAD_DIR", ROOT / "downloads")).resolve()
CLI_PATH = ROOT / "src" / "cli.js"
STATIC_DIR = Path(__file__).resolve().parent / "static"
LOCAL_ASR_MODEL_DIR = Path(
    os.getenv("ASR_MODEL_DIR", ROOT / "models" / "faster-whisper-base")
).resolve()
ASR_PROVIDER = os.getenv("ASR_PROVIDER", "remote").strip().lower()
REMOTE_ASR_URL = os.getenv("REMOTE_ASR_URL", "").rstrip("/")
REMOTE_ASR_PATH = os.getenv("REMOTE_ASR_PATH", "/api/v1/asr")
REMOTE_ASR_LANG = os.getenv("REMOTE_ASR_LANG", "auto")
REMOTE_ASR_TIMEOUT = float(os.getenv("REMOTE_ASR_TIMEOUT", "300"))
ASR_PRELOAD = os.getenv("ASR_PRELOAD", "0").lower() not in ("0", "false", "no")

app = FastAPI(title="Share Video Transcriber API")
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

TaskStatus = Literal["queued", "running", "completed", "failed"]
tasks: dict[str, dict] = {}
ASR_MODEL_NAME = "base"
ASR_MODEL = None
ASR_READY = False
ASR_ERROR = ""


@app.on_event("startup")
async def startup():
    if ASR_PRELOAD:
        await asyncio.to_thread(preload_asr_model)
    load_existing_downloads()


def load_existing_downloads():
    for metadata_path in sorted(DOWNLOAD_DIR.glob("*.json"), reverse=True):
        metadata = read_metadata(metadata_path)
        video_path = metadata.get("video", {}).get("path")
        if not video_path:
            continue

        task_id = f"file-{metadata_path.stem}"
        tasks[task_id] = {
            "id": task_id,
            "status": "completed",
            "url": metadata.get("shareUrl", ""),
            "progress": {
                "percent": 100,
                "downloaded": "",
                "total": "",
                "message": "已加载历史下载",
            },
            "result": normalize_result(
                {
                    "outputPath": video_path,
                    "videoUrl": metadata.get("video", {}).get("url", ""),
                    "metadataPath": str(metadata_path),
                }
            ),
            "error": "",
            "logs": [],
            "created_at": now_iso(),
            "updated_at": now_iso(),
        }


class DownloadRequest(BaseModel):
    url: str = Field(..., min_length=8)
    output_name: str | None = None
    headful: bool = False
    transcribe: bool = False
    asr_model: str = "base"
    timeout: int = Field(default=30000, ge=1000, le=120000)


@app.get("/")
async def index():
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/api/asr/status")
async def asr_status():
    global ASR_READY, ASR_ERROR

    if ASR_PROVIDER == "remote":
        try:
            await asyncio.to_thread(check_remote_asr)
            ASR_READY = True
            ASR_ERROR = ""
        except Exception as exc:
            ASR_READY = False
            ASR_ERROR = str(exc)

    return {
        "ready": ASR_READY,
        "provider": ASR_PROVIDER,
        "model": ASR_MODEL_NAME,
        "remoteUrl": REMOTE_ASR_URL if ASR_PROVIDER == "remote" else "",
        "error": ASR_ERROR,
    }


@app.post("/api/downloads")
async def create_download(payload: DownloadRequest):
    task_id = uuid.uuid4().hex
    output_path = build_output_path(payload.output_name, task_id)
    tasks[task_id] = {
        "id": task_id,
        "status": "queued",
        "url": payload.url,
        "progress": {
            "percent": None,
            "downloaded": "",
            "total": "",
            "message": "等待开始",
        },
        "result": None,
        "error": "",
        "logs": [],
        "created_at": now_iso(),
        "updated_at": now_iso(),
    }

    asyncio.create_task(run_download(task_id, payload, output_path))
    return tasks[task_id]


@app.get("/api/downloads")
async def list_downloads():
    return sorted(tasks.values(), key=lambda item: item["created_at"], reverse=True)


@app.get("/api/downloads/{task_id}")
async def get_download(task_id: str):
    task = tasks.get(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="任务不存在")
    return task


@app.post("/api/downloads/{task_id}/transcribe")
async def transcribe_download(task_id: str):
    task = tasks.get(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="任务不存在")
    if task["status"] not in ("completed", "failed"):
        raise HTTPException(status_code=409, detail="任务还没有完成")
    if not task.get("result", {}).get("outputPath"):
        raise HTTPException(status_code=400, detail="没有可转写的视频文件")

    task["status"] = "running"
    task["progress"]["message"] = "正在提取声音对话"
    asyncio.create_task(run_transcription(task_id, Path(task["result"]["outputPath"]), "base"))
    touch(task)
    return task


@app.post("/transcribe")
async def transcribe(
    type: str = Form(..., description="处理类型: url=下载视频并转写, audio=上传音频转写, video=上传视频转写"),
    url: str | None = Form(default=None, description="视频URL (type=url时必填)"),
    file: UploadFile | None = File(default=None, description="上传文件 (type=audio/video时必填)"),
):
    """
    统一转写接口。

    - type=url: 下载视频URL并转写，需要传 url 参数
    - type=audio: 上传音频文件转写，需要传 file 参数
    - type=video: 上传视频文件转写，需要传 file 参数
    """
    kind = type.strip().lower()
    if kind == "url":
        if not url or not re.search(r"https?://\S+", url):
            raise HTTPException(status_code=400, detail="type=url 时必须传入有效 url")
        media_path = await download_url_for_transcription(url)
    elif kind in ("audio", "video"):
        if file is None:
            raise HTTPException(status_code=400, detail=f"type={kind} 时必须上传 file")
        media_path = await save_transcription_upload(file, kind)
    else:
        raise HTTPException(status_code=400, detail="type 只能是 url、audio 或 video")

    try:
        transcript = await asyncio.to_thread(transcribe_video, media_path, ASR_MODEL_NAME)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"转写失败: {exc}") from exc

    return {"text": transcript.get("text", "")}


@app.get("/api/files/{file_path:path}")
async def get_file(file_path: str):
    path = safe_download_path(file_path)
    if not path.exists() or not path.is_file():
        raise HTTPException(status_code=404, detail="文件不存在")
    return FileResponse(path)


async def run_download(task_id: str, payload: DownloadRequest, output_path: Path):
    task = tasks[task_id]
    task["status"] = "running"
    touch(task)

    command = [
        "node",
        str(CLI_PATH),
        payload.url,
        "--output",
        str(output_path),
        "--timeout",
        str(payload.timeout),
        "--json",
    ]
    if payload.headful:
        command.append("--headful")

    process = await asyncio.create_subprocess_exec(
        *command,
        cwd=str(ROOT),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )

    stdout_task = asyncio.create_task(read_stdout(task, process.stdout))
    stderr_task = asyncio.create_task(read_stderr(task, process.stderr))
    code = await process.wait()
    await stdout_task
    await stderr_task

    if code == 0 and task.get("_json_result"):
        result = normalize_result(task["_json_result"])
        task["result"] = result
        if payload.transcribe:
            task["progress"]["message"] = "下载完成，正在提取声音对话"
            try:
                await transcribe_video_into_task(task, Path(result["outputPath"]), payload.asr_model)
            except Exception as exc:
                task["error"] = f"下载完成，但对话提取失败: {exc}"
                append_log(task, task["error"])
        task["status"] = "completed"
        task["progress"] = completed_progress(
            task,
            "下载完成" if not task["error"] else "下载完成，对话提取失败",
        )
    else:
        task["status"] = "failed"
        task["error"] = task["logs"][-1] if task["logs"] else f"下载进程退出: {code}"
        task["progress"]["message"] = "下载失败"

    task.pop("_json_result", None)
    touch(task)


async def run_transcription(task_id: str, video_path: Path, model_name: str):
    task = tasks[task_id]
    try:
        await transcribe_video_into_task(task, video_path, model_name)
        task["status"] = "completed"
        task["progress"] = completed_progress(task, "对话提取完成")
    except Exception as exc:
        task["status"] = "failed"
        task["error"] = str(exc)
        task["progress"]["message"] = "对话提取失败"
    finally:
        touch(task)


async def transcribe_video_into_task(task: dict, video_path: Path, model_name: str):
    append_log(task, "正在抽取音频")
    touch(task)
    transcript = await asyncio.to_thread(transcribe_video, video_path, model_name)
    metadata_path = task.get("result", {}).get("metadataPath")
    if metadata_path:
        metadata = read_metadata(Path(metadata_path))
        metadata["transcript"] = transcript
        Path(metadata_path).write_text(
            json.dumps(metadata, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
    task["result"] = normalize_result(task["result"])
    append_log(task, f"对话提取完成: {transcript.get('textPath', '')}")
    touch(task)


async def download_url_for_transcription(url: str):
    output_path = build_transcribe_path(".mp4")
    command = [
        "node",
        str(CLI_PATH),
        url,
        "--output",
        str(output_path),
        "--timeout",
        "30000",
        "--quality",
        "low",
        "--json",
    ]

    process = await asyncio.create_subprocess_exec(
        *command,
        cwd=str(ROOT),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, stderr = await process.communicate()
    stdout_text = stdout.decode("utf-8", errors="replace")
    stderr_text = stderr.decode("utf-8", errors="replace")

    result = None
    for line in stdout_text.splitlines():
        try:
            result = json.loads(line)
        except json.JSONDecodeError:
            continue

    if process.returncode != 0 or not result:
        message = stderr_text.strip().splitlines()[-1:] or stdout_text.strip().splitlines()[-1:]
        detail = message[0] if message else f"下载进程退出: {process.returncode}"
        raise HTTPException(status_code=400, detail=f"视频下载失败: {detail}")

    downloaded_path = Path(result.get("outputPath") or output_path)
    if not downloaded_path.exists():
        raise HTTPException(status_code=500, detail="视频下载完成但未找到输出文件")
    return downloaded_path


async def save_transcription_upload(file: UploadFile, kind: str):
    suffix = Path(file.filename or "").suffix
    if not suffix:
        suffix = ".mp4" if kind == "video" else ".audio"

    output_path = build_transcribe_path(suffix)
    try:
        with output_path.open("wb") as target:
            while chunk := await file.read(1024 * 1024):
                target.write(chunk)
    finally:
        await file.close()

    return output_path


def build_transcribe_path(suffix: str):
    transcribe_dir = DOWNLOAD_DIR / "transcribe"
    transcribe_dir.mkdir(parents=True, exist_ok=True)
    clean_suffix = sanitize_filename(suffix)
    if not clean_suffix.startswith("."):
        clean_suffix = f".{clean_suffix}"
    return transcribe_dir / f"transcribe-{uuid.uuid4().hex}{clean_suffix}"


def transcribe_video(video_path: Path, model_name: str):
    audio_path = video_path.with_suffix(".audio.wav")
    transcript_json_path = video_path.with_suffix(".transcript.json")
    transcript_text_path = video_path.with_suffix(".transcript.txt")
    run_ffmpeg_extract(video_path, audio_path)

    if ASR_PROVIDER == "remote":
        transcript = transcribe_audio_remote(audio_path, model_name)
        transcript_json_path.write_text(
            json.dumps(transcript, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        transcript_text_path.write_text(
            transcript.get("text", "") + ("\n" if transcript.get("text") else ""),
            encoding="utf-8",
        )
        transcript["jsonPath"] = str(transcript_json_path)
        transcript["textPath"] = str(transcript_text_path)
        return transcript

    model = get_asr_model(model_name)
    segments, info = model.transcribe(
        str(audio_path),
        language="zh",
        vad_filter=True,
        beam_size=5,
    )

    segment_data = []
    lines = []
    for segment in segments:
        text = segment.text.strip()
        if not text:
            continue
        item = {
            "start": round(segment.start, 3),
            "end": round(segment.end, 3),
            "text": text,
        }
        segment_data.append(item)
        lines.append(text)

    text = "\n".join(lines)
    transcript_text_path.write_text(text + ("\n" if text else ""), encoding="utf-8")
    transcript = {
        "model": model_name,
        "language": getattr(info, "language", "zh"),
        "languageProbability": getattr(info, "language_probability", None),
        "text": "\n".join(item["text"] for item in segment_data),
        "segments": segment_data,
        "audioPath": str(audio_path),
        "jsonPath": str(transcript_json_path),
        "textPath": str(transcript_text_path),
    }
    transcript_json_path.write_text(
        json.dumps(transcript, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return transcript


def preload_asr_model():
    global ASR_READY, ASR_ERROR

    try:
        if ASR_PROVIDER == "remote":
            check_remote_asr()
        else:
            get_asr_model(ASR_MODEL_NAME)
        ASR_READY = True
        ASR_ERROR = ""
    except Exception as exc:
        ASR_READY = False
        ASR_ERROR = str(exc)


def check_remote_asr():
    import requests

    if not REMOTE_ASR_URL:
        raise RuntimeError("REMOTE_ASR_URL 未配置，请在 .env 中设置远程 ASR 服务地址")
    health_url = f"{REMOTE_ASR_URL}/health"
    response = requests.get(health_url, timeout=min(REMOTE_ASR_TIMEOUT, 10))
    response.raise_for_status()


def transcribe_audio_remote(audio_path: Path, model_name: str):
    global ASR_READY, ASR_ERROR

    import requests

    if not REMOTE_ASR_URL:
        raise RuntimeError("REMOTE_ASR_URL 未配置，请在 .env 中设置远程 ASR 服务地址")
    endpoint = f"{REMOTE_ASR_URL}{REMOTE_ASR_PATH}"
    try:
        with audio_path.open("rb") as audio_file:
            response = requests.post(
                endpoint,
                files=[("files", (audio_path.name, audio_file, "audio/wav"))],
                data={"keys": audio_path.name, "lang": REMOTE_ASR_LANG},
                timeout=REMOTE_ASR_TIMEOUT,
            )
        response.raise_for_status()
        payload = response.json()
        text = extract_remote_asr_text(payload)
        ASR_READY = True
        ASR_ERROR = ""
        return {
            "model": model_name,
            "provider": "remote",
            "remoteUrl": REMOTE_ASR_URL,
            "language": REMOTE_ASR_LANG,
            "languageProbability": None,
            "text": text,
            "segments": [],
            "audioPath": str(audio_path),
            "jsonPath": "",
            "textPath": "",
            "raw": payload,
        }
    except Exception as exc:
        ASR_READY = False
        ASR_ERROR = str(exc)
        raise RuntimeError(f"远程 ASR 调用失败: {exc}") from exc


def extract_remote_asr_text(payload):
    if isinstance(payload, str):
        return payload

    if isinstance(payload, dict):
        for key in ("text", "result", "transcript", "content"):
            value = payload.get(key)
            if isinstance(value, str):
                return value
            if isinstance(value, list):
                return "\n".join(str(item) for item in value if item)

        data = payload.get("data")
        if isinstance(data, (dict, list, str)):
            return extract_remote_asr_text(data)

    if isinstance(payload, list):
        lines = [extract_remote_asr_text(item) for item in payload]
        return "\n".join(line for line in lines if line)

    return ""


def get_asr_model(model_name: str):
    global ASR_MODEL, ASR_READY, ASR_ERROR

    if ASR_MODEL is not None and model_name == ASR_MODEL_NAME:
        return ASR_MODEL

    try:
        from faster_whisper import WhisperModel
    except ImportError as exc:
        ASR_READY = False
        ASR_ERROR = "缺少 faster-whisper 依赖，请先运行: python3 -m pip install -r requirements.txt"
        raise RuntimeError(ASR_ERROR) from exc

    try:
        model_source = str(LOCAL_ASR_MODEL_DIR) if LOCAL_ASR_MODEL_DIR.exists() else model_name
        ASR_MODEL = WhisperModel(model_source, device="cpu", compute_type="int8")
        ASR_READY = True
        ASR_ERROR = ""
        return ASR_MODEL
    except Exception as exc:
        ASR_READY = False
        ASR_ERROR = str(exc)
        raise


def run_ffmpeg_extract(video_path: Path, audio_path: Path):
    import subprocess

    command = [
        "ffmpeg",
        "-y",
        "-i",
        str(video_path),
        "-vn",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-f",
        "wav",
        str(audio_path),
    ]
    result = subprocess.run(command, capture_output=True, text=True, check=False)
    if result.returncode != 0:
        raise RuntimeError(f"ffmpeg 抽取音频失败: {result.stderr[-1000:]}")


def completed_progress(task: dict, message: str):
    return {
        "percent": 100,
        "downloaded": task["progress"].get("downloaded", ""),
        "total": task["progress"].get("total", ""),
        "message": message,
    }


async def read_stdout(task: dict, stream):
    while line := await stream.readline():
        text = line.decode("utf-8", errors="replace").strip()
        if not text:
            continue
        try:
            task["_json_result"] = json.loads(text)
        except json.JSONDecodeError:
            append_log(task, text)
        touch(task)


async def read_stderr(task: dict, stream):
    buffer = ""
    while chunk := await stream.read(256):
        buffer += chunk.decode("utf-8", errors="replace")
        parts = re.split(r"[\r\n]+", buffer)
        buffer = parts.pop() if parts else ""
        for part in parts:
            update_progress_from_line(task, part.strip())
    if buffer.strip():
        update_progress_from_line(task, buffer.strip())


def update_progress_from_line(task: dict, line: str):
    if not line:
        return

    append_log(task, line)
    percent_match = re.search(r"(\d+(?:\.\d+)?)%", line)
    size_match = re.search(r"([0-9.]+\s+[KMG]?B)\s*/\s*([0-9.]+\s+[KMG]?B)", line)
    if percent_match:
        task["progress"]["percent"] = float(percent_match.group(1))
    if size_match:
        task["progress"]["downloaded"] = size_match.group(1)
        task["progress"]["total"] = size_match.group(2)
    elif "下载中:" in line:
        task["progress"]["downloaded"] = line.split("下载中:", 1)[1].strip()

    if "尝试下载候选" in line:
        task["progress"]["message"] = line
    elif "下载中:" in line:
        task["progress"]["message"] = "下载中"

    touch(task)


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


def safe_download_path(file_path: str):
    path = (DOWNLOAD_DIR / file_path).resolve()
    try:
        path.relative_to(DOWNLOAD_DIR.resolve())
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="非法文件路径") from exc
    return path


def sanitize_filename(name: str):
    return re.sub(r'[\\/:*?"<>|]+', "_", name)


def append_log(task: dict, line: str):
    task["logs"].append(line)
    task["logs"] = task["logs"][-80:]


def touch(task: dict):
    task["updated_at"] = now_iso()


def now_iso():
    return datetime.now(timezone.utc).isoformat()
