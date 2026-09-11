import { useEffect, type RefObject } from "react";

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])',
].join(", ");

function isHidden(element: HTMLElement, container: HTMLElement): boolean {
  let current: HTMLElement | null = element;
  while (current && container.contains(current)) {
    if (
      current.hidden ||
      current.hasAttribute("inert") ||
      current.getAttribute("aria-hidden") === "true"
    ) {
      return true;
    }
    const style = window.getComputedStyle(current);
    if (style.display === "none" || style.visibility === "hidden") return true;
    if (current === container) break;
    current = current.parentElement;
  }
  return false;
}

function focusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (element) => !isHidden(element, container)
  );
}

function isTopmostModal(container: HTMLElement): boolean {
  const dialogs = Array.from(
    document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"]')
  );
  return dialogs.at(-1) === container;
}

interface AccessibleDrawerOptions {
  open: boolean;
  containerRef: RefObject<HTMLElement | null>;
  initialFocusRef?: RefObject<HTMLElement | null>;
  returnFocusRef?: RefObject<HTMLElement | null>;
  onDismiss: () => void;
}

/**
 * Applies modal drawer behavior without changing the drawer's visual layout.
 * Nested dialogs remain authoritative because only the last aria-modal dialog
 * handles Escape and Tab.
 */
export default function useAccessibleDrawer({
  open,
  containerRef,
  initialFocusRef,
  returnFocusRef,
  onDismiss,
}: AccessibleDrawerOptions) {
  useEffect(() => {
    if (!open) return;
    const container = containerRef.current;
    if (!container) return;

    const previousOverflow = document.body.style.overflow;
    const previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const explicitReturnTarget = returnFocusRef?.current ?? null;
    document.body.style.overflow = "hidden";

    const initialFocus = initialFocusRef?.current ?? focusableElements(container)[0] ?? container;
    initialFocus.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (!isTopmostModal(container)) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        onDismiss();
        return;
      }
      if (event.key !== "Tab") return;

      const focusable = focusableElements(container);
      if (focusable.length === 0) {
        event.preventDefault();
        event.stopImmediatePropagation();
        container.focus();
        return;
      }

      const active = document.activeElement as HTMLElement | null;
      const first = focusable[0];
      const last = focusable.at(-1) as HTMLElement;
      const focusIsOutside = active === null || !container.contains(active);
      if (focusIsOutside || (event.shiftKey && active === first)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        (event.shiftKey ? last : first).focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        event.stopImmediatePropagation();
        first.focus();
      }
    };

    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown, true);
      const returnTarget =
        explicitReturnTarget?.isConnected === true ? explicitReturnTarget : previousFocus;
      if (returnTarget?.isConnected) returnTarget.focus();
    };
  }, [containerRef, initialFocusRef, onDismiss, open, returnFocusRef]);
}
