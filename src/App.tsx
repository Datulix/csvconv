import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { getVersion } from "@tauri-apps/api/app";
import { checkForUpdate, performUpdate, type UpdateInfo } from "./lib/updates";
import { Settings } from "./components/Settings";
import { SchemaEditor } from "./components/SchemaEditor";
import { NewConversion } from "./components/NewConversion";
import { ReviewTable } from "./components/ReviewTable";
import { History } from "./components/History";
import { PipelineDebugger } from "./components/PipelineDebugger";
import "./App.css";

type View = "convert" | "schemas" | "review" | "history" | "debug" | "settings";

interface NavItem {
  id: View;
  label: string;
  icon: string;
}

// Dev-only tooling: visible under `tauri dev`, stripped from any production `vite build`
// (which is what GitHub Actions runs to ship).
const SHOW_DEBUG = import.meta.env.DEV;

const NAV: NavItem[] = [
  { id: "convert", label: "New conversion", icon: "▶" },
  { id: "schemas", label: "Schemas", icon: "≡" },
  { id: "review", label: "Review", icon: "◐" },
  { id: "history", label: "History", icon: "↶" },
  ...(SHOW_DEBUG ? [{ id: "debug" as const, label: "Debug", icon: "" }] : []),
  { id: "settings", label: "Settings", icon: "⚙" },
];

function App() {
  const [view, setView] = useState<View>("convert");
  const [reviewCacheKey, setReviewCacheKey] = useState<string | null>(null);
  const [appVersion, setAppVersion] = useState<string | null>(null);
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [updating, setUpdating] = useState(false);
  const [updateStatus, setUpdateStatus] = useState<string>("");

  useEffect(() => {
    // Step 20: clean up staging dirs older than 7 days on app start.
    (async () => {
      try {
        const removed = await invoke<number>("cleanup_old_staging", { maxAgeDays: 7 });
        if (removed > 0) console.info(`csvconv: cleaned up ${removed} stale staging dirs`);
      } catch (err) {
        console.warn("staging cleanup failed (non-fatal)", err);
      }
    })();
    // Report the real installed version and check GitHub for a newer release (best-effort).
    (async () => {
      try {
        setAppVersion(await getVersion());
      } catch (err) {
        console.warn("could not read app version", err);
      }
      try {
        const info = await checkForUpdate();
        if (info.hasUpdate) setUpdate(info);
      } catch (err) {
        console.warn("update check failed (non-fatal)", err);
      }
    })();
  }, []);

  function openInReview(cacheKey: string) {
    setReviewCacheKey(cacheKey);
    setView("review");
  }

  async function handleUpdate() {
    if (!update || updating) return;
    setUpdating(true);
    try {
      await performUpdate(update, setUpdateStatus);
    } catch (err) {
      // Couldn't auto-install — open the release page so the user can grab it manually.
      console.warn("update failed, opening release page", err);
      await openUrl(update.releaseUrl);
    } finally {
      setUpdating(false);
      setUpdateStatus("");
    }
  }

  return (
    <div className="app-layout">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">cc</span>
          <span className="brand-name">csvconv</span>
        </div>
        <nav className="sidebar-nav">
          {NAV.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`nav-item ${view === item.id ? "active" : ""}`}
              onClick={() => setView(item.id)}
            >
              <span className="nav-icon">{item.icon}</span>
              <span>{item.label}</span>
            </button>
          ))}
        </nav>
        <div className="sidebar-footer">
          <span className="version">
            v{appVersion ?? "0.1.0"}
            {SHOW_DEBUG ? " · dev" : ""}
          </span>
          {update?.hasUpdate ? (
            <button
              type="button"
              className="update-badge"
              title={`Version ${update.latestVersion} is available — click to update`}
              onClick={handleUpdate}
              disabled={updating}
            >
              {updating
                ? updateStatus || `Updating to v${update.latestVersion}…`
                : `● Update to v${update.latestVersion}`}
            </button>
          ) : null}
        </div>
      </aside>
      <main className="main-content">
        <div
          className="new-conversion-wrapper"
          style={{ display: view === "convert" ? "flex" : "none" }}
        >
          <NewConversion onOpenInReview={openInReview} active={view === "convert"} />
        </div>
        {view === "schemas" && <SchemaEditor />}
        {view === "review" && <ReviewTable cacheKey={reviewCacheKey} />}
        {view === "history" && <History onOpenRun={openInReview} />}
        {SHOW_DEBUG && view === "debug" && <PipelineDebugger />}
        {view === "settings" && <Settings />}
      </main>
      {/* Bottom navigation — hidden on desktop via CSS, shown on mobile */}
      <nav className="bottom-nav">
        {NAV.map((item) => (
          <button
            key={item.id}
            type="button"
            className={`bottom-nav-item ${view === item.id ? "active" : ""}`}
            onClick={() => setView(item.id)}
          >
            <span className="bottom-nav-icon">{item.icon}</span>
            <span>{item.label}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}

export default App;
