export const RECORDING_CONSENT_STORAGE_KEY = "jarvisRecordingConsentVersion";
export const RECORDING_CONSENT_VERSION = "1";

type ConsentStorage = Pick<Storage, "getItem" | "setItem">;

export function hasRecordingConsent(storage: ConsentStorage = localStorage): boolean {
  return storage.getItem(RECORDING_CONSENT_STORAGE_KEY) === RECORDING_CONSENT_VERSION;
}

export function grantRecordingConsent(storage: ConsentStorage = localStorage): void {
  storage.setItem(RECORDING_CONSENT_STORAGE_KEY, RECORDING_CONSENT_VERSION);
}
