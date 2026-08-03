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
  | "capture_start_timeout"
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
  mic_device_id?: string | null;
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

export type JarvisActivityCategory =
  | "work_meeting"
  | "learning"
  | "social_call"
  | "in_person_conversation"
  | "entertainment"
  | "gaming"
  | "other"
  | "unknown";

export type JarvisActivityDecision = "adopted" | "tentative" | "unknown";

export interface JarvisActivityClassification {
  id: string;
  sessionId: string;
  startedAt: number;
  endedAt: number;
  category: JarvisActivityCategory;
  confidence: number;
  decision: JarvisActivityDecision;
  source: "local" | "minimax" | "user";
  reason: string;
  sourceAttribution: "application" | "microphone" | "application_and_microphone" | "mixed_unknown";
  applications: string[];
  allowSummary: boolean;
  allowSuggestions: boolean;
  allowTodos: boolean;
  evidenceSegmentIds: string[];
  createdAt: number;
  updatedAt: number;
}

export interface JarvisPersonalizationRule {
  id: string;
  domain: "activity_classification" | "suggestion" | "todo" | "person";
  targetValue: string;
  label: string;
  supportCount: number;
  state: "proposed" | "enabled" | "disabled" | "deleted";
  conditions: {
    applicationKeys: string[];
    selfParticipated: boolean;
    speakerCountBucket: "none" | "one" | "multiple";
    timeBucket: "night" | "morning" | "afternoon" | "evening" | "unknown";
  };
  createdAt: number;
  updatedAt: number;
}

export interface JarvisPersonalizationRuleEdit {
  label: string;
  targetValue: JarvisActivityCategory;
  conditions: Omit<JarvisPersonalizationRule["conditions"], "timeBucket"> & {
    timeBucket: Exclude<JarvisPersonalizationRule["conditions"]["timeBucket"], "unknown">;
  };
}

export interface JarvisNotificationPreferences {
  focusMode: boolean;
  mutedUntil: number | null;
  updatedAt: number;
  effectiveMuted: boolean;
}

export interface JarvisTodoReminder {
  todoId: string;
  reminderAt: number;
  reminderSource: "user";
  state: "scheduled" | "deferred" | "delivered" | "cancelled";
  deferredReason: string | null;
  deliveredAt: number | null;
  updatedAt: number;
}

export interface JarvisPersonalizationSettings {
  rules: JarvisPersonalizationRule[];
  notifications: JarvisNotificationPreferences;
}

export type JarvisLearningGoalState = "confirmed" | "archived" | "deleted";

export interface JarvisLearningGoal {
  id: string;
  title: string;
  state: JarvisLearningGoalState;
  createdAt: number;
  updatedAt: number;
  confirmedAt: number;
  archivedAt: number | null;
}

export type JarvisLearningGoalResultStatus =
  | "created"
  | "existing"
  | "edited"
  | "unchanged"
  | "archived"
  | "already_archived"
  | "restored"
  | "already_confirmed"
  | "deleted";

export interface JarvisLearningGoalResult {
  status: JarvisLearningGoalResultStatus;
  goal: JarvisLearningGoal;
}

export interface JarvisActivityCorrectionResult {
  classification: JarvisActivityClassification;
  proposedRule: JarvisPersonalizationRule | null;
  supportCount: number;
}

export type JarvisEvidenceOwnerType =
  | "memory_value"
  | "topic_revision"
  | "todo_instance"
  | "session_summary_revision"
  | "daily_digest_item"
  | "suggestion"
  | "speaker_cluster";

export interface JarvisEvidenceHandle {
  ownerType: JarvisEvidenceOwnerType;
  ownerId: string;
  evidenceId: string;
}

export interface JarvisEvidenceContext extends JarvisEvidenceHandle {
  sessionId: string;
  sessionStartedAt: number;
  sessionEndedAt: number | null;
  transcriptSegmentId: string | null;
  transcriptState: "available" | "missing";
  trackId: string | null;
  sourceType: "mic" | "system" | null;
  startedAt: number;
  endedAt: number;
  quoteText: string | null;
  audioState: "available" | "expired" | "missing";
  transcriptContext?: Array<{
    segmentId: string;
    startedAt: number;
    endedAt: number;
    text: string;
    speakerRelation: "SELF" | `P${number}` | "UNKNOWN";
    applicationName: string | null;
    isEvidence: boolean;
  }>;
  actionAttribution: {
    basis: "captured_todo_snapshot" | "current_local_state";
    applicationKey: string | null;
    applicationName: string;
    sourceAttribution: JarvisActivityClassification["sourceAttribution"];
    speakerRelation: "SELF" | `P${number}` | "UNKNOWN";
    semanticConfidence: number | null;
    voiceConfidence: number | null;
    transcriptConfidence: number | null;
    activityClassification: {
      id: string | null;
      category: JarvisActivityCategory;
      confidence: number | null;
      decision: JarvisActivityDecision;
      source: JarvisActivityClassification["source"] | "captured_snapshot";
      reason: string | null;
    } | null;
  } | null;
}

export type JarvisEvidenceNavigationState =
  | { phase: "idle"; requestId: number }
  | { phase: "resolving"; requestId: number; handle: JarvisEvidenceHandle }
  | { phase: "opening_session"; requestId: number; context: JarvisEvidenceContext }
  | { phase: "seeking"; requestId: number; context: JarvisEvidenceContext }
  | {
      phase: "transcript_only";
      requestId: number;
      context: JarvisEvidenceContext;
      reason: "audio_expired" | "audio_missing" | "audio_became_unavailable";
    }
  | { phase: "playing"; requestId: number; context: JarvisEvidenceContext }
  | {
      phase: "failed";
      requestId: number;
      code: "evidence_not_found" | "session_unavailable" | "evidence_navigation_failed";
    };

export interface JarvisContinuousSeekRequest {
  requestId: number;
  trackId: string | null;
  sourceType: "mic" | "system" | null;
  startedAt: number;
}

export type JarvisContinuousSeekResult = "playing" | "audio_unavailable" | "seek_target_missing";

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
  application_key?: string | null;
  application_display_name?: string | null;
  track_kind?: "mic" | "system_mix" | "application" | null;
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
  candidatePersonRef: string | null;
  speechMs: number;
  windowCount: number;
  qualityScore: number | null;
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
  started_at: number;
  ended_at: number;
  duration_ms: number;
  transcription_status?: string;
  track_id?: string | null;
  source_type?: "mic" | "system";
  sequence_number?: number;
  write_state?: string;
  deleted_at?: number | null;
  format?: "wav" | "flac";
}

export interface JarvisAudioGap {
  id: string;
  track_id: string;
  started_at: number;
  ended_at: number | null;
  reason: string;
  recovery_attempts: number;
  average_level?: number | null;
  peak_level?: number | null;
}

export interface JarvisAudioTrack {
  id: string;
  session_id: string;
  source_type: "mic" | "system";
  track_kind: "mic" | "system_mix" | "application";
  application_key: string | null;
  application_display_name: string | null;
  attribution_state: "exact" | "mixed_unknown";
  capture_generation: number;
  sample_rate: number;
  channels: number;
  started_at: number;
  ended_at: number | null;
  state: string;
  failure_code?: string | null;
  gaps: JarvisAudioGap[];
}

export interface JarvisApplicationAudioInterval {
  id: string;
  session_id: string;
  track_id: string;
  interval_kind: "application_active" | "mixed_fallback";
  application_key: string | null;
  attribution_state: "exact" | "mixed_unknown";
  capture_generation: number;
  started_at: number;
  ended_at: number | null;
  reason: string | null;
  failure_code?: string | null;
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
  application_audio_intervals: JarvisApplicationAudioInterval[];
  application_capture?: {
    exact_duration_ms: number;
    fallback_duration_ms: number;
    exact_coverage_pct: number | null;
    degraded_intervals: JarvisApplicationAudioInterval[];
    recovery_points: number[];
    degraded_interval_count?: number;
    recovery_count?: number;
  };
  evidence_page?: {
    tracks: { offset: number; limit: number; total: number };
    intervals: { offset: number; limit: number; total: number };
  } | null;
  gaps: JarvisAudioGap[];
  chunks: JarvisAudioChunk[];
  segments: JarvisTranscriptSegment[];
  processing_counts: JarvisProcessingJobCounts;
  preview_status?: JarvisPreviewStatus | null;
}

export interface JarvisSessionTimelineStatus {
  session_id: string;
  status: JarvisSessionStatus;
  processing_state: "pending" | "processing" | "ready";
  timeline_version: number;
  finalized_at: number | null;
  ready_at: number | null;
  processing_counts: JarvisProcessingJobCounts;
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
  speakerProcessing: JarvisSessionSpeakerProcessing | null;
}

export interface JarvisDiarizationRunView {
  id: string;
  trackId: string;
  policyId: string;
  inputVersion: 1 | 2;
  executionDevice: "cpu" | "cuda";
  speakerCount: {
    minimum: number;
    maximum: number;
    preferred: number | null;
    confidence: number | null;
    state: string;
  } | null;
  overlapMs: number;
  overlapSeparationState: "not_needed" | "completed" | "partial" | "failed";
  modelPackVersion: string | null;
  models: string[];
  commitSequence: number;
  completedAt: number;
}

export type JarvisSessionParticipantKind =
  "self" | "known" | "anonymous" | "reviewed" | "temporary" | "media";

export interface JarvisParticipantEvidenceSegment {
  clusterId: string;
  id: string;
  started_at: number;
  ended_at: number;
  text: string;
  confidence: number | null;
  track_id: string | null;
  source_type: "mic" | "system";
  result_kind: string;
  duplicate_of: string | null;
  sourceName: string;
  pinned?: boolean;
}

export interface JarvisSessionParticipant {
  id: string;
  kind: JarvisSessionParticipantKind;
  displayName: string;
  person: JarvisSpeakerPersonSummary | null;
  candidatePersonRef: string | null;
  reviewState: "confirmed" | "needs_review" | "media";
  durable: boolean;
  speechMs: number;
  segmentCount: number;
  clusterCount: number;
  clusterIds: string[];
  segmentIds: string[];
  sourceNames: string[];
  minimumCount: number;
  maximumCount: number;
  score: number | null;
  representativeSegments: JarvisParticipantEvidenceSegment[];
  representativeCluster: JarvisSpeakerClusterView;
}

export interface JarvisSessionParticipantProjection {
  projectorVersion?: string;
  count: {
    minimum: number;
    maximum: number;
    confirmed: number;
    needsReview: number;
    selfIncluded: boolean;
  };
  participants: JarvisSessionParticipant[];
  mediaVoices: JarvisSessionParticipant[];
  excluded: {
    fragmented: number;
    shadowedSystemMix: number;
    anomaly: boolean;
  };
}

export interface JarvisSessionSpeakerProcessing {
  preferredInputVersion: 1 | 2;
  latestRuns: JarvisDiarizationRunView[];
  history: JarvisDiarizationRunView[];
  speakers: JarvisSpeakerClusterView[];
  participants: JarvisSessionParticipantProjection;
  participantSnapshot: {
    id: string;
    revision: number;
    sourceHash: string;
    createdAt: number;
  } | null;
  fragmentedEvidenceCount: number;
  summaryRefresh: {
    basis_policy_id: string | null;
    latest_policy_id: string;
    recommended: 0 | 1;
    reason: string | null;
    updated_at: number;
  } | null;
  reprocessing: {
    policy_id: string;
    mode: "historical_local_only";
    state: "queued" | "processing" | "completed";
    started_at: number;
    completed_at: number | null;
    baseline_content_sha256: string;
    baseline_identity_sha256: string;
    baseline_classification_sha256: string;
  } | null;
}

export interface JarvisPersonOverview extends JarvisPerson {
  session_count: number;
  open_todo_count: number;
  last_interaction_at: number | null;
}

export interface JarvisAnonymousPersonOverview {
  id: string;
  displayName: string;
  sessionCount: number;
  clusterCount: number;
  speechMs: number;
  lastSeenAt: number;
  sourceNames: string[];
  representativeCluster: JarvisSpeakerClusterView;
}

export interface JarvisPendingParticipantOverview {
  id: string;
  sessionId: string;
  sessionStartedAt: number;
  minimumCount: number;
  maximumCount: number;
  clusterCount: number;
  speechMs: number;
  sourceNames: string[];
  representativeCluster: JarvisSpeakerClusterView;
}

export interface JarvisPeopleReviewOverview {
  anonymous: JarvisAnonymousPersonOverview[];
  needsReview: JarvisPendingParticipantOverview[];
}

export type JarvisParticipantReviewAction =
  | "split"
  | "merge"
  | "mark_media"
  | "restore_social"
  | "forget_identity"
  | "pin_evidence"
  | "unpin_evidence";

export interface JarvisParticipantReviewInput {
  sessionId: string;
  action: JarvisParticipantReviewAction;
  clusterIds?: string[];
  segmentIds?: string[];
  personId?: string;
  label?: string;
}

export interface JarvisParticipantReviewPreview {
  sessionId: string;
  action: JarvisParticipantReviewAction;
  clusterIds: string[];
  segmentIds: string[];
  affectedClusterCount: number;
  affectedSegmentCount: number;
  affectedPersonIds: string[];
  affectedSessionIds: string[];
  historyImpact?: {
    sessionCount: number;
    clusterCount: number;
    segmentCount: number;
    sessionIds: string[];
  };
  canUndo: boolean;
}

export interface JarvisParticipantReviewEvent {
  id: string;
  sessionId: string;
  action: JarvisParticipantReviewAction | "undo";
  createdAt: number;
  canUndo: boolean;
}

export interface JarvisParticipantReviewHistoryEvent extends JarvisParticipantReviewEvent {
  subjectRef: string;
  payload: Record<string, unknown>;
  revertsEventId: string | null;
  actor: "user" | "system";
}

export interface JarvisParticipantReviewResult {
  event: JarvisParticipantReviewEvent;
  preview?: JarvisParticipantReviewPreview;
  speakerProcessing: JarvisSessionSpeakerProcessing;
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
  people: JarvisPerson[];
  sessions: JarvisSession[];
  decisions: Array<{ sessionId: string; content: string }>;
  todos: JarvisTodo[];
  memories: JarvisMemoryItem[];
}

export interface JarvisTodayInsights {
  summary: JarvisSessionSummary | null;
  topics: JarvisTopic[];
  todos: JarvisTodo[];
  memories: JarvisMemoryItem[];
}

export interface JarvisDailyDigestFactualItem {
  text: string;
  evidenceSegmentIds: string[];
}

export interface JarvisDailyDigestContent {
  schemaVersion: "jarvis-daily-digest-v1";
  sections: {
    today: JarvisDailyDigestFactualItem[];
    interactions: Array<JarvisDailyDigestFactualItem & { subjectRef: string }>;
    topicsAndDecisions: JarvisDailyDigestFactualItem[];
    commitmentsAndTodos: JarvisDailyDigestFactualItem[];
    worthRemembering: JarvisDailyDigestFactualItem[];
    tomorrowSuggestions: Array<{
      text: string;
      rationale: string;
      evidenceSegmentIds: string[];
      allowedActions: Array<"accept" | "dismiss" | "convert_to_todo">;
    }>;
  };
  processing: {
    completeness: "partial" | "final";
    missingStages: string[];
    transcriptCoverage: {
      selectedSegmentCount: number;
      incompleteSegmentCount: number;
      sessionCount: number;
      startsAt: number;
      endsAt: number;
    };
  };
}

export interface JarvisDailyDigestEvidence {
  sessionId: string;
  segmentId: string;
  startedAt: number;
  endedAt: number;
  quote: string;
  audioState: "available" | "expired" | "missing";
  handle?: JarvisEvidenceHandle;
}

export interface JarvisDailyDigest {
  localDate: string;
  revision: number;
  completeness: "partial" | "final";
  content: JarvisDailyDigestContent;
  evidence: JarvisDailyDigestEvidence[];
  createdAt: number;
  updatedAt: number;
}

export interface JarvisDailyDigestStatus {
  state: "not_generated" | "empty" | "queued" | "running" | "retry_needed" | "ready" | "blocked";
  retryable: boolean;
  errorCode:
    | "offline"
    | "budget_unavailable"
    | "usage_unknown"
    | "invalid_response"
    | "runtime_unavailable"
    | "generation_failed"
    | null;
  nextRetryAt: number | null;
  attemptCount: number;
}

export interface JarvisDailyDigestReadResult {
  digest: JarvisDailyDigest | null;
  status: JarvisDailyDigestStatus;
}

export interface JarvisKnowledgeEvidence {
  sessionId: string;
  segmentId: string;
  startedAt: number;
  endedAt: number;
  quote: string;
  audioState: "available" | "expired" | "missing";
  handle?: JarvisEvidenceHandle;
}

export interface JarvisActionCenterWatermark {
  revision: string;
  todoCount: number;
  suggestionCount: number;
  updatedAt: number | null;
}

export interface JarvisActionCenterSessionDelta {
  sessionId: string;
  confirmedTodoCount: number;
  pendingTodoCount: number;
  suggestionCount: number;
  total: number;
}

export interface JarvisActionCenterDelta {
  throughSequence: number;
  lastSeenSequence: number;
  confirmedTodoCount: number;
  pendingTodoCount: number;
  suggestionCount: number;
  total: number;
  sessions: JarvisActionCenterSessionDelta[];
}

export interface JarvisActionCenterReadResult {
  lastSeenSequence: number;
  markedAt: number;
}

export interface JarvisTodoTrustSnapshot {
  policyId: string;
  state: "captured" | "legacy_unverified" | "user_override";
  applicationEvidence: Array<{
    segmentId: string;
    applicationKey: string | null;
    sourceAttribution: JarvisActivityClassification["sourceAttribution"];
    speakerRelation: "SELF" | `P${number}` | "UNKNOWN";
  }>;
  activityEvidence: Array<{
    segmentId: string;
    category: JarvisActivityCategory;
    confidence: number;
    decision: JarvisActivityDecision;
  }>;
  semanticConfidence: number | null;
  voiceprintConfidence: number | null;
  sceneConfidence: number | null;
  transcriptContextConfidence: number | null;
  speakerEvidenceVerified: boolean | null;
  overlapDetected: boolean | null;
  automaticEligible: boolean;
}

export interface JarvisKnowledgeCardContext {
  sessionId: string | null;
  startedAt: number | null;
  applicationName: string | null;
  activityCategory: JarvisActivityCategory | null;
  activityConfidence: number | null;
  sourceAttribution: JarvisActivityClassification["sourceAttribution"];
}

export interface JarvisKnowledgeOverview {
  memories: Array<{
    id: string;
    kind: string;
    title: string;
    body: string;
    confidence: number;
    lifecycle: string;
    createdAt: number;
    updatedAt: number;
    occurrences: Array<{
      id: string;
      sessionId: string | null;
      startedAt: number | null;
      endedAt: number | null;
      confidence: number;
      createdAt: number;
      evidence: JarvisKnowledgeEvidence[];
    }>;
  }>;
  topics: Array<{
    id: string;
    name: string;
    lifecycle: string;
    createdAt: number;
    updatedAt: number;
    revisions: Array<{
      id: string;
      revision: number;
      summary: string;
      createdAt: number;
    }>;
    occurrences: Array<{
      id: string;
      sessionId: string | null;
      revisionId: string;
      createdAt: number;
      evidence: JarvisKnowledgeEvidence[];
    }>;
  }>;
  todos: Array<{
    id: string;
    title: string;
    ownerLabel: string | null;
    status: "open" | "completed" | "dismissed";
    completedAt: number | null;
    dismissedAt: number | null;
    verificationState: "confirmed" | "pending_confirmation" | "dismissed";
    verificationReason?:
      | "strict_self_commitment"
      | "assigned_and_accepted"
      | "user_confirmed"
      | "user_dismissed"
      | null;
    verificationActor?: "system" | "user" | null;
    trustSnapshot: JarvisTodoTrustSnapshot | null;
    cardContext: JarvisKnowledgeCardContext;
    sourceKind?: "existing" | "manual" | "transcript" | "suggestion";
    sourceSessionId?: string | null;
    pinned?: boolean;
    urgency?: "normal" | "urgent";
    userModified?: boolean;
    dismissReasonCode?: JarvisKnowledgeDismissReason | null;
    provenance?: "evidence_linked" | "legacy_unverified" | "suggestion" | "source_deleted";
    sourceSuggestionId?: string | null;
    reminder?: Omit<JarvisTodoReminder, "todoId" | "updatedAt"> | null;
    createdAt: number;
    updatedAt: number;
    revisions: Array<{
      id: string;
      revision: number;
      title: string;
      dueText: string | null;
      createdAt: number;
    }>;
    occurrences: Array<{
      id: string;
      sessionId: string | null;
      revisionId: string;
      startedAt: number | null;
      endedAt: number | null;
      createdAt: number;
      evidence: JarvisKnowledgeEvidence[];
    }>;
    transitions: Array<{
      id: string;
      fromStatus: string | null;
      toStatus: "open" | "completed" | "dismissed";
      reason?: string;
      actor?: "system" | "user";
      occurredAt: number;
    }>;
  }>;
  suggestions: Array<{
    id: string;
    title: string;
    rationale: string;
    state: "proposed" | "accepted" | "dismissed";
    dismissReasonCode?: JarvisKnowledgeDismissReason | null;
    convertedTodoId?: string | null;
    acceptanceUndone?: boolean;
    decidedAt: number | null;
    createdAt: number;
    updatedAt: number;
    cardContext: JarvisKnowledgeCardContext;
    occurrences: Array<{
      id: string;
      sessionId: string | null;
      createdAt: number;
      evidence: JarvisKnowledgeEvidence[];
    }>;
  }>;
  conflicts: Array<{
    id: string;
    episode: number;
    state: "open" | "resolved";
    selectedMemoryItemId: string | null;
    resolvedAt: number | null;
    createdAt: number;
    updatedAt: number;
    members: Array<{
      memoryItemId: string;
      title: string;
      body: string;
      lifecycle: string;
      selected: boolean;
    }>;
  }>;
  truncated: boolean;
}

export interface JarvisSuggestionDecisionResult {
  status: "accepted" | "already_accepted" | "dismissed" | "already_dismissed";
  suggestionId: string;
  decidedAt: number;
  todoId?: string | null;
}

export interface JarvisMemoryConflictResolutionResult {
  status: "resolved" | "already_resolved";
  conflictGroupId: string;
  selectedMemoryItemId: string;
}

export interface JarvisKnowledgeTodoCompletionResult {
  status: "completed" | "already_completed";
  todoId: string;
  completedAt: number;
}

export interface JarvisKnowledgeTodoDecisionResult {
  status:
    | "confirmed"
    | "already_confirmed"
    | "dismissed"
    | "already_dismissed"
    | "reopened"
    | "already_open";
  todoId: string;
  decidedAt: number;
}

export type JarvisKnowledgeDismissReason =
  "not_relevant" | "already_done" | "not_mine" | "wrong_context" | "low_value" | "other";

interface JarvisKnowledgeActionBase {
  commandId: string;
}

export type JarvisKnowledgeActionInput =
  | (JarvisKnowledgeActionBase & {
      type: "manual_create";
      todoId: string;
      title: string;
      dueText: string | null;
    })
  | (JarvisKnowledgeActionBase & {
      type: "transcript_create";
      todoId: string;
      title: string;
      dueText: string | null;
      sessionId: string;
      segmentIds: string[];
    })
  | (JarvisKnowledgeActionBase & {
      type: "todo_dismiss";
      todoId: string;
      reasonCode: JarvisKnowledgeDismissReason;
      localNote?: string | null;
    })
  | (JarvisKnowledgeActionBase & {
      type: "todo_restore" | "todo_pin" | "todo_unpin";
      todoId: string;
    })
  | (JarvisKnowledgeActionBase & {
      type: "suggestion_dismiss";
      suggestionId: string;
      reasonCode: JarvisKnowledgeDismissReason;
    })
  | (JarvisKnowledgeActionBase & {
      type: "suggestion_restore" | "suggestion_accept_undo";
      suggestionId: string;
    })
  | (JarvisKnowledgeActionBase & {
      type: "suggestion_accept";
      suggestionId: string;
      todoId: string;
      title: string;
      dueText: string | null;
    })
  | (JarvisKnowledgeActionBase & {
      type: "urgency_set";
      todoId: string;
      urgency: "normal" | "urgent";
    })
  | (JarvisKnowledgeActionBase & {
      type: "title_due_edit";
      todoId: string;
      title?: string;
      dueText?: string | null;
    });

export interface JarvisKnowledgeActionResult {
  status: "applied" | "already_applied";
  commandId: string;
  type: JarvisKnowledgeActionInput["type"];
  entityKind: "todo" | "suggestion";
  entityId: string;
  occurredAt: number;
  todoId: string | null;
}

export interface JarvisAnalysisStatus {
  sessionId: string;
  state:
    | "waiting"
    | "preparing"
    | "queued"
    | "analyzing"
    | "ready"
    | "quota_limited"
    | "retry_needed"
    | "blocked";
  errorCode:
    | "analysis_runtime_not_ready"
    | "analysis_input_empty"
    | "analysis_input_invalid"
    | "analysis_input_state_invalid"
    | "analysis_desired_head_invalid"
    | "analysis_cloud_job_invalid"
    | "analysis_failed"
    | "offline"
    | "budget_exceeded"
    | "usage_unknown"
    | "over_limit"
    | "rate_limit"
    | "invalid_response"
    | null;
  updatedAt: number | null;
}

export interface JarvisMiniMaxConfig {
  keyConfigured: boolean;
  model: "MiniMax-M2.7";
  modelStatus: "not_configured" | "ready" | "unavailable" | "model_unavailable";
  fallbackUsed: boolean;
  checkedAt: number | null;
}

export interface JarvisRolloutFlags {
  applicationAudioV1: boolean;
  dualSpeakerVerificationV1: boolean;
  activityClassificationV1: boolean;
  actionCenterV1: boolean;
}

export type JarvisAnalysisBudgetBlockedReason =
  "disabled" | "budget_exceeded" | "usage_unknown" | "over_limit" | null;

export type JarvisAnalysisBudgetMode = "off" | "capped" | "unlimited";

export interface JarvisAnalysisBudgetStatus {
  mode: JarvisAnalysisBudgetMode;
  monthKey: string;
  timezone: string;
  currency: "USD";
  monthlyLimitMicrousd: number;
  spentMicrousd: number;
  reservedMicrousd: number;
  remainingMicrousd: number | null;
  blockedReason: JarvisAnalysisBudgetBlockedReason;
}

export interface JarvisAnalysisBudgetInput {
  mode: JarvisAnalysisBudgetMode;
  monthlyLimitMicrousd: number;
  timezone: string;
}

export type JarvisResourceGovernanceProfile = "game_priority" | "balanced" | "processing_priority";

export interface JarvisResourceGovernanceSettings {
  profile: JarvisResourceGovernanceProfile;
  externalGpuThresholdPct: number;
  recoveryWaitMs: number;
}

export interface JarvisApplicationAudioSettings {
  enabled: boolean;
  trackLimit: number;
  fallbackPolicy: JarvisApplicationAudioFallbackPolicy;
}

export type JarvisApplicationAudioFallbackPolicy = "conservative" | "transcript_only";

export interface JarvisApplicationAudioRuntimeStatus {
  running: boolean;
  configuredLimit: number;
  effectiveLimit: number;
  fullscreen: boolean;
  activeTracks: Array<{
    applicationKey: string;
    applicationDisplayName: string;
    captureGeneration: number;
    state: "recording";
  }>;
  fallbacks: Array<{
    applicationKey: string;
    applicationDisplayName: string;
    reason: string;
    failureCode: string | null;
    retryAt: number | null;
    state: "mixed_unknown";
  }>;
}

export interface JarvisApplicationAudioStatus extends JarvisApplicationAudioSettings {
  runtime: JarvisApplicationAudioRuntimeStatus;
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
  models?: JarvisVoiceEnrollmentModelStatus[];
}

export type JarvisVoiceEnrollmentOutcome =
  | "accepted"
  | "insufficient_speech"
  | "inconsistent_samples"
  | "unsupported_microphone"
  | "model_error";

export interface JarvisVoiceEnrollmentModelStatus {
  role: "primary" | "review";
  modelId: string;
  embeddingSpace: string;
  enrolled?: boolean;
  acceptedSpeechMs?: number;
  windowCount?: number;
  selfConsistency: number | null;
  updatedAt?: number | null;
}

export interface JarvisVoiceEnrollmentResult {
  status: JarvisVoiceEnrollmentOutcome;
  modelId: string;
  acceptedSpeechMs: number;
  sampleSpeechMs?: number[];
  windowCount: number;
  selfConsistency: number | null;
  models?: JarvisVoiceEnrollmentModelStatus[] | null;
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
  source: {
    kind: "microphone";
    deviceId: string;
    label: string;
  };
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
