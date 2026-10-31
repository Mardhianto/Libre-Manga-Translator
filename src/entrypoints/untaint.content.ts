export default defineContentScript({
  matches: ["<all_urls>"],
  runAt: "document_start",
  world: "MAIN",
  main() {
    // Prevent canvas tainting on canvas-based manga readers (e.g. GigaViewer /
    // Sunday Webry / Shonen Jump+ / Comic Days) whose CDN supports CORS, but
    // whose viewer script creates `new Image()` without setting `crossOrigin`.
    // Includes an automatic one-shot error fallback that strips `crossorigin`
    // and reloads if a server does not send CORS headers.
    try {
      const applyCorsWithFallback = (img: HTMLImageElement, srcVal: string) => {
        if (!srcVal || (img as any).__lmt_no_cors || img.crossOrigin) return;
        try {
          const resolved = new URL(srcVal, window.location.href);
          if (
            (resolved.protocol === "http:" || resolved.protocol === "https:") &&
            resolved.origin !== window.location.origin
          ) {
            img.crossOrigin = "anonymous";
            img.addEventListener(
              "error",
              function onCorsErr() {
                img.removeEventListener("error", onCorsErr);
                if (img.crossOrigin === "anonymous") {
                  (img as any).__lmt_no_cors = true;
                  img.removeAttribute("crossorigin");
                  img.src = srcVal;
                }
              },
              { once: true },
            );
          }
        } catch {
          // Ignore malformed URLs
        }
      };

      const desc = Object.getOwnPropertyDescriptor(
        HTMLImageElement.prototype,
        "src",
      );
      if (desc && desc.set && desc.get) {
        Object.defineProperty(HTMLImageElement.prototype, "src", {
          configurable: true,
          enumerable: desc.enumerable,
          get: desc.get,
          set(val: string) {
            applyCorsWithFallback(this, String(val));
            desc.set!.call(this, val);
          },
        });
      }
    } catch {
      // Never break page execution
    }
  },
});
