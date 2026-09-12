import { useEffect, useState } from "react";
import { Icon } from "./icons";
import { currentTaxYearStartYear } from "@acm-caseflow/core";
import {
  exportAllData,
  getClientCategories,
  getClientNotes,
  getClients,
  getDeletedDocuments,
  getDocumentCategories,
  getExpenseCategories,
  getExpenses,
  getFirms,
  getHourlyRates,
  getInvoiceSettings,
  getNoteCategories,
  getTaxYearSettings,
  getTimeCategories,
  getTimeEntries,
  getTimeSettings,
  type Client,
  type ClientCategory,
  type ClientNoteSummary,
  type DeletedDocument,
  type DocumentCategory,
  type Expense,
  type ExpenseCategory,
  type Firm,
  type HourlyRate,
  type InvoiceSettings,
  type NoteCategory,
  type TimeCategory,
  type TimeEntry,
  type TimeSettings,
} from "./api";
import { AppearanceManager } from "./AppearanceManager";
import { ClientCategoryManager } from "./ClientCategoryManager";
import { AiSettingsPanel } from "./AiSettingsPanel";
import { DocumentCategoryManager } from "./DocumentCategoryManager";
import { FeatureManager } from "./FeatureManager";
import { ExpenseCategoryManager } from "./ExpenseCategoryManager";
import { TimeCategoryManager } from "./TimeCategoryManager";
import { TimeRateManager } from "./TimeRateManager";
import { NoteCategoryManager } from "./NoteCategoryManager";
import { InvoiceSettingsManager } from "./InvoiceSettingsManager";
import { TaxRatesManager } from "./TaxRatesManager";
import { InviteCodePanel } from "./InviteCodePanel";
import { ProfileManager } from "./ProfileManager";
import { UsagePanel } from "./UsagePanel";

type Section = "categories" | "billing" | "account";
type CategoriesTab = "clients" | "expenses" | "time" | "notes" | "documents";
type BillingTab = "rates" | "invoice" | "tax";
type AccountTab =
  | "profile"
  | "invite"
  | "export"
  | "usage"
  | "appearance"
  | "features"
  | "deletedDocuments"
  | "aiSettings";

const SECTIONS: Array<{ key: Section; label: string }> = [
  { key: "categories", label: "Categories" },
  { key: "billing", label: "Billing" },
  { key: "account", label: "Account" },
];

const CATEGORIES_TABS: Array<{ key: CategoriesTab; label: string }> = [
  { key: "clients", label: "Clients" },
  { key: "expenses", label: "Expenses" },
  { key: "time", label: "Time" },
  { key: "notes", label: "Notes" },
  { key: "documents", label: "Documents" },
];

const BILLING_TABS: Array<{ key: BillingTab; label: string }> = [
  { key: "rates", label: "Billing rates" },
  { key: "invoice", label: "Invoice settings" },
  { key: "tax", label: "Tax year rates" },
];

const ACCOUNT_TABS: Array<{ key: AccountTab; label: string }> = [
  { key: "profile", label: "Your name" },
  { key: "invite", label: "Invite code" },
  { key: "export", label: "Export data" },
  { key: "usage", label: "Usage" },
  { key: "appearance", label: "Appearance" },
  { key: "features", label: "Features" },
  { key: "deletedDocuments", label: "Deleted documents" },
  { key: "aiSettings", label: "AI settings" },
];

export function AdminPage({
  onBack,
  onDisabledFeaturesChange,
  fullName,
  onFullNameChanged,
}: {
  onBack: () => void;
  onDisabledFeaturesChange: (disabledFeatures: string[]) => void;
  fullName: string | null;
  onFullNameChanged: (fullName: string) => void;
}) {
  const [section, setSection] = useState<Section>("categories");
  const [categoriesTab, setCategoriesTab] = useState<CategoriesTab>("clients");
  const [billingTab, setBillingTab] = useState<BillingTab>("rates");
  const [accountTab, setAccountTab] = useState<AccountTab>("invite");

  return (
    <>
      <button type="button" className="back-link" onClick={onBack}>
        <Icon name="back" /> Dashboard
      </button>
      <h1 className="sr-only">Admin &amp; Settings</h1>

      <div className="admin-layout">
        <nav className="admin-rail" aria-label="Admin sections">
          {SECTIONS.map((s) => (
            <button
              key={s.key}
              type="button"
              className={`admin-rail-item ${section === s.key ? "active" : ""}`}
              onClick={() => setSection(s.key)}
            >
              {s.label}
            </button>
          ))}
        </nav>

        <div className="admin-content">
          {section === "categories" && (
            <>
              <div className="subtabs" role="tablist" aria-label="Category type">
                {CATEGORIES_TABS.map((t) => (
                  <button
                    key={t.key}
                    type="button"
                    role="tab"
                    aria-selected={categoriesTab === t.key}
                    className={`subtab ${categoriesTab === t.key ? "active" : ""}`}
                    onClick={() => setCategoriesTab(t.key)}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
              {categoriesTab === "clients" && <ClientCategoriesTab />}
              {categoriesTab === "expenses" && <ExpenseCategoriesTab />}
              {categoriesTab === "time" && <TimeCategoriesTab />}
              {categoriesTab === "notes" && <NoteCategoriesTab />}
              {categoriesTab === "documents" && <DocumentCategoriesTab />}
            </>
          )}

          {section === "billing" && (
            <>
              <div className="subtabs" role="tablist" aria-label="Billing settings">
                {BILLING_TABS.map((t) => (
                  <button
                    key={t.key}
                    type="button"
                    role="tab"
                    aria-selected={billingTab === t.key}
                    className={`subtab ${billingTab === t.key ? "active" : ""}`}
                    onClick={() => setBillingTab(t.key)}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
              {billingTab === "rates" && <HourlyRatesTab />}
              {billingTab === "invoice" && <InvoiceSettingsTab />}
              {billingTab === "tax" && <TaxRatesManager />}
            </>
          )}

          {section === "account" && (
            <>
              <div className="subtabs" role="tablist" aria-label="Account settings">
                {ACCOUNT_TABS.map((t) => (
                  <button
                    key={t.key}
                    type="button"
                    role="tab"
                    aria-selected={accountTab === t.key}
                    className={`subtab ${accountTab === t.key ? "active" : ""}`}
                    onClick={() => setAccountTab(t.key)}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
              {accountTab === "profile" && (
                <ProfileManager fullName={fullName} onFullNameChanged={onFullNameChanged} />
              )}
              {accountTab === "invite" && <InviteCodePanel />}
              {accountTab === "export" && <ExportDataTab />}
              {accountTab === "usage" && <UsagePanel />}
              {accountTab === "appearance" && <AppearanceManager />}
              {accountTab === "features" && <FeatureManager onChanged={onDisabledFeaturesChange} />}
              {accountTab === "deletedDocuments" && <DeletedDocumentsTab />}
              {accountTab === "aiSettings" && <AiSettingsPanel />}
            </>
          )}
        </div>
      </div>
    </>
  );
}

function ClientCategoriesTab() {
  const [clients, setClients] = useState<Client[]>([]);
  const [categories, setCategories] = useState<ClientCategory[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    setLoading(true);
    try {
      const [clientList, categoryList] = await Promise.all([getClients(), getClientCategories()]);
      setClients(clientList);
      setCategories(categoryList);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't load client categories");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  if (loading) return <p className="loading">Loading…</p>;
  if (error) return (
    <p className="error" role="alert">
      {error}
    </p>
  );
  return <ClientCategoryManager categories={categories} clients={clients} onChanged={refresh} />;
}

function ExpenseCategoriesTab() {
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [categories, setCategories] = useState<ExpenseCategory[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    setLoading(true);
    try {
      const [expenseList, categoryList] = await Promise.all([getExpenses(), getExpenseCategories()]);
      setExpenses(expenseList);
      setCategories(categoryList);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't load expense categories");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  if (loading) return <p className="loading">Loading…</p>;
  if (error) return (
    <p className="error" role="alert">
      {error}
    </p>
  );
  return <ExpenseCategoryManager categories={categories} expenses={expenses} onChanged={refresh} />;
}

function TimeCategoriesTab() {
  const [entries, setEntries] = useState<TimeEntry[]>([]);
  const [categories, setCategories] = useState<TimeCategory[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    setLoading(true);
    try {
      const [entryList, categoryList] = await Promise.all([getTimeEntries(), getTimeCategories()]);
      setEntries(entryList);
      setCategories(categoryList);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't load time categories");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  if (loading) return <p className="loading">Loading…</p>;
  if (error) return (
    <p className="error" role="alert">
      {error}
    </p>
  );
  return <TimeCategoryManager categories={categories} entries={entries} onChanged={refresh} />;
}

function NoteCategoriesTab() {
  const [notes, setNotes] = useState<ClientNoteSummary[]>([]);
  const [categories, setCategories] = useState<NoteCategory[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    setLoading(true);
    try {
      const [noteList, categoryList] = await Promise.all([getClientNotes(), getNoteCategories()]);
      setNotes(noteList);
      setCategories(categoryList);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't load note categories");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  if (loading) return <p className="loading">Loading…</p>;
  if (error) return (
    <p className="error" role="alert">
      {error}
    </p>
  );
  return <NoteCategoryManager categories={categories} notes={notes} onChanged={refresh} />;
}

function DocumentCategoriesTab() {
  const [categories, setCategories] = useState<DocumentCategory[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    setLoading(true);
    try {
      setCategories(await getDocumentCategories());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't load document categories");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  if (loading) return <p className="loading">Loading…</p>;
  if (error) return (
    <p className="error" role="alert">
      {error}
    </p>
  );
  return <DocumentCategoryManager categories={categories} onChanged={refresh} />;
}

// The audit trail for story 11.1's soft-delete requirement: every deleted
// document, when, and by whom -- read-only, no undo action here (the row
// is never actually removed from the database, so nothing to "restore" via
// this screen; recovery would be a direct DB fix if ever needed).
function DeletedDocumentsTab() {
  const [documents, setDocuments] = useState<DeletedDocument[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      setLoading(true);
      try {
        setDocuments(await getDeletedDocuments());
      } catch (err) {
        setError(err instanceof Error ? err.message : "Couldn't load deleted documents");
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  if (loading) return <p className="loading">Loading…</p>;
  if (error) return (
    <p className="error" role="alert">
      {error}
    </p>
  );
  if (documents.length === 0) return <p className="empty">No documents have been deleted.</p>;

  return (
    <table className="month-detail-table">
      <thead>
        <tr>
          <th>File</th>
          <th>Client</th>
          <th>Category</th>
          <th>Uploaded</th>
          <th>Deleted</th>
          <th>Deleted by</th>
        </tr>
      </thead>
      <tbody>
        {documents.map((doc) => (
          <tr key={doc.id}>
            <td>{doc.filename}</td>
            <td>{doc.clientName}</td>
            <td>{doc.categoryName ?? "Uncategorised"}</td>
            <td>{doc.uploadedAt.slice(0, 10)}</td>
            <td>{doc.deletedAt.slice(0, 10)}</td>
            <td>{doc.deletedByEmail ?? "—"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function HourlyRatesTab() {
  const [settings, setSettings] = useState<TimeSettings | null>(null);
  const [rates, setRates] = useState<HourlyRate[]>([]);
  const [splitPercentage, setSplitPercentage] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Owned here, not inside TimeRateManager: refresh() below remounts that
  // component (it's replaced by the "Loading…" branch while in flight), so
  // any message it set on itself would be wiped before it's ever seen.
  const [rateMessage, setRateMessage] = useState<string | null>(null);

  async function refresh() {
    setLoading(true);
    try {
      const [timeSettings, rateList, taxYearSettings] = await Promise.all([
        getTimeSettings(),
        getHourlyRates(),
        getTaxYearSettings(currentTaxYearStartYear()),
      ]);
      setSettings(timeSettings);
      setRates(rateList);
      setSplitPercentage(taxYearSettings.splitPercentage);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't load billing settings");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  if (loading) return <p className="loading">Loading…</p>;
  if (error) return (
    <p className="error" role="alert">
      {error}
    </p>
  );
  if (!settings) return null;
  return (
    <TimeRateManager
      settings={settings}
      rates={rates}
      splitPercentage={splitPercentage}
      onChanged={refresh}
      rateMessage={rateMessage}
      onRateMessage={setRateMessage}
    />
  );
}

function InvoiceSettingsTab() {
  const [settings, setSettings] = useState<InvoiceSettings | null>(null);
  const [firm, setFirm] = useState<Firm | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      setLoading(true);
      try {
        const [invoiceSettings, firms] = await Promise.all([getInvoiceSettings(), getFirms()]);
        setSettings(invoiceSettings);
        setFirm(firms[0] ?? null);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Couldn't load invoice settings");
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  if (loading) return <p className="loading">Loading…</p>;
  if (error) return (
    <p className="error" role="alert">
      {error}
    </p>
  );
  if (!settings) return null;
  return (
    <InvoiceSettingsManager
      settings={settings}
      firm={firm}
      onSaved={(newSettings, newFirm) => {
        setSettings(newSettings);
        setFirm(newFirm);
      }}
    />
  );
}

function ExportDataTab() {
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A plain file download, client-side, rather than anything stored on
  // the server — the same "generate and hand over a file" pattern already
  // used for invoice PDFs. Every business table except users and
  // account_settings (passwords and the invite code have no place in a
  // file that might end up emailed or dropped in a shared drive).
  async function handleExport() {
    setError(null);
    setExporting(true);
    try {
      const data = await exportAllData();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `acm-caseflow-backup-${new Date().toISOString().slice(0, 10)}.json`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't export the data");
    } finally {
      setExporting(false);
    }
  }

  return (
    <div>
      <p className="hint">
        Download every business table as a single JSON file — a backup you can keep somewhere safe.
      </p>
      <div className="row-actions">
        <button type="button" onClick={handleExport} disabled={exporting}>
          <Icon name="export" /> {exporting ? "Exporting…" : "Export data"}
        </button>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
