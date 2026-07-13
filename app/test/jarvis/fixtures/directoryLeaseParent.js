const { DirectoryLeaseProvider } = require("../../../src/jarvis/main/DirectoryLease");

void new DirectoryLeaseProvider()
  .acquire(process.argv[2])
  .then((lease) => {
    process.send?.({ identity: lease.identity });
    setInterval(() => lease.assertActive(), 1_000).unref();
  })
  .catch((error) => {
    process.send?.({ error: error.message });
    process.exitCode = 1;
  });
