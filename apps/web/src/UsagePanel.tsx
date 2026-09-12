import { useEffect, useState } from "react";
import { Icon } from "./icons";
import { getAiUsage, getUsage, type AiUsageSummary, type UsageStats } from "./api";

const count = new Intl.NumberFormat("en-GB");
const usd = new Intl.NumberFormat("en-GB", { style: "currency", currency: "USD", minimumFractionDigits: 2 });

function formatBytes(bytes: number): string {
  const gb = bytes / 1_000_000_000;
  if (gb >= 0.1) return `${gb.toFixed(2)} GB`;
  const mb = bytes / 1_000_000;
  return `${mb.toFixed(1)} MB`;
}

// Amber past 70% of a free-tier cap, red past 90% — the same "give a
// heads-up before it's a problem" framing as the tax/performance pages'
// status colours, just applied to Cloudflare's daily limits instead.
function fillClass(pct: number): string {
  if (pct >= 90) return "critical";
  if (pct >= 70) return "warn";
  return "";
}

function UsageBar({ label, used, cap, format }: { label: string; used: number; cap: number; format: (n: number) => string }) {
  const pct = cap > 0 ? Math.min((used / cap) * 100, 100) : 0;
  return (
    <div className="stat-group">
      <div className="stat-group-label">{label}</div>
      <div className="stat-group-figures">
        <span className="stat-actual">{format(used)}</span>
        <span className="stat-of"> of {format(cap)}</span>
      </div>
      <div className="progress-bar">
        <div className={`progress-bar-fill ${fillClass(pct)}`} style={{ width: `${pct}%` }} />
      </div>
      <div className="stat-group-pct">{Math.round(pct)}% of the daily free-tier limit</div>
    </div>
  );
}

export function UsagePanel({ onClose }: { onClose?: () => void }) {
  const [usage, setUsage] = useState<UsageStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Independent of the Cloudflare fetch above -- Correspondence's AI usage
  // has nothing to do with CF_API_TOKEN/CF_ACCOUNT_ID, so one being
  // unconfigured shouldn't hide the other's figures.
  const [aiUsage, setAiUsage] = useState<AiUsageSummary | null>(null);
  const [aiLoading, setAiLoading] = useState(true);
  const [aiError, setAiError] = useState<string | null>(null);

  useEffect(() => {
    getUsage()
      .then(setUsage)
      .catch((err) => setError(err instanceof Error ? err.message : "Couldn't load usage"))
      .finally(() => setLoading(false));

    getAiUsage()
      .then(setAiUsage)
      .catch((err) => setAiError(err instanceof Error ? err.message : "Couldn't load AI usage"))
      .finally(() => setAiLoading(false));
  }, []);

  return (
    <>
      <div className="edit-panel" style={{ marginBottom: 24 }}>
        <p className="edit-panel-title">
          <Icon name="usage" /> Cloudflare usage today
        </p>
        <p className="hint">
          How close today's activity is to Cloudflare's free-tier daily limits. Resets at midnight UTC.
        </p>
        {loading ? (
          <p className="loading">Loading…</p>
        ) : error ? (
          <p className="error" role="alert">
            {error}
          </p>
        ) : usage ? (
          <div className="stat-groups">
            <UsageBar label="Worker requests" used={usage.workersRequests.used} cap={usage.workersRequests.cap} format={(n) => count.format(n)} />
            <UsageBar label="D1 rows read" used={usage.d1RowsRead.used} cap={usage.d1RowsRead.cap} format={(n) => count.format(n)} />
            <UsageBar label="D1 rows written" used={usage.d1RowsWritten.used} cap={usage.d1RowsWritten.cap} format={(n) => count.format(n)} />
            <UsageBar label="D1 storage" used={usage.d1Storage.used} cap={usage.d1Storage.cap} format={formatBytes} />
            <UsageBar label="R2 storage (documents)" used={usage.r2Storage.used} cap={usage.r2Storage.cap} format={formatBytes} />
          </div>
        ) : null}
      </div>

      <div className="edit-panel">
        <p className="edit-panel-title">
          <Icon name="mail" /> AI usage (Correspondence)
        </p>
        <p className="hint">
          Tokens spent by the drafting and review agents, all-time, with an estimated cost from Anthropic's published
          per-token pricing. This is an estimate this app calculates itself, not a live account balance — check{" "}
          <a href="https://console.anthropic.com/settings/billing" target="_blank" rel="noreferrer">
            Anthropic's Console
          </a>{" "}
          for actual billing and remaining credit.
        </p>
        {aiLoading ? (
          <p className="loading">Loading…</p>
        ) : aiError ? (
          <p className="error" role="alert">
            {aiError}
          </p>
        ) : aiUsage ? (
          aiUsage.totalInputTokens === 0 && aiUsage.totalOutputTokens === 0 ? (
            <p className="empty">No AI calls recorded yet.</p>
          ) : (
            <div className="stat-groups">
              <div className="stat-group">
                <div className="stat-group-label">Estimated cost, all-time</div>
                <div className="stat-group-figures">
                  <span className="stat-actual">{usd.format(aiUsage.estimatedCostUsd)}</span>
                </div>
              </div>
              <div className="stat-group">
                <div className="stat-group-label">Tokens used</div>
                <div className="stat-group-figures">
                  <span className="stat-actual">{count.format(aiUsage.totalInputTokens)} in</span>
                  <span className="stat-of"> / {count.format(aiUsage.totalOutputTokens)} out</span>
                </div>
              </div>
              {aiUsage.byModel.length > 1 &&
                aiUsage.byModel.map((row) => (
                  <div className="stat-group" key={row.model}>
                    <div className="stat-group-label">{row.model}</div>
                    <div className="stat-group-figures">
                      <span className="stat-actual">{usd.format(row.estimatedCostUsd)}</span>
                      <span className="stat-of">
                        {" "}
                        ({count.format(row.inputTokens)} in / {count.format(row.outputTokens)} out)
                      </span>
                    </div>
                  </div>
                ))}
            </div>
          )
        ) : null}
      </div>

      {onClose && (
        <div className="row-actions" style={{ marginTop: 24 }}>
          <button type="button" onClick={onClose}>
            Close
          </button>
        </div>
      )}
    </>
  );
}
