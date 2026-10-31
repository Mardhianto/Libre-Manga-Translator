export type MangaTargetElement = HTMLImageElement | HTMLCanvasElement;

let taintedCanvasCounter = 0;

export function getElementSrc(
  el: MangaTargetElement,
  forceRefresh = false,
): string {
  if (el instanceof HTMLImageElement) return el.src;
  if (el instanceof HTMLCanvasElement) {
    if (!forceRefresh && (el as any).__lmt_src) {
      return (el as any).__lmt_src;
    }
    try {
      const dataUrl = el.toDataURL("image/jpeg", 0.95);
      (el as any).__lmt_src = dataUrl;
      return dataUrl;
    } catch {
      if (!(el as any).__lmt_src) {
        taintedCanvasCounter += 1;
        (el as any).__lmt_src = `canvas://lmt-tainted-${taintedCanvasCounter}-${el.width}x${el.height}`;
      }
      return (el as any).__lmt_src;
    }
  }
  return "";
}

export function imageToBase64(img: MangaTargetElement): string | null {
  try {
    if (img instanceof HTMLCanvasElement) {
      const dataUrl = img.toDataURL("image/jpeg", 0.95);
      if (!(img as any).__lmt_src || String((img as any).__lmt_src).startsWith("data:")) {
        (img as any).__lmt_src = dataUrl;
      }
      return dataUrl;
    }
    const width = img.naturalWidth;
    const height = img.naturalHeight;
    if (!width || !height) return null;

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;

    ctx.fillStyle = "white";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, width, height);

    return canvas.toDataURL("image/jpeg", 0.95);
  } catch {
    return null;
  }
}

export function exportCanvasToJpeg(
  canvas: HTMLCanvasElement,
  quality = 0.85,
  filename?: string,
): void {
  const link = document.createElement("a");
  link.download = filename || `lmt-export-${Date.now()}.jpg`;
  link.href = canvas.toDataURL("image/jpeg", quality);
  document.body.appendChild(link);
  link.click();
  link.remove();
}
