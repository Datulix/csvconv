import { useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { SUPPORTED_MODELS, STAGES, type ModelId, type PipelineStage } from "../lib/models";
import {
  AppSettings,
  DEFAULT_SETTINGS,
  loadSettings,
  saveSettings,
  setApiKey,
  getApiKey,
  deleteApiKey,
  setPaidTierAck,
  getPaidTierAck,
} from "../lib/settings";

type SaveState = "idle" | "saving" | "saved" | "error";

const PAID_TIER_LEARN_URL = "https://ai.google.dev/gemini-api/docs/pricing";
const PRICING_DOCS_URL = "https://ai.google.dev/gemini-api/docs/pricing";

export function Settings() {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [apiKey, setApiKeyState] = useState<string>("");
  const [apiKeyStored, setApiKeyStored] = useState<boolean>(false);
  const [paidAck, setPaidAck] = useState<boolean>(false);
  const [showPrivacyDetails, setShowPrivacyDetails] = useState<boolean>(true);
  const [showAdvanced, setShowAdvanced] = useState<boolean>(false);
  const [revealKey, setRevealKey] = useState<boolean>(false);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [saveError, setSaveError] = useState<string>("");

  useEffect(() => {
    (async () => {
      try {
        const [s, key, ack] = await Promise.all([
          loadSettings(),
          getApiKey(),
          getPaidTierAck(),
        ]);
        setSettings(s);
        if (key) {
          setApiKeyState(key);
          setApiKeyStored(true);
        }
        setPaidAck(ack);
        if (ack || !!key) setShowPrivacyDetails(false);
      } catch (err) {
        console.error("failed to load initial state", err);
      }
    })();
  }, []);

  function setStage(stage: PipelineStage, value: ModelId | null) {
    setSettings((s) => ({ ...s, [`${stage}_model`]: value } as AppSettings));
  }

  async function handleSaveAll() {
    setSaveState("saving");
    setSaveError("");
    try {
      if (apiKey.trim()) {
        await setApiKey(apiKey.trim());
        setApiKeyStored(true);
      }
      await saveSettings(settings);
      setSaveState("saved");
      setTimeout(() => setSaveState("idle"), 2000);
    } catch (err) {
      setSaveState("error");
      setSaveError(String(err));
    }
  }

  async function handleAcknowledge(usingPaidTier: boolean) {
    try {
      await setPaidTierAck(usingPaidTier);
      setPaidAck(usingPaidTier);
      setShowPrivacyDetails(false);
    } catch (err) {
      console.error("failed to save paid tier ack", err);
    }
  }

  async function handleDeleteKey() {
    try {
      await deleteApiKey();
      setApiKeyState("");
      setApiKeyStored(false);
    } catch (err) {
      console.error("failed to delete API key", err);
    }
  }

  const keyEntryUnlocked = !showPrivacyDetails;

  return (
    <div className="settings">
      <h1>csvconv settings</h1>

      <section className="card">
        <h2>Google AI Studio API key</h2>
        {showPrivacyDetails ? (
          <div className="privacy-warning">
            <div className="warning-icon">⚠️</div>
            <div className="warning-body">
              <h3>Privacy notice</h3>
              <p>
                On the <strong>free tier</strong> of the Google AI Studio API, Google may use your
                API inputs and outputs to improve their models. If you're processing copyrighted
                exam content, proprietary materials, or anything sensitive, use a{" "}
                <strong>paid tier</strong> key instead — paid-tier traffic is excluded from
                training.
              </p>
              <div className="warning-actions">
                <button
                  className="btn-link"
                  type="button"
                  onClick={() => openUrl(PAID_TIER_LEARN_URL)}
                >
                  Learn more →
                </button>
                <button
                  className="btn-secondary"
                  type="button"
                  onClick={() => handleAcknowledge(true)}
                >
                  I have a paid-tier key
                </button>
                <button
                  className="btn-primary"
                  type="button"
                  onClick={() => handleAcknowledge(false)}
                >
                  Continue with free tier
                </button>
              </div>
            </div>
          </div>
        ) : (
          <div className="privacy-banner">
            <span className="badge">{paidAck ? "paid tier" : "free tier"}</span>
            <button
              type="button"
              className="btn-link"
              onClick={() => setShowPrivacyDetails(true)}
            >
              show privacy details
            </button>
          </div>
        )}

        <div className={`field ${keyEntryUnlocked ? "" : "disabled"}`}>
          <label htmlFor="api-key">API key</label>
          <div className="key-row">
            <input
              id="api-key"
              type={revealKey ? "text" : "password"}
              value={apiKey}
              onChange={(e) => setApiKeyState(e.target.value)}
              placeholder="paste your Google AI Studio key here"
              autoComplete="off"
              spellCheck={false}
              disabled={!keyEntryUnlocked}
            />
            <button
              type="button"
              className="btn-secondary"
              onClick={() => setRevealKey((v) => !v)}
              disabled={!keyEntryUnlocked}
            >
              {revealKey ? "hide" : "reveal"}
            </button>
            {apiKeyStored ? (
              <button
                type="button"
                className="btn-danger"
                onClick={handleDeleteKey}
                disabled={!keyEntryUnlocked}
              >
                forget
              </button>
            ) : null}
          </div>
          <p className="hint">
            Stored in your OS keychain — never written to disk in plaintext.
          </p>
        </div>
      </section>

      <section className="card">
        <h2>Primary model</h2>
        <p className="hint">
          Used for every pipeline stage unless overridden below. No default — pick one.
        </p>
        <div className="model-grid">
          {SUPPORTED_MODELS.map((m) => (
            <label
              key={m.id}
              className={`model-card ${settings.primary_model === m.id ? "selected" : ""}`}
            >
              <input
                type="radio"
                name="primary-model"
                value={m.id}
                checked={settings.primary_model === m.id}
                onChange={() =>
                  setSettings((s) => ({ ...s, primary_model: m.id as ModelId }))
                }
              />
              <div className="model-title">{m.label}</div>
              <div className="model-id">{m.id}</div>
              <div className="model-pricing">
                <span>${m.inputPricePerMTok.toFixed(2)}/M in</span>
                <span>·</span>
                <span>${m.outputPricePerMTok.toFixed(2)}/M out</span>
              </div>
              {m.notes ? <div className="model-notes">{m.notes}</div> : null}
            </label>
          ))}
        </div>
        <div className="external-link">
          <button
            type="button"
            className="btn-link"
            onClick={() => openUrl(PRICING_DOCS_URL)}
          >
            Verify latest pricing →
          </button>
        </div>

        <details
          className="advanced"
          open={showAdvanced}
          onToggle={(e) => setShowAdvanced((e.target as HTMLDetailsElement).open)}
        >
          <summary>Per-stage model override (advanced)</summary>
          <p className="hint">
            Leave as "inherit primary" unless you want to A/B test a different model at a specific
            stage. Configuring both models across stages enables the cross-model validator.
          </p>
          <div className="stage-overrides">
            {STAGES.map((stage) => (
              <div className="field" key={stage}>
                <label htmlFor={`stage-${stage}`} className="stage-label">
                  {stage}
                </label>
                <select
                  id={`stage-${stage}`}
                  value={(settings[`${stage}_model`] ?? "") as string}
                  onChange={(e) =>
                    setStage(stage, (e.target.value || null) as ModelId | null)
                  }
                >
                  <option value="">inherit primary</option>
                  {SUPPORTED_MODELS.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </div>
            ))}
          </div>
        </details>
      </section>

      <section className="card">
        <h2>Processing</h2>
        <div className="field-grid">
          <div className="field">
            <label htmlFor="dpi">Rasterization DPI</label>
            <input
              id="dpi"
              type="number"
              min={72}
              max={600}
              step={1}
              value={settings.dpi}
              onChange={(e) =>
                setSettings((s) => ({ ...s, dpi: clampInt(e.target.value, 72, 600, 300) }))
              }
            />
            <p className="hint">300 default. Higher = better OCR on small text, more API cost.</p>
          </div>
          <div className="field">
            <label htmlFor="pages-per-batch">Pages per batch</label>
            <input
              id="pages-per-batch"
              type="number"
              min={1}
              max={20}
              step={1}
              value={settings.pages_per_batch}
              onChange={(e) =>
                setSettings((s) => ({
                  ...s,
                  pages_per_batch: clampInt(e.target.value, 1, 20, 10),
                }))
              }
            />
            <p className="hint">10 default. Adjust to tune throughput vs auto-split risk.</p>
          </div>
          <div className="field">
            <label htmlFor="parallel-batches">Parallel batches</label>
            <input
              id="parallel-batches"
              type="number"
              min={1}
              max={10}
              step={1}
              value={settings.parallel_batches}
              onChange={(e) =>
                setSettings((s) => ({
                  ...s,
                  parallel_batches: clampInt(e.target.value, 1, 10, 3),
                }))
              }
            />
            <p className="hint">3 default. Model rate limits may reduce this automatically.</p>
          </div>
          <div className="field">
            <label htmlFor="confidence">Confidence threshold</label>
            <div className="slider-row">
              <input
                id="confidence"
                type="range"
                min={0.3}
                max={0.95}
                step={0.05}
                value={settings.confidence_threshold}
                onChange={(e) =>
                  setSettings((s) => ({
                    ...s,
                    confidence_threshold: parseFloat(e.target.value),
                  }))
                }
              />
              <span className="slider-value">{settings.confidence_threshold.toFixed(2)}</span>
            </div>
            <p className="hint">Below this → row is flagged for review.</p>
          </div>
          <div className="field">
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={settings.validator_enabled}
                onChange={(e) =>
                  setSettings((s) => ({ ...s, validator_enabled: e.target.checked }))
                }
              />
              <span>Validator re-pass enabled</span>
            </label>
            <p className="hint">
              Re-extracts low-confidence rows. Cross-model if both models configured across stages.
            </p>
          </div>
        </div>
      </section>

      <div className="actions">
        <button
          className="btn-primary big"
          type="button"
          onClick={handleSaveAll}
          disabled={saveState === "saving"}
        >
          {saveState === "saving" ? "Saving…" : "Save settings"}
        </button>
        {saveState === "saved" ? <span className="status saved">Saved ✓</span> : null}
        {saveState === "error" ? (
          <span className="status error">Error: {saveError}</span>
        ) : null}
        {!settings.primary_model ? (
          <span className="status warning">Pick a primary model before saving.</span>
        ) : null}
      </div>

      <footer className="footer-hint">
        Settings are stored in your OS app data dir. API key lives in the OS keychain
        ({platformKeychainName()}).
      </footer>
    </div>
  );
}

function clampInt(value: string, min: number, max: number, fallback: number): number {
  const n = parseInt(value, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function platformKeychainName(): string {
  if (typeof navigator === "undefined") return "OS keychain";
  const p = navigator.platform.toLowerCase();
  if (p.includes("win")) return "Windows Credential Manager";
  if (p.includes("mac")) return "macOS Keychain";
  if (p.includes("linux")) return "Secret Service";
  return "OS keychain";
}
