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

export interface JarvisSessionSummary {
  session_id: string;
  summary: string;
  decisions_json: string;
  suggestions_json: string;
  updated_at: number;
  is_final: number;
}

export interface JarvisTopic {
  id: string;
  canonical_title: string;
  normalized_title: string;
  description: string;
  status: "active" | "archived";
  created_at: number;
  last_seen_at: number;
  session_count?: number;
  open_todo_count?: number;
}

export interface JarvisTodo {
  id: string;
  content: string;
  owner_person_id: string | null;
  owner_name?: string | null;
  topic_id: string | null;
  topic_title?: string | null;
  due_at: number | null;
  status: "open" | "completed";
  updated_at: number;
  completed_at: number | null;
  source_session_id: string;
  source_segment_id: string | null;
}

export interface JarvisMemoryItem {
  id: string;
  type: "fact" | "decision" | "commitment" | "opinion";
  content: string;
  person_id: string | null;
  person_name?: string | null;
  topic_id: string | null;
  topic_title?: string | null;
  confidence: number;
  last_seen_at: number;
  occurrence_count: number;
  needs_confirmation: number;
}

export interface JarvisSessionDetail {
  session: JarvisSession;
  summary: JarvisSessionSummary | null;
  segments: JarvisTranscriptSegment[];
  audioChunks: JarvisAudioChunk[];
  topics: JarvisTopic[];
  todos: JarvisTodo[];
  memories: JarvisMemoryItem[];
}

export interface JarvisPersonOverview extends JarvisPerson {
  session_count: number;
  open_todo_count: number;
  last_interaction_at: number | null;
}

export interface JarvisPersonDetail {
  person: JarvisPerson;
  sessions: JarvisSession[];
  todos: JarvisTodo[];
  memories: JarvisMemoryItem[];
  topics: JarvisTopic[];
}

export interface JarvisTopicDetail {
  topic: JarvisTopic;
  sessions: JarvisSession[];
  todos: JarvisTodo[];
  memories: JarvisMemoryItem[];
}

export interface JarvisTodayInsights {
  summary: JarvisSessionSummary | null;
  topics: JarvisTopic[];
  todos: JarvisTodo[];
  memories: JarvisMemoryItem[];
}

export interface JarvisAnalysisStatus {
  sessionId: string;
  state: "waiting" | "analyzing" | "ready" | "quota_limited" | "retry_needed";
  errorCode: string | null;
  updatedAt: number | null;
}

export interface JarvisMiniMaxConfig {
  keyConfigured: boolean;
  model: string;
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
  "cloud_disabled" | "budget_protected" | "usage_unknown" | null;

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
