import asyncio
import json
import subprocess
from pathlib import Path

from .config import (
    ASR_PROVIDER,
    LOCAL_ASR_MODEL_DIR,
    REMOTE_ASR_LANG,
    REMOTE_ASR_PATH,
    REMOTE_ASR_TIMEOUT,
    REMOTE_ASR_URL,
)


ASR_MODEL_NAME = "base"
ASR_MODEL = None
ASR_READY = False
ASR_ERROR = ""


async def get_status():
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
