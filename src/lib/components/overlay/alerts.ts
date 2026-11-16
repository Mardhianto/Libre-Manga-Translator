/**
 * Document-level alert channel (LMT-034).
 *
 * The error dialog used to be rendered *inside* the per-page overlay, which
 * lives inside the page's own layout. Two things then conspired to make
 * "Dismiss" unclickable on canvas readers:
 *
 *   1. `Overlay.svelte` copied its `z-index` onto `wrapper.parentElement` — a
 *      page-owned node — turning the reader's own layout element into a
 *      stacking context and letting a neighbouring page's transparent tap
 *      layer sit above the dialog.
 *   2. The dialog was the only way out (`ERROR_AUTOCLOSE` is off and Escape was
 *      scoped to the overlay's own event path), so a single missed click
 *      stranded the page.
 *
 * Alerts therefore live in their own shadow root, mounted on `<body>` with a
 * viewport-fixed, `pointer-events: none` host. Nothing in the page can stack
 * above it, and the host blocks nothing while no alert is open.
 */

export type AlertKind = "error" | "warn" | "info";

export interface OverlayAlert {
  id: string;
  message: string;
  kind: AlertKind;
  /**
   * A later attempt could plausibly succeed (rate limit, overload, socket
   * reset). Only then is offering "Retry" honest — a bad API key is not.
   */
  transient: boolean;
  /** Runs after the alert closes; the host dismisses itself first. */
  onRetry?: () => void;
  onDismiss?: () => void;
  /** Overrides the default "Dismiss" label. */
  dismissLabel?: string;
}

export interface OverlayNotice {
  id: string;
  message: string;
  kind: "info" | "success" | "warn" | "error";
  /** Milliseconds before auto-dismiss; `0` keeps it until dismissed. */
  durationMs: number;
}

interface AlertState {
  alert: OverlayAlert | null;
  notices: OverlayNotice[];
}

const listeners = new Set<(state: AlertState) => void>();

let state: AlertState = { alert: null, notices: [] };

function emit() {
  for (const listener of listeners) listener(state);
}

export function subscribeAlerts(
  listener: (state: AlertState) => void,
): () => void {
  listeners.add(listener);
  listener(state);
  return () => listeners.delete(listener);
}

export function getAlertState(): AlertState {
  return state;
}

/** True while a blocking alert is open; other UI uses this to defer to it. */
export function isAlertOpen(): boolean {
  return state.alert !== null;
}

/**
 * Show the single blocking alert. A newer alert replaces an older one: two
 * stacked error dialogs is how the old per-page model produced N modals for N
 * failed pages.
 */
export function showAlert(alert: OverlayAlert): void {
  state = { ...state, alert };
  emit();
}

export function dismissAlert(id?: string): void {
  if (!state.alert) return;
  if (id && state.alert.id !== id) return;
  state = { ...state, alert: null };
  emit();
}

/**
 * Dismiss whatever is open and run its `onDismiss`. Used by the Escape
 * fallback, which must not hold a stale reference to the alert object.
 */
export function dismissActiveAlert(): void {
  const current = state.alert;
  if (!current) return;
  dismissAlert(current.id);
  current.onDismiss?.();
}

export function dismissAllAlerts(): void {
  if (state.alert) {
    state = { ...state, alert: null };
    emit();
  }
}

let noticeSeq = 0;

/**
 * Non-blocking notification. Used by the auto-translate queue so a failed page
 * never spawns a modal the user has to hunt for while the reader advances.
 */
export function pushNotice(
  message: string,
  kind: OverlayNotice["kind"] = "info",
  durationMs = 6000,
): string {
  const id = `notice-${++noticeSeq}`;
  state = {
    ...state,
    notices: [...state.notices, { id, message, kind, durationMs }],
  };
  emit();
  return id;
}

export function dismissNotice(id: string): void {
  const next = state.notices.filter((n) => n.id !== id);
  if (next.length === state.notices.length) return;
  state = { ...state, notices: next };
  emit();
}
