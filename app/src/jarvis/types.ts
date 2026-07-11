export type JarvisSessionStatus =
  "recording" | "paused" | "finalizing" | "completed" | "recovered" | "failed";

export interface JarvisControlEnvelope {
  id: string;
  action: JarvisControlAction;
  expiresAt: number;
}

export interface JarvisSessionInput {
  id: string;
  startedAt: number;
  micDeviceId: string | null;
  language?: string;
}

export interface JarvisCaptureInput {
  sessionId: string;
  startedAt: number;
  micDeviceId: string | null;
}

export interface JarvisSession {
  id: string;
  started_at: number;
  ended_at: number | null;
  status: JarvisSessionStatus;
  mic_device_id: string | null;
  language: string;
  created_at: number;
}

export interface JarvisSessionQuery {
  from?: number;
  to?: number;
  limit?: number;
}

export interface JarvisTranscriptSegmentInput {
  id: string;
  startedAt: number;
  endedAt: number;
  personId: string | null;
  speakerLabel: string;
  text: string;
  confidence: number;
  isStable: boolean;
}

export interface JarvisTranscriptSegment {
  id: string;
  session_id: string;
  started_at: number;
  ended_at: number;
  person_id: string | null;
  speaker_label: string;
  text: string;
  confidence: number;
  is_stable: number;
  analysis_state: string;
}

export interface JarvisRenamePersonInput {
  personId: string;
  displayName?: string;
  isSelf?: boolean;
  voiceProfileId?: number | null;
}

export interface JarvisPerson {
  id: string;
  display_name: string;
  is_self: number;
  voice_profile_id: number | null;
  voice_confidence: number | null;
  created_at: number;
  last_seen_at: number;
}

export interface JarvisAudioChunk {
  id: string;
  session_id: string;
  path: string;
  started_at: number;
  ended_at: number;
  duration_ms: number;
  sha256: string;
  expires_at: number;
  transcription_status: string;
}

export interface JarvisVoiceEnrollmentSession {
  sessionId: string;
  expiresAt: number;
  sampleRate: 24000;
  channels: 1;
  format: "float32";
  targetDurationSeconds: 30;
}

export interface JarvisVoiceEnrollmentStatus {
  enrolled: boolean;
  profileId: number | null;
  sampleCount: number;
  updatedAt: string | null;
}

export type JarvisCloudBudgetBlockedReason =
  | "cloud_disabled"
  | "budget_protected"
  | "usage_unknown"
  | null;

export interface JarvisCloudBudgetStatus {
  monthUtc: string;
  enabled: boolean;
  keyConfigured: boolean;
  monthlyLimitMicrousd: number;
  spentMicrousd: number;
  reservedMicrousd: number;
  remainingMicrousd: number;
  blockedReason: JarvisCloudBudgetBlockedReason;
}

export interface JarvisCloudBudgetInput {
  enabled: boolean;
  monthlyLimitMicrousd: number;
}

export interface JarvisVoiceEnrollmentWindow {
  startSample: number;
  endSample: number;
  samples: Float32Array;
}

export interface JarvisVoiceEnrollmentPayload {
  sampleRate: 24000;
  channels: 1;
  format: "float32";
  recordedSampleCount: number;
  windows: JarvisVoiceEnrollmentWindow[];
}

export type JarvisControlAction = "start" | "pause" | "resume" | "finish";

export interface JarvisRuntimeState {
  sessionId: string | null;
  status: "idle" | JarvisSessionStatus;
  startedAt: number | null;
  elapsedMs: number;
  errorCode: string | null;
}
