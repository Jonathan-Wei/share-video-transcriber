import os
from pathlib import Path


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
