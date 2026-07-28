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
import subprocess
import sys
import traceback
from typing import Any

MAX_BOUNDARY_DRIFT_MS = 2


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


def _normalize_annotation_turn(segment: Any, speaker: Any, duration_ms: int) -> dict[str, Any] | None:
    if segment.end <= segment.start or duration_ms <= 0:
        return None
    start_ms = max(0, round(segment.start * 1000))
    end_ms = min(duration_ms, round(segment.end * 1000))
    if start_ms > duration_ms:
        if start_ms - duration_ms > MAX_BOUNDARY_DRIFT_MS:
            return None
        start_ms = duration_ms
    if end_ms < start_ms:
        if start_ms - end_ms > MAX_BOUNDARY_DRIFT_MS:
            return None
        boundary_ms = min(start_ms, end_ms)
        start_ms = max(0, boundary_ms)
        end_ms = min(duration_ms, start_ms + 1)
    # Positive sub-millisecond segments can collapse after independent
    # rounding. Keep a minimal 1 ms interval so one harmless boundary does not
    # invalidate a multi-hour diarization result.
    if end_ms <= start_ms:
        if start_ms >= duration_ms:
            end_ms = duration_ms
            start_ms = max(0, end_ms - 1)
        else:
            end_ms = min(duration_ms, start_ms + 1)
    if end_ms <= start_ms:
        return None
    return {
        "speaker": str(speaker),
        "startMs": start_ms,
        "endMs": end_ms,
    }


class SeparatorWorker:
    def __init__(self, model_root: Path) -> None:
        self.model_root = model_root
        self.process: subprocess.Popen[str] | None = None
        self.sequence = 0

    def _start(self) -> subprocess.Popen[str]:
        if self.process is not None and self.process.poll() is None:
            return self.process
        runtime = self.model_root / "runtime"
        python = runtime / "python.exe"
        script = runtime / "jarvis_overlap_separator.py"
        if not python.is_file() or not script.is_file():
            error = FileNotFoundError("isolated overlap runtime is incomplete")
            error.code = "AI_MODEL_PACK_INCOMPLETE"
            raise error
        system_root = os.environ.get("SystemRoot") or os.environ.get("WINDIR") or ""
        path_entries = [runtime, runtime / "Library" / "bin"]
        if system_root:
            path_entries.append(Path(system_root) / "System32")
        env = {
            "SystemRoot": system_root,
            "WINDIR": os.environ.get("WINDIR", system_root),
            "PATH": ";".join(str(entry) for entry in path_entries),
            "PYTHONNOUSERSITE": "1",
            "PYTHONUTF8": "1",
            "HF_HUB_OFFLINE": "1",
            "TRANSFORMERS_OFFLINE": "1",
            "HF_HOME": str(self.model_root / "cache"),
            "TORCH_HOME": str(self.model_root / "cache"),
            "JARVIS_AI_MODEL_ROOT": str(self.model_root),
        }
        if os.environ.get("CUDA_VISIBLE_DEVICES"):
            env["CUDA_VISIBLE_DEVICES"] = os.environ["CUDA_VISIBLE_DEVICES"]
        creation_flags = 0x08000000 if os.name == "nt" else 0
        self.process = subprocess.Popen(
            [str(python), "-I", "-u", str(script), "--server", "--model-root", str(self.model_root)],
            cwd=self.model_root,
            env=env,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=None,
            text=True,
            encoding="utf-8",
            creationflags=creation_flags,
        )
        return self.process

    def request(self, command: str, payload: dict[str, Any] | None = None) -> Any:
        process = self._start()
        if process.stdin is None or process.stdout is None:
            raise RuntimeError("overlap separator pipes are unavailable")
        self.sequence += 1
        request_id = f"separator_{self.sequence}"
        request = {"id": request_id, "command": command, **(payload or {})}
        process.stdin.write(json.dumps(request, ensure_ascii=False, separators=(",", ":")) + "\n")
        process.stdin.flush()
        raw = process.stdout.readline()
        if not raw:
            error = RuntimeError(f"overlap separator exited ({process.poll()})")
            error.code = "OVERLAP_SEPARATOR_EXITED"
            raise error
        try:
            response = json.loads(raw)
        except json.JSONDecodeError as cause:
            error = RuntimeError("overlap separator emitted non-protocol output")
            error.code = "OVERLAP_SEPARATOR_PROTOCOL_ERROR"
            raise error from cause
        if response.get("id") != request_id:
            error = RuntimeError("overlap separator protocol mismatch")
            error.code = "OVERLAP_SEPARATOR_PROTOCOL_ERROR"
            raise error
        if response.get("ok") is not True:
            details = response.get("error") or {}
            error = RuntimeError(str(details.get("message") or "overlap separator failed"))
            error.code = str(details.get("code") or "OVERLAP_SEPARATOR_FAILED")
            raise error
        return response.get("result")

    def close(self) -> None:
        process = self.process
        self.process = None
        if process is None:
            return
        try:
            if process.poll() is None and process.stdin is not None:
                self.sequence += 1
                process.stdin.write(
                    json.dumps({"id": f"shutdown_{self.sequence}", "command": "shutdown"}) + "\n"
                )
                process.stdin.flush()
                process.wait(timeout=5)
        except Exception:
            process.kill()


class OfflineModels:
    def __init__(self, model_root: Path) -> None:
        self.model_root = model_root.resolve()
        self.primary = None
        self.separator = SeparatorWorker(self.model_root)

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
        self._assert_cuda()
        self.separator.request("self_test", {"loadModel": True})
        return self.separator

    def close(self) -> None:
        self.separator.close()

    def diarize(self, request: dict[str, Any]) -> dict[str, Any]:
        release_separator = request.get("releaseOverlapSeparatorAfterRequest") is True
        try:
            return self._diarize(request)
        finally:
            if release_separator:
                self.separator.close()

    def _diarize(self, request: dict[str, Any]) -> dict[str, Any]:
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
            turn
            for segment, _, speaker in annotation.itertracks(yield_label=True)
            if (turn := _normalize_annotation_turn(segment, speaker, duration_ms)) is not None
        ]
        turns.sort(key=lambda turn: (turn["startMs"], turn["endMs"], turn["speaker"]))
        padding_ms = max(0, min(5000, int(request.get("overlapPaddingMs", 250))))
        windows = _overlap_windows(turns, padding_ms, duration_ms)
        enable_overlap_separation = request.get("enableOverlapSeparation") is not False
        separation = (
            self._separate_overlap_windows(audio_path, windows)
            if enable_overlap_separation
            else {
                "state": "not_needed",
                "processed": 0,
                "total": len(windows),
                "stemCounts": [],
                "reason": "policy_disabled",
            }
        )
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
        separator = self.load_separator()
        return separator.request("separate", {"audioPath": str(audio_path), "windows": windows})


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
    try:
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
                _response(request_id, error=error)
    finally:
        models.close()
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
        models = OfflineModels(Path(args.model_root))
        try:
            result = _cuda_self_test(
                models,
                load_primary=True,
                load_separator=args.load_separator,
            )
        finally:
            models.close()
        sys.stdout.write(json.dumps(result, ensure_ascii=False, separators=(",", ":")) + "\n")
        return 0
    if args.server:
        return _serve(Path(args.model_root))
    parser.error("--server or --self-test is required")


if __name__ == "__main__":
    raise SystemExit(main())
