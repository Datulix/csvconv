import { useEffect, useState } from "react";
import { listRuns, purgeAllCache, type SqliteRunRecord } from "../lib/sqliteCache";
import { invoke } from "@tauri-apps/api/core";

interface HistoryProps {
  onOpenRun: (cacheKey: string) => void;
}

export function History({ onOpenRun }: HistoryProps) {
  const [runs, setRuns] = useState<SqliteRunRecord[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    refresh();
  }, []);

  async function refresh() {
    setLoading(true);
    try {
      const list = await listRuns();
      setRuns(list);
    } catch (err) {
      console.error("listRuns failed", err);
    } finally {
      setLoading(false);
    }
  }

  async function handlePurgeRun(cacheKey: string) {
    if (!confirm("Purge this run's cache? Rows and batches will be deleted; PDFs themselves are not touched.")) return;
    await invoke("cache_purge_run", { cacheKey });
    await refresh();
  }

  async function handleClearAll() {
    if (!confirm("Clear ALL cached runs? This deletes every cached row, batch, and run record.")) return;
    await purgeAllCache();
    await refresh();
  }

  return (
    <div className="history-view">
      <header className="history-header">
        <h1>History</h1>
        <div className="history-actions">
          <button className="btn-secondary small" onClick={refresh}>refresh</button>
          <button className="btn-danger small" onClick={handleClearAll}>
            clear all cache
          </button>
        </div>
      </header>
      {loading ? <p className="hint">Loading…</p> : null}
      {!loading && runs.length === 0 ? (
        <p className="hint">
          No runs yet. Run a conversion from the <strong>New conversion</strong> tab. Completed
          runs are cached so re-exports don't re-hit the API.
        </p>
      ) : null}
      {runs.length > 0 ? (
        <ul className="history-list">
          {runs.map((r) => (
            <li key={r.cache_key}>
              <button className="history-row" onClick={() => onOpenRun(r.cache_key)}>
                <div className="history-row-main">
                  <span className="history-mode">{r.mode ?? "?"}</span>
                  <span className="history-content-type">{r.content_type ?? "?"}</span>
                  {r.confirmed_format ? (
                    <span className="chip">{r.confirmed_format}</span>
                  ) : null}
                  <span className={`chip state-${r.state ?? "unknown"}`}>{r.state ?? "?"}</span>
                </div>
                <div className="history-row-meta">
                  <span title="cache key" className="hash">#{r.cache_key.slice(0, 10)}</span>
                  {r.started_at ? (
                    <span className="hint">started {formatTime(r.started_at)}</span>
                  ) : null}
                  {r.finished_at ? (
                    <span className="hint">finished {formatTime(r.finished_at)}</span>
                  ) : null}
                </div>
              </button>
              <button
                className="btn-icon"
                title="Purge this run"
                onClick={() => handlePurgeRun(r.cache_key)}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString();
  } catch {
    return iso;
  }
}
