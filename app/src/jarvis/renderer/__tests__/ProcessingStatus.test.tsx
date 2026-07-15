import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { JarvisRuntimeStatus, JarvisSessionTimeline } from "../../types";
import ProcessingStatus from "../ProcessingStatus";

function timeline(overrides: Partial<JarvisSessionTimeline> = {}): JarvisSessionTimeline {
  return {
    session_id: "session-1",
    started_at: 1_000,
    ended_at: 2_000,
    status: "completed",
    processing_state: "processing",
    timeline_version: 1,
    finalized_at: 2_000,
    ready_at: null,
    tracks: [],
    gaps: [],
    chunks: [],
    segments: [],
    processing_counts: {
      pending: 0,
      leased: 0,
      retry: 0,
      blocked: 0,
      completed: 0,
      total: 0,
    },
    ...overrides,
  };
}

function runtime(overrides: Partial<JarvisRuntimeStatus> = {}): JarvisRuntimeStatus {
  return {
    observedAt: 100_000,
    capture: {
      sessionId: "session-1",
      status: "recording",
      captureMode: "dual",
      retentionMode: "speech_triggered",
      errorCode: null,
    },
    backend: { actualBackend: "cuda", cudaGpuUuid: "GPU-verified" },
    resources: {
      sampledAt: 99_000,
      state: "busy",
      reason: "external_gpu_busy",
      cudaInstalled: true,
      cudaVerified: true,
      cudaQuarantined: false,
    },
    queue: {
      pending: 4,
      running: 0,
      retry: 0,
      blocked: 0,
      total: 4,
      byStage: {
        final_transcription: { pending: 4, running: 0, retry: 0, blocked: 0, total: 4 },
      },
      backlogMinutes: 18,
      oldestJobAgeMs: 90_000,
      finalCoveragePct: 72,
      provisionalCoveragePct: null,
    },
    preview: {
      mode: "paused",
      cadenceMs: null,
      pending: 1,
      running: 0,
      pausedReason: "gpu_busy",
      executionDevice: null,
      lastError: null,
      recordingContinues: true,
    },
    disk: { state: "warning", freeBytes: 2_000_000_000, remainingDays: 3, recoveryAction: null },
    nextRecoveryAction: "wait_for_gpu",
    ...overrides,
  };
}

describe("ProcessingStatus", () => {
  it.each([
    ["recording", "正在录音"],
    ["paused", "录音已暂停"],
    ["finalizing", "正在完成录音"],
  ] as const)("shows capture state for an open %s session", (status, label) => {
    render(<ProcessingStatus timeline={timeline({ status, processing_state: "ready" })} />);

    expect(screen.getByText(label)).toBeInTheDocument();
    expect(screen.queryByText("处理完成")).not.toBeInTheDocument();
  });

  it("shows only persisted ready as complete", () => {
    render(
      <ProcessingStatus timeline={timeline({ processing_state: "ready", ready_at: 2_500 })} />
    );

    expect(screen.getByText("处理完成")).toBeInTheDocument();
  });

  it("shows pending, leased, and retry work as processing", () => {
    render(
      <ProcessingStatus
        timeline={timeline({
          processing_counts: {
            pending: 2,
            leased: 1,
            retry: 3,
            blocked: 0,
            completed: 4,
            total: 10,
          },
        })}
      />
    );

    expect(screen.getByText("正在处理")).toBeInTheDocument();
    expect(screen.getByText(/待处理 2/)).toBeInTheDocument();
    expect(screen.getByText(/处理中 1/)).toBeInTheDocument();
    expect(screen.getByText(/等待重试 3/)).toBeInTheDocument();
  });

  it("shows blocked work as an actionable error instead of complete", () => {
    render(
      <ProcessingStatus
        timeline={timeline({
          processing_state: "ready",
          ready_at: 2_500,
          processing_counts: {
            pending: 0,
            leased: 0,
            retry: 0,
            blocked: 2,
            completed: 4,
            total: 6,
          },
        })}
      />
    );

    expect(screen.getByText("处理受阻")).toBeInTheDocument();
    expect(screen.getByText(/2 个任务/)).toBeInTheDocument();
    expect(screen.getByText(/检查本地模型或存储/)).toBeInTheDocument();
    expect(screen.queryByText("处理完成")).not.toBeInTheDocument();
  });

  it.each(["recording", "paused", "finalizing"] as const)(
    "keeps the %s capture state visible while also surfacing blocked work",
    (status) => {
      render(
        <ProcessingStatus
          timeline={timeline({
            status,
            processing_state: "ready",
            ready_at: 2_500,
            processing_counts: {
              pending: 0,
              leased: 0,
              retry: 0,
              blocked: 2,
              completed: 4,
              total: 6,
            },
          })}
        />
      );

      expect(screen.getByRole("status")).toBeInTheDocument();
      expect(screen.getByRole("alert")).toHaveTextContent("2");
      expect(screen.queryByText("处理完成")).not.toBeInTheDocument();
    }
  );

  it("shows that recording continues while GPU work waits", () => {
    render(
      <ProcessingStatus timeline={timeline({ status: "recording" })} runtimeStatus={runtime()} />
    );

    expect(screen.getByText("正在监听")).toBeVisible();
    expect(screen.getByText("GPU 忙，已让路")).toBeVisible();
    expect(screen.getByText(/录音继续/)).toBeVisible();
    expect(screen.getByText(/积压 18 分钟/)).toBeVisible();
    expect(screen.getByText(/最终覆盖 72%/)).toBeVisible();
    expect(screen.getByText(/CUDA · GPU-verified/)).toBeVisible();
    expect(screen.getByText("等待 GPU")).toBeVisible();
  });

  it.each([
    [
      "important meeting",
      runtime({ capture: { ...runtime().capture, retentionMode: "continuous" } }),
      "重要会议",
    ],
    [
      "saving",
      runtime({ capture: { ...runtime().capture, status: "finalizing" } }),
      "正在保存语音",
    ],
    [
      "recovering microphone",
      runtime({
        capture: { ...runtime().capture, status: "degraded", errorCode: "MIC_DISCONNECTED" },
      }),
      "正在恢复麦克风",
    ],
    ["paused", runtime({ capture: { ...runtime().capture, status: "paused" } }), "已暂停"],
  ] as const)("renders the %s primary capture state", (_name, status, label) => {
    render(<ProcessingStatus timeline={timeline()} runtimeStatus={status} />);
    expect(screen.getByText(label)).toBeVisible();
  });

  it.each([
    ["normal", 30_000, null, /实时预览每 30 秒更新，录音继续/],
    ["degraded", 60_000, null, /实时预览已降频.*每 60 秒.*录音继续/],
    ["paused", null, "gpu_busy", /实时预览已暂停，录音继续/],
  ] as const)(
    "shows typed %s preview status separately from final job counts",
    (mode, cadenceMs, pausedReason, label) => {
      render(
        <ProcessingStatus
          timeline={timeline({
            status: "recording",
            preview_status: {
              mode,
              cadenceMs,
              pending: 1,
              running: 0,
              pausedReason,
              executionDevice: mode === "paused" ? null : "cuda",
              lastError: null,
              recordingContinues: true,
            },
          })}
        />
      );

      expect(screen.getByText(label)).toBeInTheDocument();
    }
  );

  it.each([
    ["paused", "processing"],
    ["finalizing", "processing"],
    ["completed", "ready"],
  ] as const)(
    "does not claim recording continues for a %s session in %s processing state",
    (status, processingState) => {
      render(
        <ProcessingStatus
          timeline={timeline({
            status,
            processing_state: processingState,
            ready_at: processingState === "ready" ? 2_500 : null,
            preview_status: {
              mode: "normal",
              cadenceMs: 30_000,
              pending: 1,
              running: 0,
              pausedReason: null,
              executionDevice: "cuda",
              lastError: null,
              recordingContinues: true,
            },
          })}
        />
      );

      expect(screen.queryByText(/录音继续/)).not.toBeInTheDocument();
    }
  );
});
