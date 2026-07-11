import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog";
import { grantRecordingConsent } from "./recordingConsent";

interface FirstUseConsentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConsent: () => void | Promise<void>;
}

export default function FirstUseConsentDialog({
  open,
  onOpenChange,
  onConsent,
}: FirstUseConsentDialogProps) {
  const { t } = useTranslation();
  const [confirmed, setConfirmed] = useState(false);

  useEffect(() => {
    if (!open) setConfirmed(false);
  }, [open]);

  const confirm = async () => {
    if (!confirmed) return;
    grantRecordingConsent();
    onOpenChange(false);
    await onConsent();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md" aria-describedby="jarvis-consent-description">
        <DialogHeader>
          <DialogTitle>{t("jarvis.consentTitle")}</DialogTitle>
          <DialogDescription id="jarvis-consent-description">
            {t("jarvis.consentDescription")}
          </DialogDescription>
        </DialogHeader>
        <label className="flex items-start gap-3 rounded-lg border border-border/60 bg-muted/30 p-3 text-sm leading-6 text-foreground">
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(event) => setConfirmed(event.target.checked)}
            className="mt-1 size-4 accent-primary"
          />
          <span>{t("jarvis.consentConfirmation")}</span>
        </label>
        <ul className="list-disc space-y-1 pl-5 text-xs leading-5 text-muted-foreground">
          <li>{t("jarvis.consentAudioRetention")}</li>
          <li>{t("jarvis.consentDerivedRetention")}</li>
          <li>{t("jarvis.consentResponsibility")}</li>
        </ul>
        <p className="text-xs leading-5 text-muted-foreground">
          {t("jarvis.visibleIndicatorNote")}
        </p>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {t("jarvis.cancel")}
          </Button>
          <Button type="button" disabled={!confirmed} onClick={() => void confirm()}>
            {t("jarvis.consentConfirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
