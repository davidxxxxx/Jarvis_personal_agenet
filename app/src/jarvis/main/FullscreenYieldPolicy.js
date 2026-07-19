function resolveFullscreenYieldActive(snapshot, previousYieldActive = false) {
  return (
    snapshot?.fullscreenActivityActive === true ||
    (previousYieldActive === true && snapshot?.reason === "recovery_hysteresis")
  );
}

module.exports = { resolveFullscreenYieldActive };
