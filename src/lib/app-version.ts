import { env } from "@/lib/env";

export interface AppUpdateInfo {
  hasUpdate: boolean;
  currentVersion: string;
  latestVersion: string;
  url: string;
  checkedAt?: number;
}

export const APP_UPDATE_CACHE_KEY = "local:app-update-info";
export const APP_UPDATE_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

export function getAppVersion(): string {
  try {
    const manifest = (browser?.runtime?.getManifest?.() as any) ?? {};
    return manifest.version_name || manifest.version || "1.0.6";
  } catch {
    return "1.0.6";
  }
}

export function parseVersion(v: string): { parts: number[]; pre?: string } {
  const clean = v.replace(/^v/i, "").trim();
  const [verPart, ...preRest] = clean.split("-");
  const prePart = preRest.length > 0 ? preRest.join("-") : undefined;
  const parts = verPart.split(".").map((n) => parseInt(n, 10) || 0);
  return { parts, pre: prePart };
}

export function isNewerVersion(latest: string, current: string): boolean {
  if (!latest || !current) return false;
  const l = parseVersion(latest);
  const c = parseVersion(current);
  const maxLen = Math.max(l.parts.length, c.parts.length);
  for (let i = 0; i < maxLen; i++) {
    const lp = l.parts[i] ?? 0;
    const cp = c.parts[i] ?? 0;
    if (lp > cp) return true;
    if (lp < cp) return false;
  }
  // If numeric parts are equal, check pre-release
  // A non-pre-release is newer than a pre-release (e.g. 1.0.0 > 1.0.0-Beta5)
  if (!l.pre && c.pre) return true;
  if (l.pre && !c.pre) return false;
  if (l.pre && c.pre) {
    return (
      l.pre.localeCompare(c.pre, undefined, {
        numeric: true,
        sensitivity: "base",
      }) > 0
    );
  }
  return false;
}

export async function checkAppVersionUpdate(
  force = false,
): Promise<AppUpdateInfo> {
  const currentVersion = getAppVersion();
  const repo =
    env.githubRepo || "https://github.com/mardhianto/libre-manga-translator";
  const defaultUrl = `${repo}/releases/latest`;

  if (!force) {
    try {
      const cached = await storage.getItem<AppUpdateInfo>(APP_UPDATE_CACHE_KEY);
      if (
        cached &&
        typeof cached.checkedAt === "number" &&
        Date.now() - cached.checkedAt < APP_UPDATE_CACHE_TTL_MS &&
        cached.currentVersion === currentVersion
      ) {
        return cached;
      }
    } catch {
      // Ignore cache read error and proceed
    }
  }

  try {
    const res = await fetch(defaultUrl, { method: "HEAD" });
    const finalUrl = res.url || defaultUrl;
    const tag = finalUrl.split("/").pop() || "";
    const fetchedVersion = tag.replace(/^v/i, "");

    const hasUpdate = Boolean(
      fetchedVersion && isNewerVersion(fetchedVersion, currentVersion),
    );
    const result: AppUpdateInfo = {
      hasUpdate,
      currentVersion,
      latestVersion: fetchedVersion || currentVersion,
      url: finalUrl,
      checkedAt: Date.now(),
    };

    try {
      await storage.setItem(APP_UPDATE_CACHE_KEY, result);
    } catch {
      // Storage save is best-effort
    }

    return result;
  } catch (err) {
    console.debug("[app-version] Update check failed:", err);
    try {
      const cached = await storage.getItem<AppUpdateInfo>(APP_UPDATE_CACHE_KEY);
      if (cached && cached.currentVersion === currentVersion) {
        return cached;
      }
    } catch {}

    return {
      hasUpdate: false,
      currentVersion,
      latestVersion: currentVersion,
      url: defaultUrl,
      checkedAt: Date.now(),
    };
  }
}
