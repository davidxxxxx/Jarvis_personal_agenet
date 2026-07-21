"""Isolated ClearerVoice/MossFormer2 worker for Jarvis overlap review.

Jarvis vendors the official ClearerVoice-Studio v0.1.2 inference source instead
of installing the PyPI wrapper whose metadata rejects NumPy 2.x. The worker is
still a separate process so overlap failures cannot corrupt primary diarization.
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import sys
import traceback
from typing import Any


def _lower_windows_priority() -> None:
    if os.name != "nt":
        return
    try:
        import ctypes

        below_normal_priority_class = 0x00004000
        handle = ctypes.windll.kernel32.GetCurrentProcess()
        ctypes.windll.kernel32.SetPriorityClass(handle, below_normal_priority_class)
    except Exception:
        pass


def _response(request_id: str, *, result: Any = None, error: Exception | None = None) -> None:
    if error is None:
        message = {"id": request_id, "ok": True, "result": result}
    else:
        code = getattr(error, "code", None) or type(error).__name__.upper()
        message = {
            "id": request_id,
            "ok": False,
            "error": {"code": str(code)[:128], "message": str(error)[:2048]},
        }
    sys.stdout.write(json.dumps(message, ensure_ascii=False, separators=(",", ":")) + "\n")
    sys.stdout.flush()


class MossFormerModels:
    def __init__(self, model_root: Path) -> None:
        self.model_root = model_root.resolve()
        self.separator = None

    def _assert_cuda(self) -> Any:
        import torch

        if not torch.cuda.is_available():
            error = RuntimeError("CUDA is unavailable to the overlap separator")
            error.code = "DIARIZATION_CUDA_UNAVAILABLE"
            raise error
        return torch

    def load(self) -> Any:
        if self.separator is not None:
            return self.separator
        self._assert_cuda()
        checkpoint = (
            self.model_root
            / "checkpoints"
            / "MossFormer2_SS_16K"
            / "last_best_checkpoint"
        )
        if not checkpoint.is_file():
            error = FileNotFoundError(f"missing offline MossFormer2 checkpoint: {checkpoint}")
            error.code = "AI_MODEL_PACK_INCOMPLETE"
            raise error
        source_root = self.model_root / "vendor" / "clearervoice-studio"
        if not (source_root / "clearvoice" / "__init__.py").is_file():
            error = FileNotFoundError("vendored ClearerVoice-Studio source is unavailable")
            error.code = "AI_MODEL_PACK_INCOMPLETE"
            raise error
        sys.path.insert(0, str(source_root))
        from clearvoice import ClearVoice

        previous = Path.cwd()
        try:
            os.chdir(self.model_root)
            self.separator = ClearVoice(
                task="speech_separation", model_names=["MossFormer2_SS_16K"]
            )
        finally:
            os.chdir(previous)
        return self.separator

    def self_test(self, load_model: bool) -> dict[str, Any]:
        torch = self._assert_cuda()
        probe = torch.ones((32, 32), device="cuda", dtype=torch.float32)
        probe_value = float((probe @ probe).sum().item())
        torch.cuda.synchronize()
        if load_model:
            self.load()
        return {
            "cuda": True,
            "gpu": torch.cuda.get_device_name(torch.cuda.current_device()),
            "probe": probe_value,
            "separatorLoaded": load_model,
        }

    def separate(self, request: dict[str, Any]) -> dict[str, Any]:
        import numpy as np
        import soundfile as sf

        audio_path = Path(str(request.get("audioPath", ""))).resolve()
        if not audio_path.is_file():
            error = FileNotFoundError("overlap audio is unavailable")
            error.code = "DIARIZATION_AUDIO_UNAVAILABLE"
            raise error
        windows = request.get("windows")
        if not isinstance(windows, list) or len(windows) > 10_000:
            raise ValueError("overlap windows are invalid")
        separator = self.load()
        audio, sample_rate = sf.read(str(audio_path), dtype="float32", always_2d=False)
        if sample_rate != 16000:
            error = ValueError("final diarization input must be 16 kHz")
            error.code = "DIARIZATION_SAMPLE_RATE_MISMATCH"
            raise error
        if audio.ndim > 1:
            audio = np.mean(audio, axis=1, dtype=np.float32)
        stem_counts: list[int] = []
        processed = 0
        for window in windows:
            start_ms = int(window.get("startMs", -1))
            end_ms = int(window.get("endMs", -1))
            if start_ms < 0 or end_ms <= start_ms:
                raise ValueError("overlap window is invalid")
            start = round(start_ms * sample_rate / 1000)
            end = min(audio.shape[0], round(end_ms * sample_rate / 1000))
            clip = np.asarray(audio[start:end], dtype=np.float32).reshape(1, -1)
            if clip.shape[1] < sample_rate // 4:
                stem_counts.append(0)
                continue
            separated = np.asarray(separator(clip, False), dtype=np.float32)
            if separated.ndim != 3 or separated.shape[0] < 2:
                error = RuntimeError("MossFormer2 returned an invalid separation tensor")
                error.code = "OVERLAP_SEPARATION_INVALID_RESULT"
                raise error
            audible = 0
            for stem in separated[:, 0, :]:
                rms = float(np.sqrt(np.mean(np.square(stem), dtype=np.float64)))
                if np.isfinite(rms) and rms >= 0.001:
                    audible += 1
            stem_counts.append(audible)
            processed += 1
        return {
            "state": "completed" if processed == len(windows) else "partial",
            "processed": processed,
            "total": len(windows),
            "stemCounts": stem_counts,
        }


def _serve(model_root: Path) -> int:
    _lower_windows_priority()
    os.environ.setdefault("HF_HUB_OFFLINE", "1")
    os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
    models = MossFormerModels(model_root)
    for raw_line in sys.stdin:
        request_id = "unknown"
        try:
            request = json.loads(raw_line)
            request_id = str(request.get("id", ""))[:128]
            command = request.get("command")
            if not request_id:
                raise ValueError("request id is required")
            if command == "shutdown":
                _response(request_id, result={"stopped": True})
                return 0
            if command == "self_test":
                _response(request_id, result=models.self_test(request.get("loadModel") is True))
                continue
            if command != "separate":
                raise ValueError("unsupported separator command")
            _response(request_id, result=models.separate(request))
        except Exception as error:
            traceback.print_exc(file=sys.stderr)
            _response(request_id, error=error)
    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--server", action="store_true")
    parser.add_argument("--model-root", required=True)
    args = parser.parse_args()
    if args.server:
        return _serve(Path(args.model_root))
    parser.error("--server is required")


if __name__ == "__main__":
    raise SystemExit(main())
