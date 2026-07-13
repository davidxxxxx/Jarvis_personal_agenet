class MigrationCoordinator {
  constructor({ providers = [] } = {}) {
    if (!Array.isArray(providers)) throw new TypeError("providers must be an array");
    this.providers = [];
    this.active = false;
    for (const provider of providers) this.register(provider);
  }

  register(provider) {
    if (!provider || typeof provider !== "object" || typeof provider.name !== "string") {
      throw new TypeError("migration provider must have a name");
    }
    for (const method of ["quiesce", "close", "reopen", "rollback", "resume"]) {
      if (typeof provider[method] !== "function") {
        throw new TypeError(`migration provider ${provider.name} must provide ${method}`);
      }
    }
    if (this.providers.some((entry) => entry.name === provider.name)) {
      throw new Error(`migration provider already registered: ${provider.name}`);
    }
    this.providers.push(provider);
    return () => {
      const index = this.providers.indexOf(provider);
      if (index >= 0) this.providers.splice(index, 1);
    };
  }

  assertProducerAllowed() {
    if (!this.active) return;
    const error = new Error("storage migration in progress");
    error.code = "STORAGE_MIGRATION_IN_PROGRESS";
    throw error;
  }

  async runExclusive(operation, { previousRoot } = {}) {
    if (typeof operation !== "function") throw new TypeError("migration operation is required");
    if (this.active) throw new Error("migration already in progress");
    this.active = true;
    const providers = [...this.providers];
    let rollbackComplete = false;
    const rollbackProviders = async (root) => {
      if (rollbackComplete) return;
      const errors = [];
      for (const provider of [...providers].reverse()) {
        try {
          await provider.rollback(root);
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length > 0) throw new AggregateError(errors, "migration provider rollback failed");
      rollbackComplete = true;
    };
    const lease = {
      reopen: async (root, rollbackRoot) => {
        void rollbackRoot;
        for (const provider of providers) {
          await provider.reopen(root);
        }
      },
      rollback: rollbackProviders,
    };

    let result;
    let operationError = null;
    try {
      for (const provider of providers) await provider.quiesce();
      for (const provider of providers) await provider.close();
      result = await operation(lease);
    } catch (error) {
      operationError = error;
      try {
        await rollbackProviders(previousRoot);
      } catch (rollbackError) {
        operationError = new AggregateError(
          [operationError, rollbackError],
          "migration operation and rollback failed"
        );
      }
    }

    const resumeErrors = [];
    for (const provider of [...providers].reverse()) {
      try {
        await provider.resume();
      } catch (error) {
        resumeErrors.push(error);
      }
    }
    this.active = false;
    if (resumeErrors.length > 0) {
      if (operationError) resumeErrors.unshift(operationError);
      throw new AggregateError(resumeErrors, "migration provider resume failed");
    }
    if (operationError) throw operationError;
    return result;
  }
}

module.exports = MigrationCoordinator;
