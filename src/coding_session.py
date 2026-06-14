# src/coding_session.py
"""CodingSession — per-session storage for the Coding tool."""
from __future__ import annotations
import json, logging, uuid
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional
import os
# Self-contained: derive our session dir from the host's DATA_DIR rather than importing
# a coding-specific constant (CODING_SESSIONS_DIR) that a vanilla Odysseus doesn't define.
try:
    from src.constants import CODING_SESSIONS_DIR
except ImportError:
    from src.constants import DATA_DIR
    CODING_SESSIONS_DIR = os.path.join(DATA_DIR, "coding_sessions")

logger = logging.getLogger(__name__)
SESSIONS_DIR = Path(CODING_SESSIONS_DIR)

EFFORT_BUDGETS = [0, 2048, 8192, 32000, 64000]
EFFORT_LABELS  = ["Min", "Low", "Med", "High", "Max"]
VALID_MODES    = {"ask", "accept", "plan", "auto", "bypass"}


@dataclass
class CodingSession:
    id: str
    name: str
    root_path: str
    messages: list = field(default_factory=list)
    mode: str = "auto"
    effort_level: int = 2
    created_at: str = ""
    updated_at: str = ""
    git_branch: str = ""
    todo: list = field(default_factory=list)
    model: str = ""  # preferred model spec; "" = resolve default
    num_ctx: int = 0  # user-chosen context window (0 = model default); set by the wheel slider
    # Render transcript: compact event log (user/think/tool/text) so the UI
    # can replay tool rows + thinking after an app restart. messages[] stays
    # the LLM-facing history; this is display-facing.
    transcript: list = field(default_factory=list)

    def __post_init__(self):
        if self.mode not in VALID_MODES:
            raise ValueError(f"Invalid mode {self.mode!r}. Must be one of {VALID_MODES}")
        if not (0 <= self.effort_level <= 4):
            raise ValueError(f"Invalid effort_level {self.effort_level}. Must be 0-4")

    @classmethod
    def create(cls, name: str = "New Session", root_path: str = "",
               mode: str = "auto", effort_level: int = 2) -> "CodingSession":
        now = datetime.now(timezone.utc).isoformat()
        return cls(id=str(uuid.uuid4()), name=name, root_path=root_path,
                   mode=mode, effort_level=effort_level,
                   created_at=now, updated_at=now)

    def save(self) -> None:
        SESSIONS_DIR.mkdir(parents=True, exist_ok=True)
        self.updated_at = datetime.now(timezone.utc).isoformat()
        path = SESSIONS_DIR / f"{self.id}.json"
        tmp  = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(asdict(self), indent=2, ensure_ascii=False), encoding="utf-8")
        tmp.replace(path)

    @classmethod
    def load(cls, session_id: str) -> Optional["CodingSession"]:
        path = SESSIONS_DIR / f"{session_id}.json"
        if not path.exists():
            return None
        try:
            return cls(**json.loads(path.read_text(encoding="utf-8")))
        except Exception as exc:
            logger.warning("Failed to load coding session %s: %s", session_id, exc)
            return None

    @classmethod
    def list_all(cls) -> list["CodingSession"]:
        SESSIONS_DIR.mkdir(parents=True, exist_ok=True)
        out = []
        for p in sorted(SESSIONS_DIR.glob("*.json"),
                        key=lambda x: x.stat().st_mtime, reverse=True):
            try:
                out.append(cls(**json.loads(p.read_text(encoding="utf-8"))))
            except Exception as exc:
                logger.warning("Skipping corrupt session %s: %s", p, exc)
        return out

    def delete(self) -> None:
        path = SESSIONS_DIR / f"{self.id}.json"
        if path.exists():
            path.unlink()

    def to_summary(self) -> dict:
        d = asdict(self)
        d.pop("messages")
        d["message_count"] = len(self.messages)
        return d

    def to_dict(self) -> dict:
        return asdict(self)
