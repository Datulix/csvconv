import type { SplitFailure } from "../pipelines/autoSplit";

interface FailedPageModalProps {
  failure: SplitFailure;
  onClose: () => void;
}

/**
 * Friendly explanations of Gemini finishReason values. These are the values
 * that show up in non-STOP candidate.finishReason in the API response.
 */
const FINISH_REASON_EXPLANATIONS: Record<string, { title: string; detail: string }> = {
  RECITATION: {
    title: "Recitation filter triggered",
    detail:
      "Gemini's recitation filter blocked the response because the model's draft output appeared to recite verbatim text from its training data — usually a published exam, textbook, or other copyrighted source.\n\nThis is most common with well-known exam material (USMLE, SAT, AP, NCLEX, board review books, popular question banks). The filter is NOT configurable via the API; you can't turn it off.\n\nWorkarounds:\n• Switch to the other model in Settings (gemini ↔ gemma). They have different filter behavior.\n• Skip this page in the export and add it manually.\n• Try a paid-tier API key — recitation behavior occasionally differs by tier.",
  },
  SAFETY: {
    title: "Safety filter triggered",
    detail:
      "Gemini's safety filter blocked the response based on one of these categories: harassment, hate speech, sexually explicit, dangerous content, civic integrity.\n\nThe `safetyRatings` below shows which categories were flagged and at what probability. Even academic content about medicine, history, or science can trip these filters in specific phrasings.\n\nWorkarounds:\n• Try the other model — Gemma may have different thresholds.\n• Check the safety ratings to see which category was flagged.",
  },
  RECITATION_OF_GIVEN_INPUT: {
    title: "Echo filter triggered",
    detail:
      "The model's response too closely mirrored the input. Rare for our use case.",
  },
  PROHIBITED_CONTENT: {
    title: "Prohibited content",
    detail:
      "The content matched a hard block list. Not configurable. Skip the page or remove the offending content.",
  },
  BLOCKLIST: {
    title: "Blocklist match",
    detail:
      "The content or response matched a terminology blocklist on Google's side. Skip the page.",
  },
  SPII: {
    title: "Sensitive personally identifiable information",
    detail:
      "Gemini detected SPII (SSN, credit card, etc.) in the input or output and blocked. Redact the personal information in the source PDF.",
  },
  MAX_TOKENS: {
    title: "Output token limit reached",
    detail:
      "The model hit its output token budget before completing the JSON response. Auto-split tried smaller batches but this page alone still produced too much output.\n\nWorkarounds:\n• Use a schema with fewer required fields.\n• Use a content type with simpler output shape.\n• Switch to a model with a larger output window.",
  },
  PARSE_FAIL_LOOKS_TRUNCATED: {
    title: "JSON appears truncated",
    detail:
      "The response text ended mid-JSON (unbalanced braces) even though the finish reason wasn't MAX_TOKENS. Same workarounds as MAX_TOKENS apply.",
  },
  OTHER: {
    title: "Unspecified block",
    detail:
      "Gemini returned a non-specific 'OTHER' finishReason. This usually catches edge cases the API doesn't categorize. Try the other model.",
  },
};

function explainFinishReason(reason: string | undefined): { title: string; detail: string } {
  if (!reason) {
    return {
      title: "Unknown failure",
      detail: "The page failed for a reason that isn't a known Gemini finishReason. See the raw error below.",
    };
  }
  return (
    FINISH_REASON_EXPLANATIONS[reason] ?? {
      title: `Finish reason: ${reason}`,
      detail: "No detailed explanation available for this finish reason. See the raw diagnostics below.",
    }
  );
}

export function FailedPageModal({ failure, onClose }: FailedPageModalProps) {
  const explanation = explainFinishReason(failure.finishReason);
  const imgSrc = failure.imageBase64
    ? `data:${failure.mimeType ?? "image/jpeg"};base64,${failure.imageBase64}`
    : null;
  const hasDiagnostics =
    failure.safetyRatings || failure.citationMetadata || failure.promptFeedback;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal failed-page-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="modal-header">
          <h2>
            Page {failure.pageNumber} — skipped
            {failure.finishReason ? (
              <span className="chip warn" style={{ marginLeft: 10 }}>
                {failure.finishReason}
              </span>
            ) : null}
          </h2>
          <button onClick={onClose} className="btn-icon" title="Close">
            ×
          </button>
        </header>
        <div className="modal-body failed-page-modal-body">
          <div className="failed-page-image">
            {imgSrc ? (
              <img src={imgSrc} alt={`Page ${failure.pageNumber}`} />
            ) : (
              <div className="failed-page-noimg">No thumbnail available.</div>
            )}
          </div>
          <div className="failed-page-info">
            <section>
              <h3>{explanation.title}</h3>
              <p className="failed-page-explanation">{explanation.detail}</p>
            </section>
            <section>
              <h3>Raw reason</h3>
              <code className="failed-page-reason">{failure.reason}</code>
            </section>
            {hasDiagnostics ? (
              <section>
                <h3>API diagnostics</h3>
                {failure.safetyRatings ? (
                  <details open>
                    <summary>Safety ratings</summary>
                    <pre>{JSON.stringify(failure.safetyRatings, null, 2)}</pre>
                  </details>
                ) : null}
                {failure.citationMetadata ? (
                  <details open>
                    <summary>Citation metadata</summary>
                    <pre>{JSON.stringify(failure.citationMetadata, null, 2)}</pre>
                  </details>
                ) : null}
                {failure.promptFeedback ? (
                  <details>
                    <summary>Prompt feedback</summary>
                    <pre>{JSON.stringify(failure.promptFeedback, null, 2)}</pre>
                  </details>
                ) : null}
              </section>
            ) : (
              <p className="hint">No additional diagnostics returned by the API for this failure.</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
