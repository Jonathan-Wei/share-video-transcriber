import asyncio
import json
import re
from pathlib import Path

from fastapi import HTTPException, UploadFile

from .asr import ASR_MODEL_NAME, transcribe_video
from .config import CLI_PATH, DOWNLOAD_DIR, ROOT
from .files import (
    build_transcribe_path,
    normalize_result,
    now_iso,
    read_metadata,
)
from .schemas import DownloadRequest


tasks: dict[str, dict] = {}


def create_task(task_id: str, payload: DownloadRequest):
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
    return tasks[task_id]


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


def append_log(task: dict, line: str):
    task["logs"].append(line)
    task["logs"] = task["logs"][-80:]


def touch(task: dict):
    task["updated_at"] = now_iso()
