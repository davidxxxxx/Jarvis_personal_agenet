/**
 * Windows System Audio Helper
 *
 * Captures system audio for meeting transcription via WASAPI process
 * loopback (VAD\Process_Loopback). It supports both the existing EXCLUDE
 * process-tree safety mix and an INCLUDE process-tree mode for one active
 * application. Application capture and session watch require Windows build
 * 20348 or newer.
 *
 * Commands:
 *   windows-system-audio-helper.exe probe
 *     Prints a single JSON capability object to stdout and exits.
 *   windows-system-audio-helper.exe start
 *     [--exclude-pid N | --include-pid N] [--sample-rate N]
 *     Streams raw PCM (mono, 16-bit signed little-endian, --sample-rate Hz,
 *     default 24000) to stdout. Emits line-delimited JSON events to stderr:
 *       {"type":"start"} once capture is running,
 *       {"type":"warning","code":...,"message":...} for recoverable issues,
 *       {"type":"error","code":...,"message":...} before exiting with code 2.
 *     Exits when stdin closes (parent death), on Ctrl+C/SIGTERM, or on a
 *     fatal capture error. Injects silence while no application renders
 *     audio so the output timeline stays continuous.
 *   windows-system-audio-helper.exe watch-sessions [--exclude-pid N]
 *     Emits line-delimited JSON containing only PID, state and peak level.
 *     It never reads or emits executable paths, command lines, or window
 *     titles.
 *
 * Compile with: cl /O2 windows-system-audio-helper.c /Fe:windows-system-audio-helper.exe ole32.lib mmdevapi.lib
 * Or with MinGW: gcc -O2 windows-system-audio-helper.c -o windows-system-audio-helper.exe -lole32 -lmmdevapi
 */

#define WIN32_LEAN_AND_MEAN
#define COBJMACROS
#define CINTERFACE

#include <windows.h>
#include <initguid.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <audiopolicy.h>
#include <endpointvolume.h>
#include <fcntl.h>
#include <io.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

DEFINE_GUID(HELPER_CLSID_MMDeviceEnumerator,
    0xbcde0395, 0xe52f, 0x467c, 0x8e, 0x3d, 0xc4, 0x57, 0x92, 0x91, 0x69, 0x2e);
DEFINE_GUID(HELPER_IID_IMMDeviceEnumerator,
    0xa95664d2, 0x9614, 0x4f35, 0xa7, 0x46, 0xde, 0x8d, 0xb6, 0x36, 0x17, 0xe6);
DEFINE_GUID(HELPER_IID_IAudioSessionManager2,
    0x77aa99a0, 0x1bd6, 0x484f, 0x8b, 0xc7, 0x2c, 0x65, 0x4c, 0x9a, 0x9b, 0x6f);
DEFINE_GUID(HELPER_IID_IAudioSessionControl2,
    0xbfb7ff88, 0x7239, 0x4fc9, 0x8f, 0xa2, 0x07, 0xc9, 0x50, 0xbe, 0x9c, 0x6d);

#if defined(__has_include)
#if __has_include(<audioclientactivationparams.h>)
#include <audioclientactivationparams.h>
#define HAVE_ACTIVATION_PARAMS_HEADER 1
#endif
#endif

#ifndef HAVE_ACTIVATION_PARAMS_HEADER
#define VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK L"VAD\\Process_Loopback"

typedef enum {
    PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE = 0,
    PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE = 1
} PROCESS_LOOPBACK_MODE;

typedef enum {
    AUDIOCLIENT_ACTIVATION_TYPE_DEFAULT = 0,
    AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK = 1
} AUDIOCLIENT_ACTIVATION_TYPE;

typedef struct {
    DWORD TargetProcessId;
    PROCESS_LOOPBACK_MODE ProcessLoopbackMode;
} AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS;

typedef struct {
    AUDIOCLIENT_ACTIVATION_TYPE ActivationType;
    union {
        AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS ProcessLoopbackParams;
    } DUMMYUNIONNAME;
} AUDIOCLIENT_ACTIVATION_PARAMS;
#endif

#ifndef AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM
#define AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM 0x80000000
#endif
#ifndef AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY
#define AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY 0x08000000
#endif

DEFINE_GUID(HELPER_IID_IAgileObject,
    0x94ea2b94, 0xe9cc, 0x49e0, 0xc0, 0xff, 0xee, 0x64, 0xca, 0x8f, 0x5b, 0x90);

#define DEFAULT_SAMPLE_RATE 24000
#define MIN_APPLICATION_CAPTURE_BUILD 20348
#define CAPTURE_CHANNELS 2
#define BYTES_PER_SAMPLE 2
#define ACTIVATION_TIMEOUT_MS 4000
#define CAPTURE_WAIT_TIMEOUT_MS 100
/* Fill silence once the emitted timeline lags the wall clock by this much. */
#define SILENCE_GAP_THRESHOLD_MS 100
/* Beyond this the clock jumped (system sleep/resume); rebase instead of
 * flooding the pipe with hours of silence. */
#define SILENCE_GAP_MAX_MS 5000
#define SILENCE_FILL_CHUNK_FRAMES 2400
#define BUFFER_DURATION_HNS 200000 /* 20 ms, matches the Microsoft sample */
#define SESSION_WATCH_INTERVAL_MS 500
#define SESSION_PEAK_THRESHOLD 0.0005f
#define MAX_ACTIVE_SESSION_PROCESSES 512

static volatile LONG g_running = TRUE;

/* ========================================================================
 * JSON events on stderr (all message content is static or numeric, so no
 * string escaping is required)
 * ======================================================================== */

static void emit_event(const char *type, const char *code, const char *format, ...)
{
    fprintf(stderr, "{\"type\":\"%s\"", type);
    if (code) {
        fprintf(stderr, ",\"code\":\"%s\"", code);
    }
    if (format) {
        va_list args;
        va_start(args, format);
        fputs(",\"message\":\"", stderr);
        vfprintf(stderr, format, args);
        fputs("\"", stderr);
        va_end(args);
    }
    fputs("}\n", stderr);
    fflush(stderr);
}

static DWORD get_windows_build_number(void)
{
    typedef LONG(WINAPI * RtlGetVersionFn)(OSVERSIONINFOW *);
    HMODULE ntdll = GetModuleHandleW(L"ntdll.dll");
    RtlGetVersionFn rtlGetVersion;
    OSVERSIONINFOW version;

    if (!ntdll) {
        return 0;
    }
    rtlGetVersion = (RtlGetVersionFn)GetProcAddress(ntdll, "RtlGetVersion");
    if (!rtlGetVersion) {
        return 0;
    }
    ZeroMemory(&version, sizeof(version));
    version.dwOSVersionInfoSize = sizeof(version);
    if (rtlGetVersion(&version) != 0) {
        return 0;
    }
    return version.dwBuildNumber;
}

static void emit_probe_result(BOOL ok, const char *error, HRESULT hr, DWORD windowsBuild)
{
    BOOL supportsApplications = windowsBuild >= MIN_APPLICATION_CAPTURE_BUILD;
    if (ok) {
        printf("{\"ok\":true,\"supportsSystemAudio\":true,\"supportsNativeCapture\":true,"
               "\"supportsApplicationCapture\":%s,\"supportsSessionWatch\":%s,"
               "\"minimumWindowsBuild\":%lu,\"windowsBuild\":%lu,"
               "\"source\":\"wasapi-process-loopback\"}\n",
               supportsApplications ? "true" : "false",
               supportsApplications ? "true" : "false",
               (unsigned long)MIN_APPLICATION_CAPTURE_BUILD,
               (unsigned long)windowsBuild);
    } else {
        printf("{\"ok\":false,\"supportsSystemAudio\":false,\"supportsNativeCapture\":false,"
               "\"supportsApplicationCapture\":false,\"supportsSessionWatch\":false,"
               "\"minimumWindowsBuild\":%lu,\"windowsBuild\":%lu,"
               "\"source\":\"wasapi-process-loopback\",\"error\":\"%s (hr=0x%08lx)\"}\n",
               (unsigned long)MIN_APPLICATION_CAPTURE_BUILD,
               (unsigned long)windowsBuild, error, (unsigned long)hr);
    }
    fflush(stdout);
}

static void emit_capture_start(PROCESS_LOOPBACK_MODE loopbackMode, DWORD targetPid)
{
    fprintf(stderr,
            "{\"type\":\"start\",\"captureMode\":\"%s\",\"targetPid\":%lu}\n",
            loopbackMode == PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE
                ? "include-process-tree"
                : "exclude-process-tree",
            (unsigned long)targetPid);
    fflush(stderr);
}

static void emit_hresult_error(const char *code, const char *message, HRESULT hr)
{
    fprintf(stderr,
            "{\"type\":\"error\",\"code\":\"%s\",\"nativeCode\":\"0x%08lx\","
            "\"message\":\"%s (hr=0x%08lx)\"}\n",
            code, (unsigned long)hr, message, (unsigned long)hr);
    fflush(stderr);
}

/* ========================================================================
 * IActivateAudioInterfaceCompletionHandler implementation
 * ======================================================================== */

/* Heap-allocated and refcounted: ActivateAudioInterfaceAsync holds its own
 * reference, so a completion that arrives after our wait timed out still
 * finds a live object and a valid event handle. */
typedef struct {
    IActivateAudioInterfaceCompletionHandlerVtbl *lpVtbl;
    LONG refCount;
    HANDLE completedEvent;
} CompletionHandler;

static HRESULT STDMETHODCALLTYPE CH_QueryInterface(
    IActivateAudioInterfaceCompletionHandler *This, REFIID riid, void **ppvObject)
{
    if (IsEqualIID(riid, &IID_IUnknown) ||
        IsEqualIID(riid, &HELPER_IID_IAgileObject) ||
        IsEqualIID(riid, &IID_IActivateAudioInterfaceCompletionHandler)) {
        *ppvObject = This;
        This->lpVtbl->AddRef(This);
        return S_OK;
    }
    *ppvObject = NULL;
    return E_NOINTERFACE;
}

static ULONG STDMETHODCALLTYPE CH_AddRef(IActivateAudioInterfaceCompletionHandler *This)
{
    CompletionHandler *self = (CompletionHandler *)This;
    return InterlockedIncrement(&self->refCount);
}

static ULONG STDMETHODCALLTYPE CH_Release(IActivateAudioInterfaceCompletionHandler *This)
{
    CompletionHandler *self = (CompletionHandler *)This;
    LONG count = InterlockedDecrement(&self->refCount);
    if (count == 0) {
        CloseHandle(self->completedEvent);
        free(self);
    }
    return count;
}

static HRESULT STDMETHODCALLTYPE CH_ActivateCompleted(
    IActivateAudioInterfaceCompletionHandler *This,
    IActivateAudioInterfaceAsyncOperation *activateOperation)
{
    CompletionHandler *self = (CompletionHandler *)This;
    (void)activateOperation;
    SetEvent(self->completedEvent);
    return S_OK;
}

static IActivateAudioInterfaceCompletionHandlerVtbl g_completionHandlerVtbl = {
    CH_QueryInterface,
    CH_AddRef,
    CH_Release,
    CH_ActivateCompleted,
};

static CompletionHandler *create_completion_handler(void)
{
    CompletionHandler *handler = (CompletionHandler *)calloc(1, sizeof(CompletionHandler));
    if (!handler) {
        return NULL;
    }

    handler->lpVtbl = &g_completionHandlerVtbl;
    handler->refCount = 1;
    handler->completedEvent = CreateEventW(NULL, TRUE, FALSE, NULL);
    if (!handler->completedEvent) {
        free(handler);
        return NULL;
    }
    return handler;
}

/* ========================================================================
 * Process-loopback activation
 * ======================================================================== */

static HRESULT activate_process_loopback(
    DWORD targetPid, PROCESS_LOOPBACK_MODE loopbackMode, UINT32 sampleRate,
    IAudioClient **outClient, const char **outErrorCode)
{
    AUDIOCLIENT_ACTIVATION_PARAMS activationParams;
    PROPVARIANT activateParams;
    CompletionHandler *handler;
    IActivateAudioInterfaceAsyncOperation *asyncOp = NULL;
    IUnknown *audioClientUnknown = NULL;
    IAudioClient *audioClient = NULL;
    WAVEFORMATEX format;
    HRESULT hr;
    HRESULT activateResult = E_FAIL;

    *outClient = NULL;
    *outErrorCode = "activation_failed";

    ZeroMemory(&activationParams, sizeof(activationParams));
    activationParams.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
    activationParams.ProcessLoopbackParams.TargetProcessId = targetPid;
    activationParams.ProcessLoopbackParams.ProcessLoopbackMode = loopbackMode;

    PropVariantInit(&activateParams);
    activateParams.vt = VT_BLOB;
    activateParams.blob.cbSize = sizeof(activationParams);
    activateParams.blob.pBlobData = (BYTE *)&activationParams;

    handler = create_completion_handler();
    if (!handler) {
        return E_OUTOFMEMORY;
    }

    hr = ActivateAudioInterfaceAsync(
        VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
        &IID_IAudioClient,
        &activateParams,
        (IActivateAudioInterfaceCompletionHandler *)handler,
        &asyncOp);

    if (SUCCEEDED(hr)) {
        /* The completion callback can fail to arrive in the field (Chromium
         * bounds this same wait), so never wait unbounded. */
        if (WaitForSingleObject(handler->completedEvent, ACTIVATION_TIMEOUT_MS) != WAIT_OBJECT_0) {
            hr = HRESULT_FROM_WIN32(WAIT_TIMEOUT);
            *outErrorCode = "activation_timeout";
        } else {
            hr = IActivateAudioInterfaceAsyncOperation_GetActivateResult(
                asyncOp, &activateResult, &audioClientUnknown);
            if (SUCCEEDED(hr)) {
                hr = activateResult;
            }
        }
    }

    if (asyncOp) {
        IActivateAudioInterfaceAsyncOperation_Release(asyncOp);
    }
    CH_Release((IActivateAudioInterfaceCompletionHandler *)handler);

    if (FAILED(hr)) {
        if (audioClientUnknown) {
            IUnknown_Release(audioClientUnknown);
        }
        return hr;
    }

    hr = IUnknown_QueryInterface(audioClientUnknown, &IID_IAudioClient, (void **)&audioClient);
    IUnknown_Release(audioClientUnknown);
    if (FAILED(hr)) {
        return hr;
    }

    /* The process-loopback virtual device has no mix format; we pick the
     * format and AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM makes the engine
     * resample into it. Stereo is the field-proven choice; we downmix. */
    ZeroMemory(&format, sizeof(format));
    format.wFormatTag = WAVE_FORMAT_PCM;
    format.nChannels = CAPTURE_CHANNELS;
    format.nSamplesPerSec = sampleRate;
    format.wBitsPerSample = BYTES_PER_SAMPLE * 8;
    format.nBlockAlign = CAPTURE_CHANNELS * BYTES_PER_SAMPLE;
    format.nAvgBytesPerSec = sampleRate * format.nBlockAlign;

    hr = IAudioClient_Initialize(
        audioClient,
        AUDCLNT_SHAREMODE_SHARED,
        AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK |
            AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
        BUFFER_DURATION_HNS,
        0,
        &format,
        NULL);

    if (FAILED(hr)) {
        IAudioClient_Release(audioClient);
        *outErrorCode = "initialize_failed";
        return hr;
    }

    *outClient = audioClient;
    return S_OK;
}

/* ========================================================================
 * Capture loop
 * ======================================================================== */

static BOOL write_pcm(const short *samples, size_t sampleCount)
{
    if (sampleCount == 0) {
        return TRUE;
    }
    if (fwrite(samples, sizeof(short), sampleCount, stdout) != sampleCount) {
        return FALSE;
    }
    return TRUE;
}

static BOOL write_silence(size_t frames)
{
    static const short zeros[SILENCE_FILL_CHUNK_FRAMES] = {0};

    while (frames > 0) {
        size_t batch = frames < SILENCE_FILL_CHUNK_FRAMES ? frames : SILENCE_FILL_CHUNK_FRAMES;
        if (!write_pcm(zeros, batch)) {
            return FALSE;
        }
        frames -= batch;
    }
    return TRUE;
}

static int run_capture(DWORD targetPid, PROCESS_LOOPBACK_MODE loopbackMode, UINT32 sampleRate)
{
    IAudioClient *audioClient = NULL;
    IAudioCaptureClient *captureClient = NULL;
    HANDLE samplesReadyEvent = NULL;
    short *monoBuffer = NULL;
    size_t monoBufferFrames = 0;
    LARGE_INTEGER qpcFrequency;
    LARGE_INTEGER captureStart;
    UINT64 emittedFrames = 0;
    const char *errorCode = NULL;
    HRESULT hr;
    int exitCode = 0;

    hr = activate_process_loopback(targetPid, loopbackMode, sampleRate, &audioClient, &errorCode);
    if (FAILED(hr)) {
        emit_hresult_error(errorCode, "Process loopback activation failed", hr);
        return 2;
    }

    samplesReadyEvent = CreateEventW(NULL, FALSE, FALSE, NULL);
    if (!samplesReadyEvent) {
        hr = HRESULT_FROM_WIN32(GetLastError());
    } else {
        hr = IAudioClient_SetEventHandle(audioClient, samplesReadyEvent);
    }
    if (FAILED(hr)) {
        emit_hresult_error("initialize_failed", "Failed to attach capture event", hr);
        IAudioClient_Release(audioClient);
        if (samplesReadyEvent) CloseHandle(samplesReadyEvent);
        return 2;
    }

    hr = IAudioClient_GetService(audioClient, &IID_IAudioCaptureClient, (void **)&captureClient);
    if (FAILED(hr)) {
        emit_hresult_error("initialize_failed", "Failed to get capture client", hr);
        IAudioClient_Release(audioClient);
        CloseHandle(samplesReadyEvent);
        return 2;
    }

    hr = IAudioClient_Start(audioClient);
    if (FAILED(hr)) {
        emit_hresult_error("start_failed", "Failed to start capture", hr);
        IAudioCaptureClient_Release(captureClient);
        IAudioClient_Release(audioClient);
        CloseHandle(samplesReadyEvent);
        return 2;
    }

    QueryPerformanceFrequency(&qpcFrequency);
    QueryPerformanceCounter(&captureStart);
    emit_capture_start(loopbackMode, targetPid);

    while (InterlockedCompareExchange(&g_running, TRUE, TRUE)) {
        UINT32 packetFrames = 0;
        LARGE_INTEGER now;
        UINT64 targetFrames;
        UINT64 drainedFrames = 0;

        WaitForSingleObject(samplesReadyEvent, CAPTURE_WAIT_TIMEOUT_MS);

        /* The virtual device does no buffering of its own, so drain every
         * available packet per wakeup. */
        for (;;) {
            BYTE *data = NULL;
            UINT32 frames = 0;
            DWORD flags = 0;

            hr = IAudioCaptureClient_GetNextPacketSize(captureClient, &packetFrames);
            if (FAILED(hr) || packetFrames == 0) {
                break;
            }

            hr = IAudioCaptureClient_GetBuffer(captureClient, &data, &frames, &flags, NULL, NULL);
            if (FAILED(hr)) {
                break;
            }

            if (frames > 0) {
                if (frames > monoBufferFrames) {
                    short *grown = (short *)realloc(monoBuffer, frames * sizeof(short));
                    if (!grown) {
                        IAudioCaptureClient_ReleaseBuffer(captureClient, frames);
                        hr = E_OUTOFMEMORY;
                        break;
                    }
                    monoBuffer = grown;
                    monoBufferFrames = frames;
                }

                if (flags & AUDCLNT_BUFFERFLAGS_SILENT) {
                    memset(monoBuffer, 0, frames * sizeof(short));
                } else {
                    const short *stereo = (const short *)data;
                    UINT32 i;
                    for (i = 0; i < frames; i++) {
                        monoBuffer[i] = (short)(((int)stereo[i * 2] + (int)stereo[i * 2 + 1]) / 2);
                    }
                }

                if (!write_pcm(monoBuffer, frames)) {
                    IAudioCaptureClient_ReleaseBuffer(captureClient, frames);
                    emit_event("error", "stdout_write_failed",
                               "Failed to write captured audio to stdout");
                    exitCode = 2;
                    goto done;
                }
                emittedFrames += frames;
                drainedFrames += frames;
            }

            hr = IAudioCaptureClient_ReleaseBuffer(captureClient, frames);
            if (FAILED(hr)) {
                break;
            }
        }

        if (FAILED(hr) && hr != AUDCLNT_S_BUFFER_EMPTY) {
            emit_hresult_error("wasapi_capture_failed", "Capture read failed", hr);
            exitCode = 2;
            goto done;
        }

        /* Process loopback delivers nothing while no excluded-mix audio is
         * rendering; keep the timeline continuous against the wall clock. */
        QueryPerformanceCounter(&now);
        targetFrames =
            (UINT64)((now.QuadPart - captureStart.QuadPart) * (LONGLONG)sampleRate /
                     qpcFrequency.QuadPart);
        if (targetFrames > emittedFrames) {
            UINT64 gapFrames = targetFrames - emittedFrames;
            if (gapFrames >= (UINT64)sampleRate * SILENCE_GAP_MAX_MS / 1000) {
                /* QPC keeps counting through system sleep; rebase the clock
                 * so resume does not flood the pipe with hours of silence. */
                captureStart.QuadPart =
                    now.QuadPart -
                    (LONGLONG)(emittedFrames * (UINT64)qpcFrequency.QuadPart / sampleRate);
                emit_event("warning", "timeline_rebased",
                           "Capture clock jumped; audio timeline rebased");
            } else if (gapFrames >= (UINT64)sampleRate * SILENCE_GAP_THRESHOLD_MS / 1000) {
                if (drainedFrames > 0) {
                    /* Audio is flowing, so the deficit is drift between the
                     * audio engine clock and QPC, not real silence. Rebase
                     * instead of splicing silence into continuous audio. */
                    captureStart.QuadPart =
                        now.QuadPart -
                        (LONGLONG)(emittedFrames * (UINT64)qpcFrequency.QuadPart / sampleRate);
                } else {
                    if (!write_silence((size_t)gapFrames)) {
                        emit_event("error", "stdout_write_failed",
                                   "Failed to write silence to stdout");
                        exitCode = 2;
                        goto done;
                    }
                    emittedFrames = targetFrames;
                }
            }
        }

        fflush(stdout);
    }

done:
    IAudioClient_Stop(audioClient);
    IAudioCaptureClient_Release(captureClient);
    IAudioClient_Release(audioClient);
    CloseHandle(samplesReadyEvent);
    free(monoBuffer);
    return exitCode;
}

/* ========================================================================
 * Active render-session watch
 * ======================================================================== */

typedef struct {
    DWORD pid;
    float peak;
} ActiveSessionProcess;

static int find_session_process(
    const ActiveSessionProcess *processes, UINT32 processCount, DWORD pid)
{
    UINT32 index;
    for (index = 0; index < processCount; index++) {
        if (processes[index].pid == pid) {
            return (int)index;
        }
    }
    return -1;
}

static void emit_session_event(const char *state, DWORD pid, float peak)
{
    printf("{\"type\":\"session\",\"state\":\"%s\",\"pid\":%lu,\"peak\":%.6f}\n",
           state, (unsigned long)pid, (double)peak);
    fflush(stdout);
}

static HRESULT collect_active_session_processes(
    DWORD excludedPid, ActiveSessionProcess *processes, UINT32 *processCount)
{
    IMMDeviceEnumerator *deviceEnumerator = NULL;
    IMMDeviceCollection *deviceCollection = NULL;
    UINT32 count = 0;
    UINT deviceCount = 0;
    UINT deviceIndex;
    HRESULT hr;

    *processCount = 0;
    hr = CoCreateInstance(
        &HELPER_CLSID_MMDeviceEnumerator, NULL, CLSCTX_ALL,
        &HELPER_IID_IMMDeviceEnumerator, (void **)&deviceEnumerator);
    if (FAILED(hr)) {
        return hr;
    }
    hr = IMMDeviceEnumerator_EnumAudioEndpoints(
        deviceEnumerator, eRender, DEVICE_STATE_ACTIVE, &deviceCollection);
    if (FAILED(hr)) {
        IMMDeviceEnumerator_Release(deviceEnumerator);
        return hr;
    }
    hr = IMMDeviceCollection_GetCount(deviceCollection, &deviceCount);
    if (FAILED(hr)) {
        IMMDeviceCollection_Release(deviceCollection);
        IMMDeviceEnumerator_Release(deviceEnumerator);
        return hr;
    }

    for (deviceIndex = 0; deviceIndex < deviceCount; deviceIndex++) {
        IMMDevice *device = NULL;
        IAudioSessionManager2 *sessionManager = NULL;
        IAudioSessionEnumerator *sessionEnumerator = NULL;
        int sessionCount = 0;
        int sessionIndex;

        if (FAILED(IMMDeviceCollection_Item(deviceCollection, deviceIndex, &device))) {
            continue;
        }
        hr = IMMDevice_Activate(
            device, &HELPER_IID_IAudioSessionManager2, CLSCTX_ALL, NULL,
            (void **)&sessionManager);
        IMMDevice_Release(device);
        if (FAILED(hr)) {
            continue;
        }
        hr = IAudioSessionManager2_GetSessionEnumerator(sessionManager, &sessionEnumerator);
        if (FAILED(hr)) {
            IAudioSessionManager2_Release(sessionManager);
            continue;
        }
        if (FAILED(IAudioSessionEnumerator_GetCount(sessionEnumerator, &sessionCount))) {
            IAudioSessionEnumerator_Release(sessionEnumerator);
            IAudioSessionManager2_Release(sessionManager);
            continue;
        }

        for (sessionIndex = 0; sessionIndex < sessionCount; sessionIndex++) {
            IAudioSessionControl *sessionControl = NULL;
            IAudioSessionControl2 *sessionControl2 = NULL;
            AudioSessionState sessionState;
            DWORD pid = 0;
            float peak = 1.0f;
            int existing;

            if (FAILED(IAudioSessionEnumerator_GetSession(
                    sessionEnumerator, sessionIndex, &sessionControl))) {
                continue;
            }
            if (FAILED(IAudioSessionControl_GetState(sessionControl, &sessionState)) ||
                sessionState != AudioSessionStateActive ||
                FAILED(IAudioSessionControl_QueryInterface(
                    sessionControl, &HELPER_IID_IAudioSessionControl2,
                    (void **)&sessionControl2)) ||
                FAILED(IAudioSessionControl2_GetProcessId(sessionControl2, &pid)) ||
                pid == 0 || pid == excludedPid || pid == GetCurrentProcessId()) {
                if (sessionControl2) IAudioSessionControl2_Release(sessionControl2);
                IAudioSessionControl_Release(sessionControl);
                continue;
            }

            existing = find_session_process(processes, count, pid);
            if (existing >= 0) {
                if (peak > processes[existing].peak) processes[existing].peak = peak;
            } else if (count < MAX_ACTIVE_SESSION_PROCESSES) {
                processes[count].pid = pid;
                processes[count].peak = peak;
                count++;
            }
            IAudioSessionControl2_Release(sessionControl2);
            IAudioSessionControl_Release(sessionControl);
        }
        IAudioSessionEnumerator_Release(sessionEnumerator);
        IAudioSessionManager2_Release(sessionManager);
    }

    IMMDeviceCollection_Release(deviceCollection);
    IMMDeviceEnumerator_Release(deviceEnumerator);
    *processCount = count;
    return S_OK;
}

static int run_session_watch(DWORD excludedPid)
{
    ActiveSessionProcess previous[MAX_ACTIVE_SESSION_PROCESSES];
    UINT32 previousCount = 0;
    DWORD windowsBuild = get_windows_build_number();

    if (windowsBuild < MIN_APPLICATION_CAPTURE_BUILD) {
        emit_event("error", "unsupported_windows_build",
                   "Application audio capture requires Windows build %lu",
                   (unsigned long)MIN_APPLICATION_CAPTURE_BUILD);
        return 2;
    }
    printf("{\"type\":\"ready\",\"windowsBuild\":%lu,\"minimumWindowsBuild\":%lu}\n",
           (unsigned long)windowsBuild, (unsigned long)MIN_APPLICATION_CAPTURE_BUILD);
    fflush(stdout);

    while (InterlockedCompareExchange(&g_running, TRUE, TRUE)) {
        ActiveSessionProcess current[MAX_ACTIVE_SESSION_PROCESSES];
        UINT32 currentCount = 0;
        UINT32 index;
        HRESULT hr = collect_active_session_processes(excludedPid, current, &currentCount);
        if (FAILED(hr)) {
            emit_event("warning", "session_enumeration_failed",
                       "Audio session enumeration failed (hr=0x%08lx)",
                       (unsigned long)hr);
            Sleep(SESSION_WATCH_INTERVAL_MS);
            continue;
        }

        for (index = 0; index < currentCount; index++) {
            emit_session_event("active", current[index].pid, current[index].peak);
        }
        for (index = 0; index < previousCount; index++) {
            if (find_session_process(current, currentCount, previous[index].pid) < 0) {
                emit_session_event("inactive", previous[index].pid, 0.0f);
            }
        }
        memcpy(previous, current, currentCount * sizeof(ActiveSessionProcess));
        previousCount = currentCount;
        Sleep(SESSION_WATCH_INTERVAL_MS);
    }
    return 0;
}

/* ========================================================================
 * Probe
 * ======================================================================== */

static int run_probe(void)
{
    IAudioClient *audioClient = NULL;
    const char *errorCode = NULL;
    DWORD windowsBuild = get_windows_build_number();
    HRESULT hr;

    hr = activate_process_loopback(
        GetCurrentProcessId(), PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE,
        DEFAULT_SAMPLE_RATE, &audioClient, &errorCode);
    if (FAILED(hr)) {
        emit_probe_result(FALSE, errorCode, hr, windowsBuild);
        return 0;
    }

    IAudioClient_Release(audioClient);
    emit_probe_result(TRUE, NULL, S_OK, windowsBuild);
    return 0;
}

/* ========================================================================
 * Lifecycle
 * ======================================================================== */

static DWORD WINAPI stdin_monitor_thread(LPVOID param)
{
    HANDLE stdinHandle = GetStdHandle(STD_INPUT_HANDLE);
    char buffer[64];
    DWORD bytesRead;

    (void)param;
    while (ReadFile(stdinHandle, buffer, sizeof(buffer), &bytesRead, NULL) && bytesRead > 0) {
    }

    InterlockedExchange(&g_running, FALSE);
    return 0;
}

static BOOL WINAPI console_ctrl_handler(DWORD ctrlType)
{
    (void)ctrlType;
    InterlockedExchange(&g_running, FALSE);
    return TRUE;
}

int main(int argc, char *argv[])
{
    const char *command = argc > 1 ? argv[1] : NULL;
    DWORD targetPid = GetCurrentProcessId();
    PROCESS_LOOPBACK_MODE loopbackMode = PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE;
    BOOL pidModeSpecified = FALSE;
    UINT32 sampleRate = DEFAULT_SAMPLE_RATE;
    DWORD windowsBuild;
    HRESULT hr;
    int exitCode;
    int i;

    if (!command ||
        (strcmp(command, "probe") != 0 && strcmp(command, "start") != 0 &&
         strcmp(command, "watch-sessions") != 0)) {
        fprintf(stderr, "Usage: windows-system-audio-helper <probe|start|watch-sessions> "
                        "[--exclude-pid N | --include-pid N] [--sample-rate N]\n");
        return 1;
    }

    for (i = 2; i < argc; i++) {
        if (strcmp(argv[i], "--exclude-pid") == 0 ||
            strcmp(argv[i], "--include-pid") == 0) {
            if (pidModeSpecified || i + 1 >= argc) {
                fprintf(stderr, "Specify exactly one process-tree capture mode\n");
                return 1;
            }
            loopbackMode = strcmp(argv[i], "--include-pid") == 0
                               ? PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE
                               : PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE;
            targetPid = (DWORD)strtoul(argv[++i], NULL, 10);
            pidModeSpecified = TRUE;
        } else if (strcmp(argv[i], "--sample-rate") == 0) {
            if (i + 1 >= argc) {
                fprintf(stderr, "Missing --sample-rate value\n");
                return 1;
            }
            sampleRate = (UINT32)strtoul(argv[++i], NULL, 10);
        } else {
            fprintf(stderr, "Unknown argument: %s\n", argv[i]);
            return 1;
        }
    }
    if (targetPid == 0 || sampleRate == 0) {
        fprintf(stderr, "Invalid process id or sample-rate value\n");
        return 1;
    }
    if (strcmp(command, "watch-sessions") == 0 &&
        loopbackMode == PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE) {
        fprintf(stderr, "watch-sessions accepts only --exclude-pid\n");
        return 1;
    }
    windowsBuild = get_windows_build_number();
    if ((strcmp(command, "watch-sessions") == 0 ||
         loopbackMode == PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE) &&
        windowsBuild < MIN_APPLICATION_CAPTURE_BUILD) {
        if (strcmp(command, "watch-sessions") == 0) {
            emit_event("error", "unsupported_windows_build",
                       "Application audio capture requires Windows build %lu",
                       (unsigned long)MIN_APPLICATION_CAPTURE_BUILD);
        } else {
            emit_event("error", "unsupported_windows_build",
                       "Include-process capture requires Windows build %lu",
                       (unsigned long)MIN_APPLICATION_CAPTURE_BUILD);
        }
        return 2;
    }

    hr = CoInitializeEx(NULL, COINIT_MULTITHREADED);
    if (FAILED(hr)) {
        if (strcmp(command, "probe") == 0) {
            emit_probe_result(FALSE, "com_init_failed", hr, windowsBuild);
            return 0;
        }
        emit_event("error", "com_init_failed", "COM initialization failed (hr=0x%08lx)",
                   (unsigned long)hr);
        return 2;
    }

    if (strcmp(command, "probe") == 0) {
        exitCode = run_probe();
    } else {
        SetConsoleCtrlHandler(console_ctrl_handler, TRUE);
        HANDLE stdinThread = CreateThread(NULL, 0, stdin_monitor_thread, NULL, 0, NULL);
        if (stdinThread) {
            CloseHandle(stdinThread);
        } else {
            emit_event("warning", "stdin_monitor_failed", "Parent-death detection unavailable");
        }
        if (strcmp(command, "start") == 0) {
            _setmode(_fileno(stdout), _O_BINARY);
            exitCode = run_capture(targetPid, loopbackMode, sampleRate);
        } else {
            exitCode = run_session_watch(targetPid);
        }
    }

    CoUninitialize();
    return exitCode;
}
