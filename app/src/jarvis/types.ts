export type JarvisSessionStatus =
  "recording" | "paused" | "finalizing" | "completed" | "recovered" | "failed";

export type JarvisCaptureMode = "mic" | "system" | "dual";

export type JarvisRetentionMode = "speech_triggered" | "continuous";

export type JarvisEffectiveRetentionMode = JarvisRetentionMode | "continuous_fallback";

export interface JarvisCapturePolicy {
  schemaVersion: number;
  preRollMs: number;
  postRollMs: number;
  mergeGapMs: number;
}

export type JarvisCaptureFailureCode =
  | "MIC_PERMISSION"
  | "MIC_DISCONNECTED"
  | "capture_source_unavailable"
  | "capture_start_failed"
  | "capture_pause_failed"
  | "capture_finish_failed"
  | "upstream_start_failed"
  | "capture_activation_cancelled";

export type JarvisCaptureSourceState =
  "idle" | "checking" | "ready" | "unavailable" | "recording" | "recovering";

export type JarvisCaptureSourceStates = Record<"mic" | "system", JarvisCaptureSourceState>;

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
  captureMode: JarvisCaptureMode;
  retentionMode?: JarvisRetentionMode;
}

export interface JarvisCaptureSourceInput {
  sourceType: "mic" | "system";
  deviceId: string | null;
  deviceLabel: string | null;
  strategy: string | null;
}

export interface JarvisCaptureInput {
  sessionId: string;
  startedAt: number;
  micDeviceId: string | null;
  captureMode: JarvisCaptureMode;
  retentionMode?: JarvisRetentionMode;
  capturePolicy?: JarvisCapturePolicy;
  sources: JarvisCaptureSourceInput[];
}

export interface JarvisPowerResumeSource extends JarvisCaptureSourceInput {
  state?: string;
}

export interface JarvisPowerResumeToken {
  sessionId: string;
  sources: Record<string, JarvisPowerResumeSource>;
  restorations?: JarvisPowerResumeRestorations;
  phase?: "prepare" | "activate" | "commit" | "abort";
  previousSessionId?: string;
  startedAt?: number;
  localDate?: string;
}

export interface JarvisPowerResumeRequest {
  id: string;
  kind: "suspend" | "enumerate" | "resume" | "rotate";
  token: JarvisPowerResumeToken;
}

export type JarvisPowerResumeRestorations = Record<
  string,
  Pick<JarvisCaptureSourceInput, "deviceId" | "deviceLabel" | "strategy">
>;

export interface JarvisSourceInterruptionInput {
  at: number;
  reason: string;
}

export interface JarvisSourceRestorationInput {
  at: number;
  deviceId: string | null;
  deviceLabel: string | null;
  strategy: string | null;
}

export interface JarvisSession {
  id: string;
  started_at: number;
  ended_at: number | null;
  status: JarvisSessionStatus;
  mic_device_id: string | null;
  language: string;
  created_at: number;
  capture_mode: JarvisCaptureMode;
  retention_mode?: JarvisRetentionMode;
  capture_policy_json?: string;
  processing_state?: "pending" | "processing" | "ready";
  timeline_version?: number;
  finalized_at?: number | null;
  ready_at?: number | null;
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
  sourceType?: "mic" | "system";
  text: string;
  confidence: number;
  isStable: boolean;
  echoScore?: number | null;
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
  track_id?: string | null;
  chunk_id?: string | null;
  source_type?: "mic" | "system";
  result_kind?: "provisional" | "final";
  version?: number;
  model_version?: string | null;
  completed_at?: number | null;
  superseded_by?: string | null;
  echo_score?: number | null;
  duplicate_of?: string | null;
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

export type JarvisSpeakerLinkState = "unknown" | "suggested" | "confirmed" | "rejected";
export type JarvisSpeakerCorrectionScope = "session" | "persistent";

export interface JarvisSpeakerPersonSummary {
  id: string;
  displayName: string;
  isSelf: boolean;
}

export interface JarvisSpeakerClusterView {
  id: string;
  sessionId: string;
  trackId: string | null;
  localLabel: string;
  linkState: JarvisSpeakerLinkState;
  person: JarvisSpeakerPersonSummary | null;
  suggestedPerson: JarvisSpeakerPersonSummary | null;
  lastRejectedPerson: JarvisSpeakerPersonSummary | null;
  score: number | null;
  margin: number | null;
  reason: string;
  policyId: string;
  diarizationRevision: string;
  profileRevision: string;
  evidenceSegmentIds: string[];
  canUndo: boolean;
  updatedAt: number;
}

export interface JarvisConfirmSpeakerInput {
  clusterId: string;
  personId?: string;
  newPersonName?: string;
  scope: JarvisSpeakerCorrectionScope;
}

export type JarvisProfileSampleReason =
  | "added"
  | "session_scope"
  | "insufficient_speech"
  | "insufficient_windows"
  | "insufficient_quality"
  | "missing_embedding"
  | "already_present";

export interface JarvisSpeakerConfirmationResult {
  cluster: JarvisSpeakerClusterView;
  profileSampleAdded: boolean;
  profileSampleReason: JarvisProfileSampleReason;
  createdPerson: boolean;
}

export interface JarvisSpeakerCorrectionView {
  id: string;
  clusterId: string;
  previousPersonId: string | null;
  nextPersonId: string | null;
  previousPersonRef: string | null;
  nextPersonRef: string | null;
  previousState: JarvisSpeakerLinkState;
  nextState: JarvisSpeakerLinkState;
  scope: JarvisSpeakerCorrectionScope;
  actor: "user" | "system";
  correctionKind: "link" | "merge";
  createdAt: number;
  undoneAt: number | null;
}

export interface JarvisPersonIdentityDetail {
  samples: Array<{
    id: string;
    modelId: string;
    sourceKind: "enrollment" | "user_confirmed";
    sourceClusterId: string | null;
    speechMs: number;
    windowCount: number;
    createdAt: number;
  }>;
  appearances: Array<{
    clusterId: string;
    sessionId: string;
    localLabel: string;
    linkState: JarvisSpeakerLinkState;
    score: number | null;
    margin: number | null;
    updatedAt: number;
  }>;
  corrections: JarvisSpeakerCorrectionView[];
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
  pcm_sha256?: string;
  track_id?: string | null;
  source_type?: "mic" | "system";
  sequence_number?: number;
  write_state?: string;
  deleted_at?: number | null;
  format?: "wav" | "flac";
  file_sha256?: string | null;
  sample_rate?: number;
  channels?: number;
}

export interface JarvisAudioGap {
  id: string;
  track_id: string;
  started_at: number;
  ended_at: number | null;
  reason: string;
  recovery_attempts: number;
  restored_device_id?: string | null;
  restored_device_label?: string | null;
  restored_strategy?: string | null;
  average_level?: number | null;
  peak_level?: number | null;
}

export interface JarvisAudioTrack {
  id: string;
  session_id: string;
  source_type: "mic" | "system";
  device_id: string | null;
  device_label: string | null;
  strategy: string | null;
  sample_rate: number;
  channels: number;
  started_at: number;
  ended_at: number | null;
  state: string;
  gaps: JarvisAudioGap[];
}

export interface JarvisProcessingJobCounts {
  pending: number;
  leased: number;
  retry: number;
  blocked: number;
  completed: number;
  total: number;
}

export type JarvisPreviewMode = "normal" | "degraded" | "paused";

export interface JarvisPreviewStatus {
  mode: JarvisPreviewMode;
  cadenceMs: number | null;
  pending: number;
  running: number;
  pausedReason: string | null;
  executionDevice: "cuda" | "cpu" | null;
  lastError: string | null;
  recordingContinues: true;
}

export type JarvisResourceState = "available" | "busy" | "constrained" | "unavailable";
export type JarvisRuntimeRecoveryAction =
  "wait_for_gpu" | "check_cuda" | "free_disk" | "restore_microphone" | "retry_jobs";

export interface JarvisRuntimeQueueStageCounts {
  pending: number;
  running: number;
  retry: number;
  blocked: number;
  total: number;
}

export interface JarvisRuntimeDeferral {
  stage: string;
  jobType: string;
  state: "retry" | "blocked";
  reason: string;
  count: number;
  nextRetryAt: number | null;
}

export interface JarvisRuntimeStatus {
  observedAt: number;
  capture: {
    sessionId: string | null;
    status: JarvisRuntimeState["status"];
    captureMode: JarvisCaptureMode | null;
    retentionMode: JarvisRetentionMode | null;
    errorCode: string | null;
  };
  backend: {
    actualBackend: "cuda" | "cpu" | "cloud" | null;
    cudaGpuUuid: string | null;
  };
  resources: {
    sampledAt: number | null;
    state: JarvisResourceState;
    reason: string;
    cudaInstalled: boolean | null;
    cudaVerified: boolean | null;
    cudaQuarantined: boolean | null;
  };
  queue: JarvisRuntimeQueueStageCounts & {
    byStage: Record<string, JarvisRuntimeQueueStageCounts>;
    deferrals: JarvisRuntimeDeferral[];
    backlogMinutes: number;
    oldestJobAgeMs: number | null;
    finalCoveragePct: number | null;
    provisionalCoveragePct: number | null;
  };
  preview: JarvisPreviewStatus | null;
  disk: {
    state: string;
    freeBytes: number | null;
    remainingDays: number | null;
    recoveryAction: string | null;
  };
  nextRecoveryAction: JarvisRuntimeRecoveryAction | null;
}

export interface JarvisSessionTimeline {
  session_id: string;
  started_at: number;
  ended_at: number | null;
  status: JarvisSessionStatus;
  processing_state: "pending" | "processing" | "ready";
  timeline_version: number;
  finalized_at: number | null;
  ready_at: number | null;
  tracks: JarvisAudioTrack[];
  gaps: JarvisAudioGap[];
  chunks: JarvisAudioChunk[];
  segments: JarvisTranscriptSegment[];
  processing_counts: JarvisProcessingJobCounts;
  preview_status?: JarvisPreviewStatus | null;
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
  identity: JarvisPersonIdentityDetail;
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
  state: "waiting" | "analyzing" | "ready" | "quota_limited" | "retry_needed" | "blocked";
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
  targetDurationSeconds: 32;
}

export interface JarvisVoiceEnrollmentStatus {
  enrolled: boolean;
  modelId: string;
  acceptedSpeechMs: number;
  windowCount: number;
  selfConsistency: number | null;
  updatedAt: number | null;
}

export type JarvisVoiceEnrollmentOutcome =
  "accepted" | "insufficient_speech" | "inconsistent_samples" | "model_error";

export interface JarvisVoiceEnrollmentResult {
  status: JarvisVoiceEnrollmentOutcome;
  modelId: string;
  acceptedSpeechMs: number;
  windowCount: number;
  selfConsistency: number | null;
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

export type JarvisStorageState = "ok" | "warning" | "stopped";

export interface JarvisStorageProgress {
  state: "starting" | "copying" | "verifying" | "activating" | "rollback" | "complete" | "failed";
  completedFiles: number;
  totalFiles: number;
}

export interface JarvisStorageStatus {
  state: JarvisStorageState;
  volumeBytes: number;
  freeBytes: number;
  warningBytes: number;
  stopBytes: number;
  writtenBytes24h: number;
  compressedBytes24h: number;
  netGrowthBytes24h: number;
  projectedDailyGrowthBytes: number;
  remainingDays: number | null;
  currentRoot: string;
  progress: JarvisStorageProgress | null;
  recoveryAction: string | null;
}

export interface JarvisStorageMigrationResult {
  switched: boolean;
  canDeleteOldRoot: boolean;
  oldRoot?: string;
  currentRoot?: string;
  recoveryAction?: string;
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
  status: "idle" | "degraded" | JarvisSessionStatus;
  startedAt: number | null;
  elapsedMs: number;
  errorCode: string | null;
  captureMode?: JarvisCaptureMode | null;
  retentionMode?: JarvisRetentionMode | null;
  effectiveRetentionMode?: JarvisEffectiveRetentionMode | null;
  retentionDegradedReason?: string | null;
  capturePolicy?: JarvisCapturePolicy | null;
}
