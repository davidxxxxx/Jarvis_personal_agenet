"""Offline CUDA sidecar for Jarvis final speaker diarization.

The process uses a JSON-lines protocol over stdin/stdout. All diagnostics go to
stderr so Electron never mistakes logs for a response. Model loading is lazy;
the parent process owns the five-minute idle lifetime.
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


def _overlap_windows(turns: list[dict[str, Any]], padding_ms: int, duration_ms: int) -> list[dict[str, int]]:
    events: list[tuple[int, int, str]] = []
    for turn in turns:
        events.append((int(turn["startMs"]), 1, str(turn["speaker"])))
        events.append((int(turn["endMs"]), -1, str(turn["speaker"])))
    events.sort(key=lambda value: (value[0], value[1]))
    active: dict[str, int] = {}
    started: int | None = None
    raw: list[tuple[int, int]] = []
    for at, kind, speaker in events:
        was_overlap = len(active) >= 2
        count = active.get(speaker, 0) + kind
        if count <= 0:
            active.pop(speaker, None)
        else:
            active[speaker] = count
        is_overlap = len(active) >= 2
        if not was_overlap and is_overlap:
            started = at
        elif was_overlap and not is_overlap and started is not None and at > started:
            raw.append((started, at))
            started = None
    padded = [
        {
            "startMs": max(0, start - padding_ms),
            "endMs": min(duration_ms, end + padding_ms),
        }
        for start, end in raw
    ]
    merged: list[dict[str, int]] = []
    for window in padded:
        if merged and window["startMs"] <= merged[-1]["endMs"]:
            merged[-1]["endMs"] = max(merged[-1]["endMs"], window["endMs"])
        else:
            merged.append(dict(window))
    return merged


class OfflineModels:
    def __init__(self, model_root: Path) -> None:
        self.model_root = model_root.resolve()
        self.primary = None
        self.separator = None

    def _assert_cuda(self) -> Any:
        import torch

        if not torch.cuda.is_available():
            error = RuntimeError("CUDA is unavailable to the final diarization sidecar")
            error.code = "DIARIZATION_CUDA_UNAVAILABLE"
            raise error
        return torch

    def load_primary(self) -> Any:
        if self.primary is not None:
            return self.primary
        torch = self._assert_cuda()
        from pyannote.audio import Pipeline

        model_path = self.model_root / "models" / "pyannote-community-1"
        if not (model_path / "config.yaml").is_file():
            error = FileNotFoundError(f"missing offline pyannote model: {model_path}")
            error.code = "AI_MODEL_PACK_INCOMPLETE"
            raise error
        pipeline = Pipeline.from_pretrained(str(model_path))
        pipeline.to(torch.device("cuda"))
        self.primary = pipeline
        return pipeline

    def load_separator(self) -> Any:
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

    def diarize(self, request: dict[str, Any]) -> dict[str, Any]:
        import soundfile as sf

        audio_path = Path(str(request.get("audioPath", ""))).resolve()
        if not audio_path.is_file():
            error = FileNotFoundError("diarization audio is unavailable")
            error.code = "DIARIZATION_AUDIO_UNAVAILABLE"
            raise error
        info = sf.info(str(audio_path))
        duration_ms = round(info.frames * 1000 / info.samplerate)
        minimum = max(1, min(8, int(request.get("minimumSpeakers", 1))))
        maximum = max(minimum, min(8, int(request.get("maximumSpeakers", 8))))
        import torch

        audio, sample_rate = sf.read(str(audio_path), dtype="float32", always_2d=True)
        waveform = torch.from_numpy(audio.T.copy())
        output = self.load_primary()(
            {"waveform": waveform, "sample_rate": sample_rate},
            min_speakers=minimum,
            max_speakers=maximum,
        )
        annotation = output.speaker_diarization
        turns = [
            {
                "speaker": str(speaker),
                "startMs": max(0, round(segment.start * 1000)),
                "endMs": min(duration_ms, round(segment.end * 1000)),
            }
            for segment, _, speaker in annotation.itertracks(yield_label=True)
            if segment.end > segment.start
        ]
        turns.sort(key=lambda turn: (turn["startMs"], turn["endMs"], turn["speaker"]))
        padding_ms = max(0, min(5000, int(request.get("overlapPaddingMs", 250))))
        windows = _overlap_windows(turns, padding_ms, duration_ms)
        separation = self._separate_overlap_windows(audio_path, windows)
        return {
            "durationMs": duration_ms,
            "turns": turns,
            "verifierCount": None,
            "overlapSeparation": separation,
        }

    def _separate_overlap_windows(
        self, audio_path: Path, windows: list[dict[str, int]]
    ) -> dict[str, Any]:
        if not windows:
            return {"state": "not_needed", "processed": 0, "total": 0, "stemCounts": []}
        import numpy as np
        import soundfile as sf

        separator = self.load_separator()
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
            start = round(window["startMs"] * sample_rate / 1000)
            end = round(window["endMs"] * sample_rate / 1000)
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


def _cuda_self_test(models: OfflineModels, *, load_primary: bool, load_separator: bool) -> dict[str, Any]:
    torch = models._assert_cuda()
    probe = torch.ones((32, 32), device="cuda", dtype=torch.float32)
    probe_value = float((probe @ probe).sum().item())
    torch.cuda.synchronize()
    if load_primary:
        models.load_primary()
    if load_separator:
        models.load_separator()
    return {
        "cuda": True,
        "gpu": torch.cuda.get_device_name(torch.cuda.current_device()),
        "probe": probe_value,
        "primaryLoaded": load_primary,
        "separatorLoaded": load_separator,
        "modelRoot": str(models.model_root),
    }


def _serve(model_root: Path) -> int:
    _lower_windows_priority()
    os.environ.setdefault("HF_HUB_OFFLINE", "1")
    os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
    models = OfflineModels(model_root)
    for raw_line in sys.stdin:
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
                _response(
                    request_id,
                    result=_cuda_self_test(
                        models,
                        load_primary=request.get("loadPrimary") is True,
                        load_separator=request.get("loadSeparator") is True,
                    ),
                )
                continue
            if command != "diarize":
                raise ValueError("unsupported sidecar command")
            _response(request_id, result=models.diarize(request))
        except Exception as error:
            traceback.print_exc(file=sys.stderr)
            _response(str(locals().get("request_id", "unknown")), error=error)
    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--server", action="store_true")
    parser.add_argument("--self-test", action="store_true")
    parser.add_argument("--load-separator", action="store_true")
    parser.add_argument("--model-root", required=True)
    args = parser.parse_args()
    if args.self_test:
        _lower_windows_priority()
        os.environ.setdefault("HF_HUB_OFFLINE", "1")
        os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
        result = _cuda_self_test(
            OfflineModels(Path(args.model_root)),
            load_primary=True,
            load_separator=args.load_separator,
        )
        sys.stdout.write(json.dumps(result, ensure_ascii=False, separators=(",", ":")) + "\n")
        return 0
    if args.server:
        return _serve(Path(args.model_root))
    parser.error("--server or --self-test is required")


if __name__ == "__main__":
    raise SystemExit(main())
