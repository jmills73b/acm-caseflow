import { useEffect, useState } from "react";
import { getAccountSettings, updateDisabledFeatures } from "./api";

// Deliberately excludes "clients" (other features reference client
// records) and "admin" (this very panel lives there — hiding it would
// lock the account out of ever turning anything back on).
const FEATURES: Array<{ key: string; name: string; desc: string }> = [
  { key: "time", name: "Time Keeping", desc: "Log chargeable time against a client, in configurable billing units." },
  { key: "invoices", name: "Invoice Management", desc: "Log invoices, track status, and see performance by client." },
  { key: "performance", name: "Performance & Targets", desc: "See where you stand against this month's target." },
  {
    key: "invoice-generator",
    name: "Invoice Generator",
    desc: "Bill Newmans for invoices awaiting payment, and see past invoices sent.",
  },
  { key: "expenses", name: "Expenses", desc: "Log and categorise business expenses." },
  { key: "tax", name: "Tax & NI Estimate", desc: "Estimate this year's income tax and National Insurance." },
  {
    key: "tasks",
    name: "Tasks & Reminders",
    desc: "Track recurring and one-off things to do, with due dates and history.",
  },
  { key: "documents", name: "All Documents", desc: "Search every stored document across every client in one place." },
  {
    key: "correspondence",
    name: "Correspondence",
    desc: "Draft client letters with an AI reviewer for compliance and personal data.",
  },
];

export function FeatureManager({ onChanged }: { onChanged: (disabledFeatures: string[]) => void }) {
  const [disabled, setDisabled] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getAccountSettings()
      .then((settings) => setDisabled(settings.disabledFeatures))
      .catch((err) => setError(err instanceof Error ? err.message : "Couldn't load feature settings"))
      .finally(() => setLoading(false));
  }, []);

  async function toggle(key: string) {
    setError(null);
    const next = disabled.includes(key) ? disabled.filter((k) => k !== key) : [...disabled, key];
    setSavingKey(key);
    try {
      const updated = await updateDisabledFeatures(next);
      setDisabled(updated.disabledFeatures);
      onChanged(updated.disabledFeatures);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save that change");
    } finally {
      setSavingKey(null);
    }
  }

  if (loading) return <p className="loading">Loading…</p>;

  return (
    <div>
      <p className="hint">
        Turn a feature off to remove its dashboard tile entirely — nobody signed into this account will see or be
        able to reach it until it's turned back on here.
      </p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {FEATURES.map((feature) => {
        const isEnabled = !disabled.includes(feature.key);
        return (
          <div className="feature-row" key={feature.key}>
            <label className="feature-row-toggle">
              <input
                type="checkbox"
                checked={isEnabled}
                onChange={() => toggle(feature.key)}
                disabled={savingKey === feature.key}
              />
              <span className="feature-row-name">{feature.name}</span>
            </label>
            <p className="feature-row-desc">{feature.desc}</p>
          </div>
        );
      })}
    </div>
  );
}
