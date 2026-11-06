// Centralized env access. All WXT_* vars read here once; use these everywhere.
// Avoids "undefined/releases/latest" and similar from unset vars at call sites.

const metaEnv = ((import.meta as any).env || {}) as Record<string, string | undefined>;

export const env = {
  githubRepo: metaEnv.WXT_GITHUB_REPO || "",

  // Detection models
  rtdetrModelRepo:
    metaEnv.WXT_RTDETR_MODEL_REPO ||
    "ogkalu/comic-text-and-bubble-detector",
  comicTextDetectorUrl:
    metaEnv.WXT_COMIC_TEXT_DETECTOR_URL ||
    "https://github.com/zyddnys/manga-image-translator/releases/download/beta-0.3/comictextdetector.pt.onnx",

  // OCR models
  paddleOCRModelRepo:
    metaEnv.WXT_PADDLE_OCR_MODEL_REPO || "monkt/paddleocr-onnx",
  mangaOCRModelRepo:
    metaEnv.WXT_MANGA_OCR_MODEL_REPO || "mayocream/manga-ocr-onnx",
  ppocrv6MangaRepo:
    metaEnv.WXT_PPOCRV6_MANGA_REPO ||
    "fumetodev/PP-OCRv6_small_rec_manga_ONNX",
  pororoModelRepo:
    metaEnv.WXT_PORORO_MODEL_REPO || "ogkalu/pororo",

  // Inpaint models (dynamic-axes LaMa for WebGPU trial)
  lamaInpaintModelRepo:
    metaEnv.WXT_LAMA_INPAINT_MODEL_REPO || "ogkalu/lama-manga-onnx-dynamic",

  // Script gate model (Apache-2.0)
  gateModelRepo:
    metaEnv.WXT_GATE_MODEL_REPO || "ogkalu/image-script-identification",

  privacyUrl:
    metaEnv.WXT_PRIVACY_URL ||
    "https://libre.mangatl.asia/privacy.md",
};

export const hasGithubRepo = () => !!env.githubRepo;
