import { beforeEach, describe, expect, it } from "bun:test";
import {
  parseVersion,
  isNewerVersion,
  checkAppVersionUpdate,
  APP_UPDATE_CACHE_KEY,
  APP_UPDATE_CACHE_TTL_MS,
  type AppUpdateInfo,
} from "../../src/lib/app-version";

function installFakeStorage() {
  const map = new Map<string, unknown>();
  const fakeStorage = {
    async getItem<T>(key: string): Promise<T | null> {
      return (map.has(key) ? (map.get(key) as T) : null);
    },
    async setItem(key: string, value: unknown) {
      map.set(key, value);
    },
    async removeItems(keys: string[]) {
      for (const k of keys) map.delete(k);
    },
    _map: map,
  };
  (globalThis as any).storage = fakeStorage;
  return fakeStorage;
}

describe("parseVersion", () => {
  it("parses clean semver numbers", () => {
    expect(parseVersion("1.0.6")).toEqual({ parts: [1, 0, 6], pre: undefined });
    expect(parseVersion("v2.1.0")).toEqual({ parts: [2, 1, 0], pre: undefined });
    expect(parseVersion("0.1")).toEqual({ parts: [0, 1], pre: undefined });
  });

  it("extracts pre-release identifier", () => {
    expect(parseVersion("1.0.0-Beta5")).toEqual({ parts: [1, 0, 0], pre: "Beta5" });
    expect(parseVersion("v1.2.3-alpha.1")).toEqual({ parts: [1, 2, 3], pre: "alpha.1" });
  });
});

describe("isNewerVersion", () => {
  it("detects newer major, minor, and patch", () => {
    expect(isNewerVersion("2.0.0", "1.0.6")).toBe(true);
    expect(isNewerVersion("1.1.0", "1.0.6")).toBe(true);
    expect(isNewerVersion("1.0.7", "1.0.6")).toBe(true);
  });

  it("handles 'v' prefixes transparently", () => {
    expect(isNewerVersion("v1.0.7", "1.0.6")).toBe(true);
    expect(isNewerVersion("1.0.7", "v1.0.6")).toBe(true);
    expect(isNewerVersion("v1.0.7", "v1.0.6")).toBe(true);
  });

  it("rejects older and equal versions", () => {
    expect(isNewerVersion("1.0.5", "1.0.6")).toBe(false);
    expect(isNewerVersion("1.0.6", "1.0.6")).toBe(false);
    expect(isNewerVersion("0.9.9", "1.0.0")).toBe(false);
  });

  it("handles pre-release comparison correctly", () => {
    // Official release is newer than pre-release of same base
    expect(isNewerVersion("1.0.0", "1.0.0-Beta5")).toBe(true);
    expect(isNewerVersion("1.0.0-Beta5", "1.0.0")).toBe(false);

    // Later pre-release is newer
    expect(isNewerVersion("1.0.0-Beta6", "1.0.0-Beta5")).toBe(true);
    expect(isNewerVersion("1.0.0-Beta4", "1.0.0-Beta5")).toBe(false);
  });

  it("handles empty or malformed inputs safely", () => {
    expect(isNewerVersion("", "1.0.6")).toBe(false);
    expect(isNewerVersion("1.0.6", "")).toBe(false);
  });
});

describe("checkAppVersionUpdate", () => {
  let fakeStorage: ReturnType<typeof installFakeStorage>;

  beforeEach(() => {
    fakeStorage = installFakeStorage();
    (globalThis as any).browser = {
      runtime: {
        getManifest: () => ({ version: "1.0.6", version_name: "1.0.6" }),
      },
    };
  });

  it("returns cached update info when fresh", async () => {
    const cached: AppUpdateInfo = {
      hasUpdate: true,
      currentVersion: "1.0.6",
      latestVersion: "1.0.7",
      url: "https://github.com/mardhianto/libre-manga-translator/releases/tag/v1.0.7",
      checkedAt: Date.now() - 5000,
    };
    await fakeStorage.setItem(APP_UPDATE_CACHE_KEY, cached);

    const result = await checkAppVersionUpdate(false);
    expect(result.hasUpdate).toBe(true);
    expect(result.latestVersion).toBe("1.0.7");
  });

  it("bypasses stale cache when TTL expired", async () => {
    const stale: AppUpdateInfo = {
      hasUpdate: false,
      currentVersion: "1.0.6",
      latestVersion: "1.0.6",
      url: "https://github.com/mardhianto/libre-manga-translator/releases/tag/v1.0.6",
      checkedAt: Date.now() - (APP_UPDATE_CACHE_TTL_MS + 10000),
    };
    await fakeStorage.setItem(APP_UPDATE_CACHE_KEY, stale);

    // Mock fetch to simulate GitHub release redirect to v1.0.8
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => ({
      url: "https://github.com/mardhianto/libre-manga-translator/releases/tag/v1.0.8",
      ok: true,
    })) as any;

    try {
      const result = await checkAppVersionUpdate(false);
      expect(result.hasUpdate).toBe(true);
      expect(result.latestVersion).toBe("1.0.8");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("bypasses cache when force is true", async () => {
    const fresh: AppUpdateInfo = {
      hasUpdate: false,
      currentVersion: "1.0.6",
      latestVersion: "1.0.6",
      url: "https://github.com/mardhianto/libre-manga-translator/releases/tag/v1.0.6",
      checkedAt: Date.now(),
    };
    await fakeStorage.setItem(APP_UPDATE_CACHE_KEY, fresh);

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => ({
      url: "https://github.com/mardhianto/libre-manga-translator/releases/tag/v1.0.9",
      ok: true,
    })) as any;

    try {
      const result = await checkAppVersionUpdate(true);
      expect(result.hasUpdate).toBe(true);
      expect(result.latestVersion).toBe("1.0.9");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
