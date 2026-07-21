import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Fingerprint, ShieldCheck, UserRound, UsersRound } from "lucide-react";
import type {
  JarvisPersonDetail,
  JarvisPersonOverview,
  JarvisSpeakerCorrectionScope,
  JarvisSpeakerLinkState,
} from "../types";
import { useJarvisStore } from "./jarvisStore";

const PROFILE_SOURCE_KEYS = {
  enrollment: "jarvis.peopleProfileSourceEnrollment",
  user_confirmed: "jarvis.peopleProfileSourceUserConfirmed",
} as const;

const LINK_STATE_KEYS: Record<JarvisSpeakerLinkState, string> = {
  unknown: "jarvis.peopleLinkStateUnknown",
  suggested: "jarvis.peopleLinkStateSuggested",
  confirmed: "jarvis.peopleLinkStateConfirmed",
  rejected: "jarvis.peopleLinkStateRejected",
};

const CORRECTION_SCOPE_KEYS: Record<JarvisSpeakerCorrectionScope, string> = {
  session: "jarvis.peopleCorrectionScopeSession",
  persistent: "jarvis.peopleCorrectionScopePersistent",
};

const CORRECTION_ACTOR_KEYS = {
  user: "jarvis.peopleCorrectionActorUser",
  system: "jarvis.peopleCorrectionActorSystem",
} as const;

const CORRECTION_KIND_KEYS = {
  link: "jarvis.peopleCorrectionKindLink",
  merge: "jarvis.peopleCorrectionKindMerge",
} as const;

function identityDate(at: number): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(at);
}

function personName(
  person: Pick<JarvisPersonOverview, "is_self" | "display_name">,
  selfLabel: string
): string {
  return person.is_self ? selfLabel : person.display_name;
}

export default function PeopleView() {
  const { t } = useTranslation();
  const mergePeople = useJarvisStore((state) => state.mergePeople);
  const [people, setPeople] = useState<JarvisPersonOverview[]>([]);
  const [detail, setDetail] = useState<JarvisPersonDetail | null>(null);
  const [mergeTargetId, setMergeTargetId] = useState("");
  const [reviewingMerge, setReviewingMerge] = useState(false);
  const [mergeBusy, setMergeBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshOverview = async () => {
    setPeople(await window.electronAPI.jarvis.listPeopleOverview());
  };

  useEffect(() => {
    void refreshOverview().catch(() => setError(t("jarvis.peopleLoadFailed")));
  }, [t]);

  const open = async (id: string) => {
    setError(null);
    setMergeTargetId("");
    setReviewingMerge(false);
    try {
      setDetail(await window.electronAPI.jarvis.getPersonDetail(id));
    } catch {
      setError(t("jarvis.peopleLoadFailed"));
    }
  };

  const source = detail?.person ?? null;
  const target = people.find((person) => person.id === mergeTargetId) ?? null;
  const selfLabel = t("jarvis.speakerSelf");
  const confirmedSourceCount =
    detail?.identity.appearances.filter((appearance) => appearance.linkState === "confirmed")
      .length ?? 0;
  const suggestedSourceCount =
    detail?.identity.appearances.filter((appearance) => appearance.linkState === "suggested")
      .length ?? 0;
  const attributedMemories = detail
    ? detail.memories.filter((memory) => memory.person_id === detail.person.id)
    : [];

  const commitMerge = async () => {
    if (!source || !target || source.is_self || mergeBusy) return;
    setMergeBusy(true);
    setError(null);
    try {
      const nextDetail = await mergePeople(source.id, target.id);
      setDetail(nextDetail);
      setMergeTargetId("");
      setReviewingMerge(false);
      await refreshOverview();
    } catch {
      setError(t("jarvis.peopleMergeFailed"));
    } finally {
      setMergeBusy(false);
    }
  };

  return (
    <main className="jarvis-scroll-region min-w-0 overflow-y-scroll p-6 lg:col-span-2">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">人物 People</h1>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
            这里显示你本人和高置信度确认过的长期人物。没有确认的声音会继续保留为匿名说话人。
          </p>
        </div>
        <span className="rounded-full bg-primary/10 px-3 py-1 text-xs font-medium text-primary">
          {people.length} 个长期人物
        </span>
      </header>

      <section className="mt-5 grid gap-3 rounded-xl border border-border/50 bg-card p-4 md:grid-cols-3">
        <div className="flex gap-3">
          <UsersRound className="mt-0.5 size-5 shrink-0 text-primary" aria-hidden="true" />
          <div>
            <p className="text-sm font-medium">先区分会话内说话人</p>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              相似声音会聚成“说话人 1、说话人 2”，不是每个片段都算一个人。
            </p>
          </div>
        </div>
        <div className="flex gap-3">
          <Fingerprint className="mt-0.5 size-5 shrink-0 text-primary" aria-hidden="true" />
          <div>
            <p className="text-sm font-medium">再匹配本人和历史人物</p>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              CAM++ 与 ERes2NetV2 都通过时，才会关联到 SELF 或匿名人物。
            </p>
          </div>
        </div>
        <div className="flex gap-3">
          <ShieldCheck className="mt-0.5 size-5 shrink-0 text-primary" aria-hidden="true" />
          <div>
            <p className="text-sm font-medium">不确定就不强认</p>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              回声、多人重叠、视频声音和低置信度匹配不会更新长期人物声纹。
            </p>
          </div>
        </div>
      </section>
      {error && <p className="mt-4 text-sm text-destructive">{error}</p>}
      <div className="mt-6 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {people.map((person) => (
          <button
            type="button"
            key={person.id}
            onClick={() => void open(person.id)}
            className="rounded-xl border border-border/50 bg-card p-4 text-left hover:border-primary/40"
          >
            <div className="flex items-center gap-3">
              <span className="grid size-10 place-items-center rounded-full bg-primary/10 text-primary">
                <UserRound className="size-5" aria-hidden="true" />
              </span>
              <div>
                <p className="font-medium">
                  {personName(person, selfLabel)}
                  {person.is_self && (
                    <span className="ml-2 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] text-primary">
                      SELF
                    </span>
                  )}
                </p>
                <p className="text-xs text-muted-foreground">
                  已确认会话 {person.session_count} · 未完成待办 {person.open_todo_count}
                </p>
              </div>
            </div>
          </button>
        ))}
      </div>
      {!people.length && !error && (
        <div className="mt-6 rounded-xl border border-dashed border-border p-10 text-center">
          <UsersRound className="mx-auto size-8 text-muted-foreground" aria-hidden="true" />
          <p className="mt-3 font-medium">还没有确认的长期人物</p>
          <p className="mt-1 text-sm text-muted-foreground">
            会话里的匿名说话人只有经过双模型高置信度匹配或由你命名后，才会出现在这里。
          </p>
        </div>
      )}
      {detail && (
        <section className="mt-6 rounded-xl border border-border/50 bg-card p-5">
          <div className="flex justify-between gap-4">
            <h2 className="text-lg font-semibold">{personName(detail.person, selfLabel)}</h2>
            <button
              type="button"
              onClick={() => setDetail(null)}
              className="text-xs text-muted-foreground"
            >
              {t("jarvis.peopleClose")}
            </button>
          </div>
          <div className="mt-4 grid gap-4 md:grid-cols-3">
            <div>
              <p className="text-xs text-muted-foreground">{t("jarvis.peopleSessions")}</p>
              <p className="mt-1 text-xl font-semibold">{detail.sessions.length}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">{t("jarvis.peopleTopics")}</p>
              <p className="mt-1 text-xl font-semibold">{detail.topics.length}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">{t("jarvis.peopleOpenTodos")}</p>
              <p className="mt-1 text-xl font-semibold">
                {detail.todos.filter((todo) => todo.status === "open").length}
              </p>
            </div>
          </div>
          <section className="mt-5 rounded-lg border border-border/50 bg-muted/20 p-4">
            <h3 className="text-sm font-semibold">
              {t("jarvis.peoplePersistentSourceSummary", {
                defaultValue: "Persistent source summary / 持久来源摘要",
              })}
            </h3>
            <p className="mt-1 text-xs text-muted-foreground">
              {t("jarvis.peoplePersistentSourceSummaryDescription", {
                defaultValue:
                  "Only durably attributed sources are counted / 只统计已持久归属给此人物的会话、说话人关联和记忆。",
              })}
            </p>
            <dl className="mt-3 grid gap-3 sm:grid-cols-3">
              <div>
                <dt className="sr-only">
                  {t("jarvis.peopleConfirmedSources", {
                    defaultValue: "Confirmed speaker sources",
                  })}
                </dt>
                <dd className="text-sm font-medium">
                  {t("jarvis.peopleConfirmedSourceCount", {
                    count: confirmedSourceCount,
                    defaultValue:
                      confirmedSourceCount === 1
                        ? "{{count}} confirmed speaker source / 条已确认说话来源"
                        : "{{count}} confirmed speaker sources / 条已确认说话来源",
                  })}
                </dd>
              </div>
              <div>
                <dt className="sr-only">
                  {t("jarvis.peopleSuggestedSources", {
                    defaultValue: "Suggested speaker matches",
                  })}
                </dt>
                <dd className="text-sm font-medium">
                  {t("jarvis.peopleSuggestedSourceCount", {
                    count: suggestedSourceCount,
                    defaultValue:
                      suggestedSourceCount === 1
                        ? "{{count}} suggested match (not confirmed) / 条建议匹配（尚未确认）"
                        : "{{count}} suggested matches (not confirmed) / 条建议匹配（尚未确认）",
                  })}
                </dd>
              </div>
              <div>
                <dt className="sr-only">
                  {t("jarvis.peopleSavedMemories", { defaultValue: "Saved memories" })}
                </dt>
                <dd className="text-sm font-medium">
                  {t("jarvis.peopleSavedMemoryCount", {
                    count: attributedMemories.length,
                    defaultValue:
                      attributedMemories.length === 1
                        ? "{{count}} saved memory / 条已保存记忆"
                        : "{{count}} saved memories / 条已保存记忆",
                  })}
                </dd>
              </div>
            </dl>
            {attributedMemories.length > 0 && (
              <ul className="mt-4 space-y-2">
                {attributedMemories.map((memory) => (
                  <li key={memory.id} className="rounded-lg bg-background/70 p-3 text-sm">
                    <p>{memory.content}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {t("jarvis.peopleSupportingOccurrenceCount", {
                        count: memory.occurrence_count,
                        defaultValue:
                          memory.occurrence_count === 1
                            ? "{{count}} supporting occurrence / 条支持记录"
                            : "{{count}} supporting occurrences / 条支持记录",
                      })}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <details className="mt-5 rounded-lg border border-border/50 p-4">
            <summary className="cursor-pointer text-sm font-semibold">声纹与识别详情</summary>
            <p className="mt-2 text-xs text-muted-foreground">
              这里是模型样本、出现记录和人工纠错等高级信息，日常使用不需要查看。
            </p>
            <div className="mt-4 grid gap-4 lg:grid-cols-3">
            <section>
              <h3 className="text-sm font-semibold">{t("jarvis.peopleSamples")}</h3>
              <ul className="mt-2 space-y-2 text-xs text-muted-foreground">
                {detail.identity.samples.map((sample) => (
                  <li key={sample.id} className="rounded-lg bg-muted/30 p-3">
                    <span className="block font-medium text-foreground">{sample.modelId}</span>
                    {sample.speechMs.toLocaleString()} ms · {sample.windowCount} windows ·{" "}
                    {t(PROFILE_SOURCE_KEYS[sample.sourceKind])}
                  </li>
                ))}
              </ul>
            </section>
            <section>
              <h3 className="text-sm font-semibold">{t("jarvis.peopleAppearances")}</h3>
              <ul className="mt-2 space-y-2 text-xs text-muted-foreground">
                {detail.identity.appearances.map((appearance) => (
                  <li key={appearance.clusterId} className="rounded-lg bg-muted/30 p-3">
                    <span className="block font-medium text-foreground">
                      {appearance.sessionId}
                    </span>
                    {appearance.localLabel} · {t(LINK_STATE_KEYS[appearance.linkState])}
                  </li>
                ))}
              </ul>
            </section>
            <section>
              <h3 className="text-sm font-semibold">{t("jarvis.peopleCorrections")}</h3>
              <ul className="mt-2 space-y-2 text-xs text-muted-foreground">
                {detail.identity.corrections.map((correction) => (
                  <li key={correction.id} className="rounded-lg bg-muted/30 p-3">
                    <span className="block font-medium text-foreground">
                      {t(LINK_STATE_KEYS[correction.previousState])} →{" "}
                      {t(LINK_STATE_KEYS[correction.nextState])}
                    </span>
                    <span className="block">
                      {t(CORRECTION_SCOPE_KEYS[correction.scope])} ·{" "}
                      {t(CORRECTION_ACTOR_KEYS[correction.actor])} ·{" "}
                      {t(CORRECTION_KIND_KEYS[correction.correctionKind])}
                    </span>
                    <span className="block">
                      {t("jarvis.peopleCorrectionCreated", {
                        date: identityDate(correction.createdAt),
                      })}
                    </span>
                    <span className="block">
                      {correction.undoneAt === null
                        ? t("jarvis.peopleCorrectionActive")
                        : t("jarvis.peopleCorrectionUndone", {
                            date: identityDate(correction.undoneAt),
                          })}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
            </div>
          </details>
          {!detail.person.is_self && (
            <details className="mt-4 rounded-lg border border-border/50 p-4">
              <summary className="cursor-pointer text-sm font-semibold">人物管理（高级）</summary>
              <section className="mt-4">
              <label className="block text-sm font-medium" htmlFor="people-merge-target">
                {t("jarvis.peopleMergeInto")}
              </label>
              <select
                id="people-merge-target"
                aria-label={t("jarvis.peopleMergeInto")}
                value={mergeTargetId}
                onChange={(event) => {
                  setMergeTargetId(event.target.value);
                  setReviewingMerge(false);
                }}
                className="mt-2 h-9 w-full max-w-sm rounded-md border border-border bg-background px-2 text-sm"
              >
                <option value="">{t("jarvis.speakerChoosePerson")}</option>
                {people
                  .filter((person) => person.id !== detail.person.id)
                  .map((person) => (
                    <option key={person.id} value={person.id}>
                      {personName(person, selfLabel)}
                    </option>
                  ))}
              </select>
              <button
                type="button"
                disabled={!target || mergeBusy}
                onClick={() => setReviewingMerge(true)}
                className="ml-2 rounded-lg border border-border px-3 py-2 text-sm disabled:opacity-50"
              >
                {t("jarvis.peopleReviewMerge")}
              </button>
              {reviewingMerge && target && (
                <div className="mt-4 rounded-lg border border-destructive/30 bg-destructive/5 p-4">
                  <p className="text-sm">
                    {t("jarvis.peopleMergeWarning", {
                      source: personName(detail.person, selfLabel),
                      target: personName(target, selfLabel),
                    })}
                  </p>
                  <div className="mt-3 flex gap-2">
                    <button
                      type="button"
                      disabled={mergeBusy}
                      onClick={() => setReviewingMerge(false)}
                      className="rounded-lg border border-border px-3 py-2 text-sm"
                    >
                      {t("jarvis.cancel")}
                    </button>
                    <button
                      type="button"
                      disabled={mergeBusy}
                      onClick={() => void commitMerge()}
                      className="rounded-lg bg-destructive px-3 py-2 text-sm text-destructive-foreground"
                    >
                      {t("jarvis.peopleMerge")}
                    </button>
                  </div>
                </div>
              )}
              </section>
            </details>
          )}
        </section>
      )}
    </main>
  );
}
