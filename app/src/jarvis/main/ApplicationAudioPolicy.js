const DEFAULT_LIMIT = 4;
const MIN_LIMIT = 1;
const MAX_LIMIT = 8;
const FULLSCREEN_LIMIT = 2;

const COMMUNICATION_PATTERN =
  /^(?:kook|discord|teams|microsoft-teams|zoom|skype|wechat|wecom|qq|telegram)$/i;
const BROWSER_OR_LEARNING_PATTERN =
  /^(?:chrome|edge|firefox|brave|opera|vivaldi|obsidian|notion|coursera|udemy)$/i;
const GAME_OR_MEDIA_PATTERN =
  /^(?:dota2|steam|epic-games|battle-net|spotify|vlc|potplayer|foobar2000)$/i;

function boundedInteger(value, fallback) {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(MIN_LIMIT, Math.min(MAX_LIMIT, Math.round(value)));
}

class ApplicationAudioPolicy {
  resolveLimit({ configuredLimit = DEFAULT_LIMIT, fullscreen = false } = {}) {
    const configured = boundedInteger(configuredLimit, DEFAULT_LIMIT);
    return fullscreen ? Math.min(configured, FULLSCREEN_LIMIT) : configured;
  }

  classify(applicationKey) {
    const key = String(applicationKey ?? "");
    if (COMMUNICATION_PATTERN.test(key)) return "communication";
    if (BROWSER_OR_LEARNING_PATTERN.test(key)) return "browser_or_learning";
    if (GAME_OR_MEDIA_PATTERN.test(key)) return "game_or_media";
    return "other";
  }

  score(candidate) {
    const category = this.classify(candidate.applicationKey);
    if (category === "communication") return 400;
    if (candidate.isForeground === true) return 300;
    if (category === "browser_or_learning") return 200;
    if (category === "game_or_media") return 100;
    return 50;
  }

  select(candidates, options = {}) {
    const limit = this.resolveLimit(options);
    return [...candidates]
      .filter(
        (candidate) =>
          candidate?.state === "active" &&
          Number.isSafeInteger(candidate.pid) &&
          candidate.pid > 0 &&
          typeof candidate.applicationKey === "string" &&
          candidate.applicationKey.length > 0
      )
      .sort((left, right) => {
        const scoreDifference = this.score(right) - this.score(left);
        if (scoreDifference !== 0) return scoreDifference;
        const timeDifference = (right.lastSeenAt ?? 0) - (left.lastSeenAt ?? 0);
        if (timeDifference !== 0) return timeDifference;
        return left.applicationKey.localeCompare(right.applicationKey);
      })
      .slice(0, limit);
  }
}

ApplicationAudioPolicy.DEFAULT_LIMIT = DEFAULT_LIMIT;
ApplicationAudioPolicy.MIN_LIMIT = MIN_LIMIT;
ApplicationAudioPolicy.MAX_LIMIT = MAX_LIMIT;
ApplicationAudioPolicy.FULLSCREEN_LIMIT = FULLSCREEN_LIMIT;

module.exports = ApplicationAudioPolicy;
