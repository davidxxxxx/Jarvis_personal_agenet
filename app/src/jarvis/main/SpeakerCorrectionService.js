const crypto = require("node:crypto");

const { assertId } = require("../shared/contracts");

const CONFIRM_KEYS = new Set(["clusterId", "personId", "newPersonName", "scope"]);
const SCOPES = new Set(["session", "persistent"]);
const MAX_NAME_CODE_POINTS = 80;

function assertPlainObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be a plain object`);
  }
  return value;
}

function assertExactKeys(value, allowed, name) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new TypeError(`${name} contains unknown key: ${key}`);
  }
}

function normalizePersonDisplayName(value) {
  if (typeof value !== "string") throw new TypeError("new person name must be a string");
  const display = value.trim().replace(/\s+/gu, " ");
  if (!display) throw new TypeError("new person name must not be empty");
  if (Array.from(display).length > MAX_NAME_CODE_POINTS) {
    throw new RangeError("new person name must contain at most 80 Unicode code points");
  }
  return display;
}

function normalizedPersonNameComparison(value) {
  return value.trim().replace(/\s+/gu, " ").normalize("NFKC").toLowerCase();
}

function personSummary(person) {
  return {
    id: person.id,
    displayName: person.display_name,
    isSelf: person.is_self === 1,
  };
}

function projectCorrection(correction) {
  return {
    id: correction.id,
    clusterId: correction.clusterId,
    previousPersonId: correction.previousPersonId,
    nextPersonId: correction.nextPersonId,
    previousPersonRef: correction.previousPersonRef,
    nextPersonRef: correction.nextPersonRef,
    previousState: correction.previousState,
    nextState: correction.nextState,
    scope: correction.scope,
    actor: correction.actor,
    correctionKind: correction.correctionKind,
    createdAt: correction.createdAt,
    undoneAt: correction.undoneAt,
  };
}

class SpeakerCorrectionService {
  constructor({ repository, createPersonId, now = Date.now } = {}) {
    const requiredMethods = [
      "runSpeakerCorrectionTransaction",
      "getSpeakerClusterView",
      "listSessionSpeakerClusterViews",
      "listPeople",
      "renamePerson",
      "confirmSpeakerLinkWithOutcome",
      "rejectSpeakerSuggestion",
      "undoSpeakerCorrection",
      "mergeSpeakerPeople",
      "listSpeakerCorrections",
      "getPersonDetail",
    ];
    if (!repository || requiredMethods.some((method) => typeof repository[method] !== "function")) {
      throw new TypeError("repository must provide speaker correction capabilities");
    }
    if (createPersonId !== undefined && typeof createPersonId !== "function") {
      throw new TypeError("createPersonId must be a function");
    }
    if (typeof now !== "function") throw new TypeError("now must be a function");
    this.repository = repository;
    this.createPersonId =
      createPersonId ?? (() => `person_${crypto.randomUUID().replaceAll("-", "")}`);
    this.now = now;
  }

  listSessionClusters(sessionId) {
    return this.repository.listSessionSpeakerClusterViews(assertId(sessionId, "sessionId"));
  }

  confirm(input) {
    assertPlainObject(input, "confirmation input");
    assertExactKeys(input, CONFIRM_KEYS, "confirmation input");
    const clusterId = assertId(input.clusterId, "clusterId");
    if (!SCOPES.has(input.scope)) throw new TypeError("invalid speaker correction scope");
    const hasPersonId = Object.prototype.hasOwnProperty.call(input, "personId");
    const hasNewPersonName = Object.prototype.hasOwnProperty.call(input, "newPersonName");
    if (hasPersonId === hasNewPersonName) {
      throw new TypeError("confirmation must provide exactly one target");
    }
    const personId = hasPersonId ? assertId(input.personId, "personId") : null;
    const displayName = hasNewPersonName ? normalizePersonDisplayName(input.newPersonName) : null;

    return this.repository.runSpeakerCorrectionTransaction(() => {
      let targetPersonId = personId;
      let createdPerson = false;
      if (displayName !== null) {
        const comparison = normalizedPersonNameComparison(displayName);
        const matches = this.repository
          .listPeople()
          .filter((person) => normalizedPersonNameComparison(person.display_name) === comparison);
        if (matches.length > 1) {
          const error = new Error("ambiguous duplicate person name");
          error.code = "ambiguous_duplicate_name";
          error.candidates = matches.map(personSummary);
          throw error;
        }
        if (matches.length === 1) {
          targetPersonId = matches[0].id;
        } else {
          targetPersonId = assertId(this.createPersonId(), "createdPersonId");
          this.repository.renamePerson({ personId: targetPersonId, displayName });
          createdPerson = true;
        }
      }
      const outcome = this.repository.confirmSpeakerLinkWithOutcome({
        clusterId,
        personId: targetPersonId,
        scope: input.scope,
        actor: "user",
      });
      return {
        cluster: this.repository.getSpeakerClusterView(clusterId),
        profileSampleAdded: outcome.profileSampleAdded,
        profileSampleReason: outcome.profileSampleReason,
        createdPerson,
      };
    });
  }

  reject(clusterId, personId) {
    const safeClusterId = assertId(clusterId, "clusterId");
    const safePersonId = assertId(personId, "personId");
    return this.repository.runSpeakerCorrectionTransaction(() => {
      const current = this.repository.getSpeakerClusterView(safeClusterId);
      if (
        !current ||
        current.linkState !== "suggested" ||
        current.suggestedPerson?.id !== safePersonId
      ) {
        throw new Error("rejection must target the current suggestion");
      }
      this.repository.rejectSpeakerSuggestion({
        clusterId: safeClusterId,
        personId: safePersonId,
        scope: "session",
        actor: "user",
      });
      return this.repository.getSpeakerClusterView(safeClusterId);
    });
  }

  undo(clusterId) {
    const safeClusterId = assertId(clusterId, "clusterId");
    return this.repository.runSpeakerCorrectionTransaction(() => {
      const current = this.repository.getSpeakerClusterView(safeClusterId);
      if (!current?.canUndo) throw new Error("cluster has no undoable link correction");
      this.repository.undoSpeakerCorrection(safeClusterId);
      return this.repository.getSpeakerClusterView(safeClusterId);
    });
  }

  listCorrections(clusterId) {
    return this.repository
      .listSpeakerCorrections(assertId(clusterId, "clusterId"))
      .map(projectCorrection);
  }

  mergePeople(sourcePersonId, targetPersonId) {
    const sourceId = assertId(sourcePersonId, "sourcePersonId");
    const targetId = assertId(targetPersonId, "targetPersonId");
    if (sourceId === targetId) throw new TypeError("source and target people must be different");
    return this.repository.runSpeakerCorrectionTransaction(() => {
      const people = this.repository.listPeople();
      const source = people.find((person) => person.id === sourceId);
      const target = people.find((person) => person.id === targetId);
      if (!source || !target) throw new Error("source or target person not found");
      if (source.is_self === 1) throw new Error("self person cannot be merged");
      this.repository.mergeSpeakerPeople({
        sourcePersonId: sourceId,
        targetPersonId: targetId,
        actor: "user",
      });
      return this.repository.getPersonDetail(targetId);
    });
  }

  getPersonIdentityDetail(personId) {
    return this.repository.getPersonDetail(assertId(personId, "personId"));
  }
}

module.exports = SpeakerCorrectionService;
module.exports.normalizePersonDisplayName = normalizePersonDisplayName;
module.exports.normalizedPersonNameComparison = normalizedPersonNameComparison;
