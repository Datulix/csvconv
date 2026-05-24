import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Settings } from "./components/Settings";
import { SchemaEditor } from "./components/SchemaEditor";
import { NewConversion } from "./components/NewConversion";
import { ReviewTable } from "./components/ReviewTable";
import { History } from "./components/History";
import "./App.css";

type View = "convert" | "schemas" | "review" | "history" | "settings";

interface NavItem {
  id: View;
  label: string;
  icon: string;
}

const NAV: NavItem[] = [
  { id: "convert", label: "New conversion", icon: "▶" },
  { id: "schemas", label: "Schemas", icon: "≡" },
  { id: "review", label: "Review", icon: "◐" },
  { id: "history", label: "History", icon: "↶" },
  { id: "settings", label: "Settings", icon: "⚙" },
];

function App() {
  const [view, setView] = useState<View>("convert");
  const [reviewCacheKey, setReviewCacheKey] = useState<string | null>(null);

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
  }, []);

  function openInReview(cacheKey: string) {
    setReviewCacheKey(cacheKey);
    setView("review");
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
          <span className="version">v0.1.0 · dev</span>
        </div>
      </aside>
      <main className="main-content">
        {view === "convert" ? (
          <NewConversion onOpenInReview={openInReview} />
        ) : view === "schemas" ? (
          <SchemaEditor />
        ) : view === "review" ? (
          <ReviewTable cacheKey={reviewCacheKey} />
        ) : view === "history" ? (
          <History onOpenRun={openInReview} />
        ) : (
          <Settings />
        )}
      </main>
    </div>
  );
}

export default App;
