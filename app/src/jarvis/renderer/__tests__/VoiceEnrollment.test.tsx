import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../../i18n";
import VoiceEnrollment from "../VoiceEnrollment";

const SESSION = {
  sessionId: "opaque-session",
  expiresAt: 120_000,
  sampleRate: 24_000 as const,
  channels: 1 as const,
  format: "float32" as const,
  targetDurationSeconds: 32 as const,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

interface AudioHarnessOptions {
  contextState?: AudioContextState;
  addModuleError?: Error;
  nodeError?: Error;
  contextError?: Error;
}

function createAudioHarness({
  contextState = "running",
  addModuleError,
  nodeError,
  contextError,
}: AudioHarnessOptions = {}) {
  const track = { stop: vi.fn() };
  const stream = { getTracks: () => [track] } as unknown as MediaStream;
  const source = { connect: vi.fn(), disconnect: vi.fn() };
  const gain = { connect: vi.fn(), disconnect: vi.fn(), gain: { value: 1 } };
  const port = {
    onmessage: null as ((event: MessageEvent<ArrayBuffer>) => void) | null,
    postMessage: vi.fn(),
  };
  const node = { port, connect: vi.fn(), disconnect: vi.fn() };
  const context = {
    state: contextState,
    audioWorklet: {
      addModule: addModuleError
        ? vi.fn().mockRejectedValue(addModuleError)
        : vi.fn().mockResolvedValue(undefined),
    },
    createMediaStreamSource: vi.fn(() => source),
    createGain: vi.fn(() => gain),
    destination: {},
    resume: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  };
  const AudioContextMock = vi.fn(function AudioContextMock() {
    if (contextError) throw contextError;
    return context;
  });
  const AudioWorkletNodeMock = vi.fn(function AudioWorkletNodeMock() {
    if (nodeError) throw nodeError;
    return node;
  });
  Object.defineProperty(window, "AudioContext", { configurable: true, value: AudioContextMock });
  Object.defineProperty(globalThis, "AudioContext", {
    configurable: true,
    value: AudioContextMock,
  });
  Object.defineProperty(window, "AudioWorkletNode", {
    configurable: true,
    value: AudioWorkletNodeMock,
  });
  Object.defineProperty(globalThis, "AudioWorkletNode", {
    configurable: true,
    value: AudioWorkletNodeMock,
  });
  return {
    track,
    stream,
    source,
    gain,
    port,
    node,
    context,
    AudioContextMock,
    AudioWorkletNodeMock,
  };
}

beforeAll(async () => {
  await i18n.changeLanguage("zh-CN");
});

beforeEach(() => {
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: vi.fn(() => "blob:enrollment-worklet"),
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    value: vi.fn(),
  });
});

afterEach(() => {
  vi.useRealTimers();
});

function installElectronApi(overrides = {}) {
  const jarvis = {
    getVoiceEnrollmentStatus: vi.fn().mockResolvedValue({
      enrolled: false,
      modelId: "3dspeaker-campplus-voxceleb-16k-v1",
      acceptedSpeechMs: 0,
      windowCount: 0,
      selfConsistency: null,
      updatedAt: null,
    }),
    beginVoiceEnrollment: vi.fn().mockResolvedValue(SESSION),
    completeVoiceEnrollment: vi.fn().mockResolvedValue({
      status: "accepted",
      modelId: "3dspeaker-campplus-voxceleb-16k-v1",
      acceptedSpeechMs: 30_000,
      windowCount: 3,
      selfConsistency: 0.99,
    }),
    cancelVoiceEnrollment: vi.fn().mockResolvedValue({ cancelled: true }),
    ...overrides,
  };
  Object.defineProperty(window, "electronAPI", {
    configurable: true,
    value: { jarvis },
  });
  return jarvis;
}

function installMedia(stream: MediaStream) {
  const getUserMedia = vi.fn().mockResolvedValue(stream);
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia },
  });
  return getUserMedia;
}

describe("VoiceEnrollment", () => {
  it("loads and displays a persistent enrolled self-voice status", async () => {
    installElectronApi({
      getVoiceEnrollmentStatus: vi.fn().mockResolvedValue({
        enrolled: true,
        modelId: "3dspeaker-campplus-voxceleb-16k-v1",
        acceptedSpeechMs: 30_000,
        windowCount: 3,
        selfConsistency: 0.99,
        updatedAt: 1_783_733_400_000,
      }),
    });

    render(<VoiceEnrollment />);

    expect(await screen.findByText("已绑定")).toBeInTheDocument();
    expect(screen.getByText(/1783733400000/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重新校准" })).toBeEnabled();
  });

  it("shows an explicit local 32-second guided calibration flow with meter values", () => {
    render(<VoiceEnrollment />);

    expect(screen.getByText("声纹校准")).toBeInTheDocument();
    expect(screen.getByText("请独自朗读，避免其他人同时说话")).toBeInTheDocument();
    expect(screen.getByText("00:32")).toBeInTheDocument();
    const meter = screen.getByRole("meter", { name: "音频电平" });
    expect(meter).toHaveAttribute("min", "0");
    expect(meter).toHaveAttribute("max", "1");
    expect(meter).toHaveAttribute("value", "0");
    expect(screen.getByRole("button", { name: "开始校准" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "取消" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "保存声纹" })).toBeDisabled();
  });

  it("stops the acquired stream and closes context when addModule fails", async () => {
    const audio = createAudioHarness({ addModuleError: new Error("module failed") });
    const getUserMedia = installMedia(audio.stream);
    const jarvis = installElectronApi();
    render(<VoiceEnrollment />);

    fireEvent.click(screen.getByRole("button", { name: "开始校准" }));

    expect(screen.getByRole("button", { name: "开始校准" })).toBeDisabled();
    await screen.findByRole("alert");
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(audio.track.stop).toHaveBeenCalledTimes(1);
    expect(audio.context.close).toHaveBeenCalledTimes(1);
    expect(jarvis.cancelVoiceEnrollment).toHaveBeenCalledWith(SESSION.sessionId);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:enrollment-worklet");
  });

  it.each([
    ["AudioContext", { contextError: new Error("context failed") }],
    ["AudioWorkletNode", { nodeError: new Error("node failed") }],
  ])("cleans up after %s setup failure", async (_label, options) => {
    const audio = createAudioHarness(options);
    installMedia(audio.stream);
    const jarvis = installElectronApi();
    render(<VoiceEnrollment />);

    fireEvent.click(screen.getByRole("button", { name: "开始校准" }));

    await screen.findByRole("alert");
    expect(audio.track.stop).toHaveBeenCalledTimes(1);
    if (!("contextError" in options)) expect(audio.context.close).toHaveBeenCalledTimes(1);
    expect(jarvis.cancelVoiceEnrollment).toHaveBeenCalledWith(SESSION.sessionId);
  });

  it("prevents double start while the enrollment session is being allocated", async () => {
    const pending = deferred<typeof SESSION>();
    const audio = createAudioHarness();
    const getUserMedia = installMedia(audio.stream);
    const jarvis = installElectronApi({ beginVoiceEnrollment: vi.fn(() => pending.promise) });
    render(<VoiceEnrollment />);
    const start = screen.getByRole("button", { name: "开始校准" });

    fireEvent.click(start);
    fireEvent.click(start);

    expect(jarvis.beginVoiceEnrollment).toHaveBeenCalledTimes(1);
    expect(getUserMedia).not.toHaveBeenCalled();
    pending.resolve(SESSION);
    await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(1));
  });

  it("announces pending setup with aria-busy state", async () => {
    const pending = deferred<typeof SESSION>();
    const audio = createAudioHarness();
    installMedia(audio.stream);
    installElectronApi({ beginVoiceEnrollment: vi.fn(() => pending.promise) });
    render(<VoiceEnrollment />);

    fireEvent.click(screen.getByRole("button", { name: "开始校准" }));

    expect(screen.getByRole("region", { name: "声纹校准" })).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("status")).toHaveTextContent("正在准备声纹校准");
    pending.resolve(SESSION);
    await waitFor(() => expect(audio.context.audioWorklet.addModule).toHaveBeenCalled());
  });

  it("resumes a suspended context before recording and cancels cleanly", async () => {
    const audio = createAudioHarness({ contextState: "suspended" });
    installMedia(audio.stream);
    const jarvis = installElectronApi();
    render(<VoiceEnrollment />);

    fireEvent.click(screen.getByRole("button", { name: "开始校准" }));
    const cancel = await screen.findByRole("button", { name: "取消" });
    expect(cancel).toBeEnabled();
    expect(screen.getByText("第 1 段，共 3 段")).toBeInTheDocument();
    expect(audio.context.resume).toHaveBeenCalledTimes(1);
    expect(audio.context.audioWorklet.addModule).toHaveBeenCalledTimes(1);

    fireEvent.click(cancel);
    await waitFor(() => expect(audio.track.stop).toHaveBeenCalledTimes(1));
    expect(audio.context.close).toHaveBeenCalledTimes(1);
    expect(jarvis.cancelVoiceEnrollment).toHaveBeenCalledWith(SESSION.sessionId);
  });

  it("stops a full guided capture and saves three ten-second 24 kHz windows", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const audio = createAudioHarness();
    installMedia(audio.stream);
    const jarvis = installElectronApi();
    render(<VoiceEnrollment />);

    fireEvent.click(screen.getByRole("button", { name: "开始校准" }));
    await act(async () => Promise.resolve());
    expect(audio.port.onmessage).toBeTypeOf("function");
    act(() => {
      audio.port.onmessage?.({
        data: new Float32Array(24_000 * 32).fill(0.2).buffer,
      } as MessageEvent<ArrayBuffer>);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(32_100);
    });

    const save = screen.getByRole("button", { name: "保存声纹" });
    expect(save).toBeEnabled();
    fireEvent.click(save);
    await act(async () => Promise.resolve());

    expect(jarvis.completeVoiceEnrollment).toHaveBeenCalledTimes(1);
    const [sessionId, payload] = jarvis.completeVoiceEnrollment.mock.calls[0];
    expect(sessionId).toBe(SESSION.sessionId);
    expect(payload).toMatchObject({
      sampleRate: 24_000,
      channels: 1,
      format: "float32",
      recordedSampleCount: 24_000 * 32,
    });
    expect(payload.windows).toHaveLength(3);
    expect(payload.windows.map((window) => window.samples.length)).toEqual([
      24_000 * 10,
      24_000 * 10,
      24_000 * 10,
    ]);
    expect(audio.track.stop).toHaveBeenCalledTimes(1);
    expect(audio.context.close).toHaveBeenCalledTimes(1);
    expect(jarvis.cancelVoiceEnrollment).not.toHaveBeenCalled();
  });

  it("zeroes failed save PCM, cancels the token, and permits a fresh start", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const audio = createAudioHarness();
    const getUserMedia = installMedia(audio.stream);
    const jarvis = installElectronApi({
      completeVoiceEnrollment: vi.fn().mockRejectedValue(new Error("embedding failed")),
    });
    render(<VoiceEnrollment />);

    fireEvent.click(screen.getByRole("button", { name: "开始校准" }));
    await act(async () => Promise.resolve());
    act(() => {
      audio.port.onmessage?.({
        data: new Float32Array(24_000 * 32).fill(0.2).buffer,
      } as MessageEvent<ArrayBuffer>);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(32_100);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "保存声纹" }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByRole("alert")).toBeInTheDocument();
    const [, sentPayload] = jarvis.completeVoiceEnrollment.mock.calls[0];
    expect(
      sentPayload.windows.every((entry: { samples: Float32Array }) =>
        entry.samples.every((sample) => sample === 0)
      )
    ).toBe(true);
    expect(jarvis.cancelVoiceEnrollment).toHaveBeenCalledWith(SESSION.sessionId);
    const restart = screen.getByRole("button", { name: "开始校准" });
    expect(restart).toBeEnabled();

    fireEvent.click(restart);
    await act(async () => Promise.resolve());
    expect(jarvis.beginVoiceEnrollment).toHaveBeenCalledTimes(2);
    expect(getUserMedia).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["insufficient_speech", "声纹样本不足"],
    ["inconsistent_samples", "三段声音不一致"],
    ["model_error", "声纹模型暂时不可用"],
  ])("renders the structured %s outcome without claiming success", async (status, message) => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const audio = createAudioHarness();
    installMedia(audio.stream);
    installElectronApi({
      completeVoiceEnrollment: vi.fn().mockResolvedValue({
        status,
        modelId: "3dspeaker-campplus-voxceleb-16k-v1",
        acceptedSpeechMs: status === "insufficient_speech" ? 20_000 : 30_000,
        windowCount: status === "insufficient_speech" ? 2 : 3,
        selfConsistency: status === "inconsistent_samples" ? 0.5 : null,
      }),
    });
    render(<VoiceEnrollment />);
    fireEvent.click(screen.getByRole("button", { name: "开始校准" }));
    await act(async () => Promise.resolve());
    act(() => {
      audio.port.onmessage?.({
        data: new Float32Array(24_000 * 32).fill(0.2).buffer,
      } as MessageEvent<ArrayBuffer>);
    });
    await act(async () => vi.advanceTimersByTimeAsync(32_100));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "保存声纹" }));
      await Promise.resolve();
    });
    expect(screen.getByRole("alert")).toHaveTextContent(message);
    expect(screen.queryByText("你的本地声纹已保存。")).not.toBeInTheDocument();
  });
});
