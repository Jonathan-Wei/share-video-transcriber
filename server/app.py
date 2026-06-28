import asyncio
import re
import uuid
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from . import asr
from .config import ASR_PRELOAD, STATIC_DIR
from .files import build_output_path, safe_download_path
from .schemas import DownloadRequest
from .tasks import (
    create_task,
    download_url_for_transcription,
    load_existing_downloads,
    run_download,
    run_transcription,
    save_transcription_upload,
    tasks,
    touch,
)


app = FastAPI(title="Share Video Transcriber API")
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.on_event("startup")
async def startup():
    if ASR_PRELOAD:
        await asyncio.to_thread(asr.preload_asr_model)
    load_existing_downloads()


@app.get("/")
async def index():
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/api/asr/status")
async def asr_status():
    return await asr.get_status()


@app.post("/api/downloads")
async def create_download(payload: DownloadRequest):
    task_id = uuid.uuid4().hex
    output_path = build_output_path(payload.output_name, task_id)
    task = create_task(task_id, payload)
    asyncio.create_task(run_download(task_id, payload, output_path))
    return task


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
    touch(task)
    asyncio.create_task(run_transcription(task_id, Path(task["result"]["outputPath"]), "base"))
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
        transcript = await asyncio.to_thread(asr.transcribe_video, media_path, asr.ASR_MODEL_NAME)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"转写失败: {exc}") from exc

    return {"text": transcript.get("text", "")}


@app.get("/api/files/{file_path:path}")
async def get_file(file_path: str):
    path = safe_download_path(file_path)
    if not path.exists() or not path.is_file():
        raise HTTPException(status_code=404, detail="文件不存在")
    return FileResponse(path)
