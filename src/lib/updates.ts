import { getVersion } from "@tauri-apps/api/app";
import { appLocalDataDir, join } from "@tauri-apps/api/path";
import { invoke } from "@tauri-apps/api/core";
import { writeFile } from "@tauri-apps/plugin-fs";
import { exit } from "@tauri-apps/plugin-process";

/**
 * In-app update check + one-press install.
 *
 * Releases are published by .github/workflows/release.yml, which auto-bumps a
 * `vMAJOR.MINOR.PATCH` tag and attaches a Windows installer (.exe) + Android APK. The
 * same workflow stamps the bumped version into tauri.conf.json so getVersion() here
 * matches the tag scheme the comparison relies on.
 *
 * "Update" downloads the right asset for the current platform and launches its installer:
 *   - Desktop: download the .exe installer, run it, then exit so it can replace the app.
 *   - Android: download the .apk, stage it in public Downloads via MediaStore, and open
 *     it to trigger the system package installer (Android always shows its own install
 *     confirmation — that step can't be bypassed).
 */

const REPO = "Datulix/csvconv";

export interface ReleaseAsset {
  name: string;
  url: string;
}

export interface UpdateInfo {
  currentVersion: string;
  latestVersion: string;
  hasUpdate: boolean;
  /** GitHub release page — fallback when no matching installer asset is found. */
  releaseUrl: string;
  assets: ReleaseAsset[];
  notes: string | null;
  publishedAt: string | null;
}

export async function checkForUpdate(): Promise<UpdateInfo> {
  const current = await getVersion();
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: { Accept: "application/vnd.github+json" },
  });
  if (!res.ok) {
    throw new Error(`GitHub API responded ${res.status} ${res.statusText}`);
  }
  const data = (await res.json()) as {
    tag_name?: string;
    html_url?: string;
    body?: string | null;
    published_at?: string | null;
    assets?: Array<{ name?: string; browser_download_url?: string }>;
  };
  const latest = String(data.tag_name ?? "").replace(/^v/, "");
  return {
    currentVersion: current,
    latestVersion: latest,
    hasUpdate: latest !== "" && compareSemver(latest, current) > 0,
    releaseUrl: data.html_url ?? `https://github.com/${REPO}/releases/latest`,
    assets: (data.assets ?? [])
      .filter((a) => a.name && a.browser_download_url)
      .map((a) => ({ name: a.name as string, url: a.browser_download_url as string })),
    notes: data.body ?? null,
    publishedAt: data.published_at ?? null,
  };
}

export type UpdateKind = "android" | "desktop";

export function platformKind(): UpdateKind {
  if (typeof navigator !== "undefined" && /android/i.test(navigator.userAgent)) {
    return "android";
  }
  return "desktop";
}

/** Pick the installer asset for the current platform, or null if the release has none. */
function pickAsset(info: UpdateInfo, kind: UpdateKind): ReleaseAsset | null {
  const byExt = (ext: string) =>
    info.assets.find((a) => a.name.toLowerCase().endsWith(ext)) ?? null;
  if (kind === "android") return byExt(".apk");
  // Desktop: prefer the NSIS setup .exe, fall back to MSI / other bundle formats.
  return byExt(".exe") ?? byExt(".msi") ?? byExt(".dmg") ?? byExt(".appimage");
}

async function downloadBytes(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed: ${res.status} ${res.statusText}`);
  return new Uint8Array(await res.arrayBuffer());
}

/**
 * Download and launch the installer for the running platform. Calls `onStatus` with
 * human-readable progress. Throws if no matching asset is found (caller can fall back to
 * opening the release page).
 */
export async function performUpdate(
  info: UpdateInfo,
  onStatus: (msg: string) => void = () => {},
): Promise<void> {
  const kind = platformKind();
  const asset = pickAsset(info, kind);
  if (!asset) {
    throw new Error(
      `No ${kind === "android" ? "APK" : "installer"} found in release v${info.latestVersion}.`,
    );
  }

  onStatus(`Downloading v${info.latestVersion}…`);
  const bytes = await downloadBytes(asset.url);
  const dir = await appLocalDataDir();
  const path = await join(dir, asset.name);
  await writeFile(path, bytes);

  if (kind === "android") {
    onStatus("Opening installer…");
    // Stages the APK into public Downloads and launches the system package installer.
    await invoke("save_apk_to_downloads", { apkPath: path });
    onStatus("Follow the Android prompt to finish installing.");
    return;
  }

  // Desktop: run the installer, then exit so it can overwrite the running app.
  onStatus("Launching installer…");
  await invoke("open_installer", { path });
  onStatus("Closing csvconv so the installer can finish…");
  setTimeout(() => {
    void exit(0);
  }, 1500);
}

/** Compare `a` vs `b` as dotted numeric versions. Returns 1 / 0 / -1. */
function compareSemver(a: string, b: string): number {
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}
