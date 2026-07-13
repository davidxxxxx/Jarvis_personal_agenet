const path = require("node:path");

const DataDirectoryMigrator = require("../../../src/jarvis/main/DataDirectoryMigrator");
const DataRootRelocator = require("../../../src/jarvis/main/DataRootRelocator");

const [source, target, journalRoot, crashPoint] = process.argv.slice(2);

const relocator = new DataRootRelocator({
  faultInjector(point) {
    if (point !== crashPoint) return;
    process.send?.({ type: "crash-point", point });
    return new Promise(() => {});
  },
});

const migrator = new DataDirectoryMigrator({
  journalRoot,
  volumeInspector: {
    inspect: async () => ({ kind: "fixed", writable: true, identity: "test-volume" }),
  },
  pathInspector: {
    inspect: async () => ({ reparse: false, mountPoint: false }),
  },
  relocateTarget: ({ oldRoot, newRoot, migrationId, token }) =>
    relocator.relocate({ oldRoot, newRoot, migrationId, token }),
});

migrator.migrate({ from: path.resolve(source), to: path.resolve(target) }).then(
  () => process.exit(0),
  (error) => {
    process.stderr.write(`${error?.stack ?? error}\n`);
    process.exit(1);
  }
);
