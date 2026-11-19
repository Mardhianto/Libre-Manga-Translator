import "@/assets/app.css";
import { handleOffscreenMessage } from "@/lib/inference";

// Thin listener: all inference lives in lib/inference.ts. On Chrome this
// runs in the offscreen document; on Firefox it runs in the hidden
// background iframe (ensureFirefoxInferencePage).
browser.runtime.onMessage.addListener(handleOffscreenMessage);
