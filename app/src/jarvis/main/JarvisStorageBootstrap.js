const fs = require("node:fs");
const path = require("node:path");
const DataDirectoryMigrator = require("./DataDirectoryMigrator");
const DataRootRelocator = require("./DataRootRelocator");
const MigrationCoordinator = require("./MigrationCoordinator");
const { adoptLegacyDatabaseSync, copyLegacyTreeSync } = require("./recordingStorage");

function assertAbsolute(value, name) {
  if (typeof value !== "string" || !path.isAbsolute(value)) {
    throw new TypeError(`${name} must be absolute`);
  }
  return path.resolve(value);
}

async function adoptLegacyStorage({
  legacyDatabasePath,
  databasePath,
  legacyRecordingsRoot,
  recordingsRoot,
  fsImpl = fs,
  relocator = new DataRootRelocator(),
} = {}) {
  const legacyDb = assertAbsolute(legacyDatabasePath, "legacyDatabasePath");
  const targetDb = assertAbsolute(databasePath, "databasePath");
  const legacyRecordings = assertAbsolute(legacyRecordingsRoot, "legacyRecordingsRoot");
  const targetRecordings = assertAbsolute(recordingsRoot, "recordingsRoot");
  let databaseAdopted = false;

  if (legacyDb !== targetDb && fsImpl.existsSync(legacyDb) && !fsImpl.existsSync(targetDb)) {
    adoptLegacyDatabaseSync({ from: legacyDb, to: targetDb, fsImpl });
    databaseAdopted = true;
  }
  if (legacyRecordings === targetRecordings || !fsImpl.existsSync(legacyRecordings)) {
    return { databaseAdopted, databaseLocators: 0, recoverySidecars: 0 };
  }
  copyLegacyTreeSync({ from: legacyRecordings, to: targetRecordings, fsImpl });
  if (!fsImpl.existsSync(targetDb)) {
    return { databaseAdopted, databaseLocators: 0, recoverySidecars: 0 };
  }
  const relocated = await relocator.relocateRecordings({
    databasePath: targetDb,
    oldRecordingsRoot: legacyRecordings,
    newRecordingsRoot: targetRecordings,
  });
  return { databaseAdopted, ...relocated };
}

function createUnifiedRootWriterProvider({ getManagers } = {}) {
  if (typeof getManagers !== "function") throw new TypeError("getManagers is required");
  const managers = () => {
    const entries = getManagers();
    if (!Array.isArray(entries)) throw new TypeError("unified-root managers must be an array");
    return entries.map((entry) => entry?.manager ?? entry).filter(Boolean);
  };
  return {
    name: "unified-root-writers",
    async quiesce() {
      for (const manager of managers()) {
        if (typeof manager.quiesce === "function") await manager.quiesce();
        else if (typeof manager.cancelDownload === "function") await manager.cancelDownload();
      }
    },
    async close() {},
    async reopen() {},
    async rollback() {},
    async resume() {
      for (const manager of managers()) {
        if (typeof manager.resume === "function") await manager.resume();
      }
    },
  };
}

function createProductionStorageComposition({
  userDataDir,
  dataRootConfig,
  getManagers,
  migrationCoordinator = new MigrationCoordinator(),
  journalRoot,
  relocateTarget = ({ oldRoot, newRoot, migrationId, token }) =>
    new DataRootRelocator().relocate({ oldRoot, newRoot, migrationId, token }),
  persistRoot = async () => {},
  onProgress,
  migratorOptions = {},
} = {}) {
  const safeUserDataDir = assertAbsolute(userDataDir, "userDataDir");
  if (
    !dataRootConfig ||
    ["beginActivation", "markActivationPhase", "save", "recoverActivation"].some(
      (method) => typeof dataRootConfig[method] !== "function"
    )
  ) {
    throw new TypeError("dataRootConfig must provide the activation journal interface");
  }
  if (!migrationCoordinator || typeof migrationCoordinator.register !== "function") {
    throw new TypeError("migrationCoordinator is required");
  }
  const safeJournalRoot = journalRoot
    ? assertAbsolute(journalRoot, "journalRoot")
    : path.join(safeUserDataDir, "jarvis-migration-journal");
  const startupMigrationValidator = new DataDirectoryMigrator({
    ...migratorOptions,
    journalRoot: safeJournalRoot,
  });
  const writerProvider = createUnifiedRootWriterProvider({ getManagers });
  const dataDirectoryMigrator = new DataDirectoryMigrator({
    ...migratorOptions,
    migrationCoordinator,
    journalRoot: safeJournalRoot,
    activationJournal: {
      begin: (state) => dataRootConfig.beginActivation(state),
      mark: (phase) => dataRootConfig.markActivationPhase(phase),
      finalize: (root) => dataRootConfig.save(root),
      rollback: (root) => dataRootConfig.save(root),
    },
    persistRoot,
    relocateTarget,
    onProgress,
  });
  let writerProviderRegistered = false;
  return {
    migrationCoordinator,
    startupMigrationValidator,
    dataDirectoryMigrator,
    writerProvider,
    recoverActivation: () =>
      dataRootConfig.recoverActivation((candidate, state) =>
        startupMigrationValidator.validateActivationTarget(candidate, state)
      ),
    registerWriterProvider() {
      if (writerProviderRegistered) return;
      migrationCoordinator.register(writerProvider);
      writerProviderRegistered = true;
    },
  };
}

module.exports = {
  adoptLegacyStorage,
  createProductionStorageComposition,
  createUnifiedRootWriterProvider,
};
