# Changelog

## v1.0.4 — November 2026

Firefox compatibility enhancements, canvas support for manga readers, improved overlay interaction, and reliability fixes across the translation pipeline.

### Added

- **Canvas-based manga reader support:** Native support for canvas-based readers with proper event handling and text wrapping fixes (Sunday Webry)
- **Free-dragging toolbars:** Interactive drag handles on result toolbars positioned at bottom-left corner for customizable workspace layout
- **Improved LLM model management:** Enhanced caching and download management in setup wizard with better progress tracking
- **Automatic config save:** Configuration automatically saved on component destruction (popup and sidebar) to prevent data loss
- **GPU denylist test coverage:** Strengthened documentation tests for GPU compatibility verification

### Changed

- **Translation registry improvements:** Refined concurrency handling in content scripts for more stable multi-page operations
- **Overlay hover mapping:** Enhanced positioning and mapping logic for floating trigger components
- **Text fit algorithms:** Improved line wrapping for CJK characters in canvas-rendered content
- **Model select UI:** Firefox-specific adjustments for model selection dropdown behavior
- **Offscreen document messaging:** Optimized background communication patterns for cross-origin contexts

### Fixed

- **ORT concurrency issues:** Fixed ONNX Runtime thread pool conflicts in canvas environments
- **Site adapters:** Updated Sunday Webry adapter with proper selector and event handling
- **Bubble editor interactions:** Improved retranslation functionality with toast feedback
- **Configuration persistence:** Ensured LLM model selections are correctly saved during setup wizard flow
- **Event propagation:** Proper cleanup of overlay events to prevent double-triggering in content scripts

### Technical

- Added `untaint.content.ts` for safer canvas manipulation and DOM integrity preservation
- Enhanced export utilities with improved canvas-to-JPEG conversion
- Upgraded detection main module with refined concurrency controls
- Streamlined OCR engine interfaces (Paddle, Pororo, Manga-OCR) for consistent error handling
- Improved debug panel visibility and debugging capabilities

This release includes first contributions from @justoy via PR #7.

## v1.0.3 — October 24, 2026

API Mode runner presets, sliding-window detection tiling for tall webtoons, Firefox 2GB streaming fix, and pipeline hardening across OCR, inpainting, and Gemini key transport.

### Added

- **API Mode runner presets:** 8 pre-configured local LLM runners in setup (Ollama, LM Studio, JAN, Unsloth Desktop, llama.cpp, KoboldCpp, LocalAI, Cherry Studio) plus Custom option, auto-populating host, port, schema, and collapsible markdown setup instructions.
- **Detection tiling for webtoons/manhwa:** sliding-window tiling for tall images (>1500px) with IoU and containment-based bubble deduplication, preventing memory exhaustion and duplicate boxes on 10,000+ px pages.
- **Mock LLM test server & schema validators:** deterministic mock HTTP test server for CI/endpoint tests and strict translation validators with count-mismatch auto-healing.
- **Measured inpaint logging:** per-cluster inpainting execution time tracking and provenance reporting in debug logs.

### Changed

- Renamed **WebGPU Mode** UI display label to **Local Mode** across popup, sidebar, and docs to accurately reflect WASM CPU fallbacks for denylisted models (internal storage key remains `webgpu`).
- Moved Gemini API key transport from URL query parameters to the `x-goog-api-key` HTTP header, preventing exposure in server and proxy request logs.
- Preserved finished LaMa inpaint patches on quality fallback, routing only uncovered regions to the Fast ladder without re-cleaning painted areas.
- Standardized `slotIndex` positional tracking across PaddleOCR and Pororo OCR engines.
- `scalingImage` now accepts `CanvasImageSource` directly to avoid redundant blob encoding.

### Fixed

- Fixed Firefox GGUF download crash on models >2GB by switching from Uint8Array buffer accumulation to Blob streaming ([Issue #6](https://github.com/mrdhnto/libre-manga-translator/issues/6)).
- Fixed cache size calculation for streaming downloads to fall back to `Blob.size` when the `content-length` header is missing.
- Fixed RT-DETR detection preprocessing aspect ratio handling to eliminate image squashing on non-square crops.

## v1.0.2 — October 17, 2026

Download control release: every model weight is now opt-in with pause/resume everywhere, plus OCR hardening and overlay polish.

### Added

- **Central resumable download manager:** all ONNX weight downloads are owned by the background service worker (`DOWNLOAD_START` / `PAUSE` / `DISCARD`, live `MODEL_DOWNLOAD_PROGRESS` to popup, sidebar, and setup). Pause in one UI and resume in another; starting a new download auto-pauses the active one without losing progress.
- **Single-button download control:** model dropdowns and the LaMa card use one Download ⇄ Pause / Resume toggle with per-row progress and paused badges.
- **Opt-in onboarding:** the setup wizard never auto-downloads — each step waits for an explicit press, with Pause / Resume / Stop on every weight (LLM weights use Start / Stop).
- **Home quick-toggle gating:** popup Home Inpaint/Detector buttons only switch to a target whose weights are cached, with an inline hint otherwise.
- **LaMa missing-weights guard:** translating with Quality selected but weights absent skips the neural pass (no silent re-download, no error) and switches the option back to Fast automatically.
- **Box move handle:** overlay boxes gain a dedicated move handle alongside improved Translate pill behavior.
- **New Site Adapters** RAWKuma and KLManga site is added to the lineup.

### Changed

- Selecting Quality inpainting no longer auto-starts the LaMa download; it waits for an explicit press.
- Inference queue replaced by a FIFO task runner with dead-letter isolation, so one failed job never stalls the pipeline.
- Deleting a cached model also discards any retained partial download, so the next fetch starts from scratch.
- Bumped `@mlc-ai/web-llm` to `^0.2.86`.
- Updated local WebLLM model lineup: replaced Gemma3-1B with Llama-3.2-1B (~880 MB) to avoid sliding-window configuration errors, and introduced ultra-compact `Qwen3.5-0.8B` (~1.6 GB) alongside Qwen3.5-2B and 4B ([Issue #5](https://github.com/mrdhnto/libre-manga-translator/issues/5)).

### Fixed

- Fixed paused downloads caching truncated files: streams ending short of the advertised length are never stored and report a resumable error instead.
- Fixed the dropdown Pause button sticking on the pause icon instead of flipping to Resume.
- Fixed sidebar download progress freezing at 0% (progress broadcasts are now fanned out to content-script tabs).
- Fixed ONNX session/resource disposal and error handling across OCR, detection, and script-gate paths.
- Improved Pororo OCR line slicing and overlay click-event isolation.
- Fixed WebLLM engine initialization and sliding-window crashes via centralized `createLlmEngine` constructor with chat option overrides ([Issue #5](https://github.com/mrdhnto/libre-manga-translator/issues/5)).
- Added `normalizeLlmModel` fallback across popup, sidebar, and translation runtime so deprecated stored model IDs safely fall back to the default model.

## v1.0.1 — October 5, 2026

Maintenance and feature release introducing dedicated Korean OCR support, an interactive multi-layer visual canvas editor, always-inpaint controls, and other code improvements.

### Added

- **Pororo OCR engine:** Korean specialist engine (~74 MB ONNX, Kakao Brain TPS-VGG-BiLSTM-CTC architecture with 2,589-character vocabulary) optimized for Manhwa and Webtoon text extraction.
- **Always Inpaint toggle:** `sync:always-inpaint` setting in popup and sidebar to force text removal even when quality checks decline, preventing leftover raw text on complex artwork.
- **Multi-Layer Visual Canvas Editor:** Interactive in-place overlay editor supporting seamless switching across **Raw Scan**, **Cleaned Scan** (inpainted background), and **Result Scan** layers.
- **Inpaint Patch & Restore tools:** Interactive drawing tools (`InpaintCanvasEditor`) allowing users to paint additional inpaint patches (`add-inpaint`) or restore raw artwork (`restore-raw`) directly onto the cleaned canvas.
- **Contextual Bubble Styling & Raw Text Pill:** On-canvas typography toolbar (`ContextualStyleBar`) for instant font family, size, alignment, and color styling directly on active bubbles, alongside `FloatingRawTextPill` for real-time OCR transcript inspection.
- **Cleaned Scan Caching:** `cleanedSrc` cached in memory (`inpaintedSrcCache`) and persisted in local page cache, enabling fast layer inspection, incremental patch application without re-translating, and multi-layer JPEG export (Raw, Cleaned, Result).

### Changed

- Replaced the standalone text edit modal with the integrated multi-layer canvas editor.
- Refactored font stack resolution (`resolveFontStack`) to properly handle custom font stacks and fallbacks across the overlay editor.
- Refined overlay event isolation to allow full interaction with form controls and text inputs while continuing to block host reader navigation.

### Fixed

- Handled empty OCR boxes and tightened translation schema validation edge cases.
- Fixed overlay box deletion and addition synchronizing with draft translations and source texts.

## v1.0.0 Stable — September 25, 2026

First stable release. Fully on-device translation pipeline with cloud and self-hosted options. And a rework to make UI/UX more seamless.

### Added

- **Three translation modes:** WebGPU (fully local), Gemini (cloud), API Mode (self-hosted Ollama / LM Studio / OpenAI-compatible).
- **Bubble detection:** Comic Bubble Detector RT-DETR (default, bubbles + free text) and Comic Text Detector with pixel-mask seeding.
- **Script gate:** on-device script verification holds back wrong-language regions instead of mistranslating them; every hold-back is one-click overridable with Translate anyway.
- **OCR engines:** PaddleOCR multilingual (11 language packs, auto-switched per page), PP-OCRv6 Manga (lightweight Japanese fine-tune), Manga-OCR (Japanese flagship, vertical text specialist).
- **Inpainting:** Fast ladder (planar fill → denoise → Telea, lightest passing rung wins) and Quality mode (LaMa neural redraw first, Fast fallback per region).
- **Floating Translate pill:** hover any image to translate; becomes an action hub after translation (edit text, adjust boxes, original/translated toggle, JPEG export).
- **Auto-translate:** batch-translate chapter pages as they scroll into view, one page at a time.
- **Site adapters:** automatic series/chapter/page detection for supported readers, plus an AI rule generator for new sites.
- **Series context:** title, summary, and glossary carry across pages so names and terms stay consistent.
- **Bubble editor:** drag, resize, add, delete, undo, redo with manga reading-order numbering.
- **Model Storage:** list, download, update-check, and delete every cached weight from one panel.
- **GPU controls:** master WebGPU switch plus per-area overrides (LLM, inpaint, OCR) with WASM fallback.
- **Debug logs:** local-only session logs with timings, OCR text, translations, and per-region inpaint provenance.
- **Security:** zero telemetry, SSRF-gated image proxy, strict translation schema validation, SHA-256 model verification.
- **Theme:** Obsidian Noir dual-theme (dark + light) with four accent colors.

### Changed

- Detection lineup reduced to two detectors; old stored model selections migrate automatically to the new default.
- WebLLM lineup is now Gemma3-1B, Qwen3.5-2B, and Qwen3.5-4B.
- Model updates are manual via the Model Storage update checker instead of automatic per-model toggles.
- API keys and server settings are stored machine-local so secrets never sync across browser accounts.
- Popup simplified to Home + Settings; sidebar consolidated to Translate / Vision / Render / System.

### Removed

- All telemetry pathways and data-sharing toggles.
- Right-click context menu translation (replaced by the hover pill).
- Legacy single-engine inpainting modes.

## v1.0.0-Beta5 — September 20, 2026

New detection and OCR architectures, LaMa inpainting, model cache controls, and page-index stability.

### Added

- **RT-DETR detector:** Comic Bubble Detector (`comic-bubble`) for speech bubbles and free-text regions.
- **ComicTextDetector:** text-line detection with pixel-level segmentation mask for dense vertical Japanese (`comic-text-detector`).
- **Manga-OCR engine:** `manga-ocr-onnx` optimized for vertical Japanese manga typography.
- **LaMa inpainting:** `lama-manga.onnx` wired into the ladder as high-quality rung with Fast fallback.
- **Model Storage panel:** `ModelStorageSettings.svelte` — inspect cached ONNX weights, sizes, per-model delete; setup wizard gains multi-model downloader with progress.
- **Verification harnesses:** `scripts/ocr-selfcheck.ts`, `scripts/inpaint-selfcheck.ts`.
- **Docs:** `docs/technical.md`, refreshed README with Ollama (`qwen3.5:4b`) / LM Studio (`tiny-aya-global`) guides and new screenshots.

### Changed

- PaddleOCR confidence threshold lowered to `0.70` with improved crop batching.
- Image page resolution via `resolveImagePageIndex` + `quickHash` byte-hash cache keys; overlay box scaling fixed for natural vs rendered dimensions.
- Telemetry / share-data default flipped to opt-in (`false`).
- Default PaddleOCR weights source updated.

### Fixed

- Overlay keyboard input isolation so host reader shortcuts no longer fire while editing.
- Translation cache collisions across dynamic readers.

## v1.0.0-Beta4 — September 16, 2026

Auto inpaint ladder, script verification gate, site-adapter auto-import, and BYOK storage hardening.

### Added

- **Auto inpaint ladder (`Auto` mode, default):** fitted text-shaped masks through Planar Fill → Bilateral Denoise → Telea; decline-metric guard escalates rungs, failed regions left pixel-identical and flagged.
- **Script gate:** on-device OSD LSTM (`ogkalu/image-script-identification`, ~3.7 MB) filters SFX / background lettering / wrong-language text before translation; dashed-amber highlight with **Translate anyway** override; strict CJK mode vs Auto-Detect majority voting.
- **Site adapter auto-import:** `src/lib/adapters/*.ts` auto-loaded; new rules for MangaFire, Comick, WeebCentral, `mgeko.cc`, `comix.to`; `containerSelector` / `imageSelector` schema extension.
- **Self-checks:** `bun run check:inpaint`, `bun run check:gate`; debug panel reports per-rung counts (`fill`, `denoise`, `telea`, `declined`).

### Changed

- Sensitive keys (Gemini API key, server host / model / auth) migrated from `sync` to `local` storage with startup backward-compatible migration; `privacy.md` reconciled.
- Detection post-processing: deterministic YOLO box merging, speckle-drop, reading-order sort with directional growth.
- README / privacy updates including KoMiQ Manga Cleaner attribution.

## v1.0.0-Beta3 — September 1, 2026

Compatibility fix for click-to-next-page readers plus branding and docs.

### Fixed

- Overlay events (`click`, `drag`, pointer, touch) trapped with `stopPropagation`; native `<a>`-wrapped images also `preventDefault` so editing no longer flips pages or scrolls the reader.
- Drag in-flight guard: mouse move/up during box drag/resize no longer reaches page listeners.

### Changed

- README branded header (centered icon + shields), roadmap reworked into Released / In Progress / Known Issues / Planned, data-sharing wording clarified to original image URL + adjusted coordinates only.

## v1.0.0-Beta2 — August 30, 2026

Readability polish, CSP reliability fix, and visual showcase.

### Added

- Background telemetry relay (`SEND_TELEMETRY`) + `sync:share-data` toggle — note: later purged entirely in v1.0.0 Phase 1.
- Centralized env accessor `src/lib/env.ts` (`privacyUrl`).
- README showcase: setup wizard, live editor, Telea vs Fast, raw OCR + debug panel screenshots under `docs/images/`.

### Changed

- Custom scrollbar styling (`.custom-scrollbar`) unified across sidebar, DebugPanel, and text areas.
- Sidebar header uses extension icon (`/icon/48.png`); added to `web_accessible_resources`.
- Edit modal padding increased; overlay box delete / clear preserves manual sort order (`isManuallySorted = true`).

### Fixed

- Telemetry / series-context fetches routed via background messaging to bypass strict-site CSP fetch blocking.

## v1.0.0-Beta1 — August 30, 2026

Initial public release. Private alpha → public beta.

### Added

- **Three-way pipeline:** WebGPU local (YOLO26 detection + PaddleOCR + Qwen3 4B/8B via WebLLM), Gemini cloud (annotated-image direct), API Mode self-hosted (Ollama / LM Studio / OpenAI-compatible, text-only payloads, OpenAI + LM Studio schemas).
- **Pure-JS Telea inpainting:** MV3-CSP-safe fast-marching engine (`src/lib/inpaint/telea.ts`); Telea / Fast toggle; `inpaintedSrcCache` for instant re-render on edit.
- **Sidebar + setup:** on-page sliding `lmt-sidebar` panel, 3-card onboarding wizard, shared popup/sidebar settings.
- **Editor + export:** raw OCR surfacing per bubble, in-place edit modal, drag/resize/add/delete with undo/redo, full-res JPEG export.
- **Image pipeline:** `PROXY_IMAGE` declarativeNetRequest `Referer` injection for anti-hotlink CDNs, `sniffMime` (JPEG/PNG/WebP/GIF/AVIF), `fetchAsImageBitmap`.
- **Observability:** 50-entry ring-buffer debug log (`local:debug-logs`) with backend, OCR text, translations, per-step timings; JSON export / clipboard copy.
