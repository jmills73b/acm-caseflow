import { useEffect, useState } from "react";
import { getAccountSettings, getTasks, logout } from "./api";
import { AdminPage } from "./AdminPage";
import { AllDocumentsPage } from "./AllDocumentsPage";
import { ClientsPage } from "./ClientsPage";
import { Dashboard, type DashboardTile } from "./Dashboard";
import { ExpensesPage } from "./ExpensesPage";
import { Icon } from "./icons";
import { InvoiceGeneratorPage } from "./InvoiceGeneratorPage";
import { InvoicesPage } from "./InvoicesPage";
import { LetterGeneratorPage } from "./LetterGeneratorPage";
import { PerformancePage } from "./PerformancePage";
import { TaskQuickPanel } from "./TaskQuickPanel";
import { needsAttention } from "./taskUrgency";
import { TasksPage } from "./TasksPage";
import { TaxPage } from "./TaxPage";
import { ThemeQuickSwitch } from "./ThemeQuickSwitch";
import { TimeKeepingPage } from "./TimeKeepingPage";
import { Brand } from "./Brand";

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

// clientId only ever matters for the "invoices" screen -- set when a
// client's own "Invoices" link (see ClientsPage) jumps straight to their
// history instead of the full ledger. Kept optional on every variant
// rather than a separate union member so tile navigation (Dashboard's
// onSelect) doesn't need to know which tiles do and don't carry one.
type Screen = { kind: "hub" } | { kind: DashboardTile; clientId?: number };

export function SignedInApp({
  email,
  fullName,
  onFullNameChanged,
  onLoggedOut,
}: {
  email: string;
  fullName: string | null;
  onFullNameChanged: (fullName: string) => void;
  onLoggedOut: () => void;
}) {
  const [screen, setScreen] = useState<Screen>({ kind: "hub" });
  const [showTasks, setShowTasks] = useState(false);
  const [dueTaskCount, setDueTaskCount] = useState(0);
  const [disabledFeatures, setDisabledFeatures] = useState<string[]>([]);
  const goHome = () => setScreen({ kind: "hub" });
  const tasksDisabled = disabledFeatures.includes("tasks");

  async function refreshDueTaskCount() {
    try {
      const tasks = await getTasks();
      const today = todayISO();
      setDueTaskCount(tasks.filter((t) => t.status === "active" && needsAttention(t.nextDueDate, today)).length);
    } catch {
      // The header badge is a convenience, not critical — leave it as-is
      // rather than surfacing an error banner over the whole app for it.
    }
  }

  useEffect(() => {
    if (!tasksDisabled) refreshDueTaskCount();
  }, [screen.kind, tasksDisabled]);

  // The quick panel is a preview of the full Tasks & Reminders screen —
  // showing it on top of that screen itself is redundant (and looked
  // like a rendering bug, with the same task appearing twice). Force it
  // closed the moment that screen is reached, however the user got
  // there — not just via "View all tasks", but the dashboard tile or
  // back-navigation too.
  useEffect(() => {
    if (screen.kind === "tasks") setShowTasks(false);
  }, [screen.kind]);

  useEffect(() => {
    getAccountSettings()
      .then((settings) => setDisabledFeatures(settings.disabledFeatures))
      .catch(() => {
        // Nothing to disable is the safe default — leave every tile visible
        // rather than surfacing an error banner for a background lookup.
      });
  }, []);

  // A screen that was open when an admin (elsewhere, or in this same
  // session) disables its feature shouldn't stay reachable just because
  // local state still points at it.
  useEffect(() => {
    if (screen.kind !== "hub" && disabledFeatures.includes(screen.kind)) {
      goHome();
    }
  }, [disabledFeatures]);

  return (
    <main className="page">
      <header className="page-header">
        <Brand onClick={screen.kind === "hub" ? undefined : goHome} />
        <div className="page-header-right">
          <span className="who">{fullName ? `${greeting()}, ${fullName}` : email}</span>
          <div className="page-header-buttons">
            <ThemeQuickSwitch />
            {!tasksDisabled && (
              <button
                type="button"
                className="secondary task-badge-button"
                onClick={() => {
                  // Already looking at the full list — nothing for the
                  // preview to add, and toggling it here would silently
                  // flip a hidden flag that then surprises the next
                  // toggle from a different screen.
                  if (screen.kind === "tasks") return;
                  setShowTasks((prev) => !prev);
                }}
              >
                <Icon name="tasks" /> Tasks
                {dueTaskCount > 0 && <span className="task-badge">{dueTaskCount}</span>}
              </button>
            )}
            <button type="button" className="secondary" onClick={() => logout().then(onLoggedOut)}>
              Sign out
            </button>
          </div>
        </div>
      </header>
      {showTasks && !tasksDisabled && screen.kind !== "tasks" && (
        <TaskQuickPanel
          onClose={() => {
            setShowTasks(false);
            refreshDueTaskCount();
          }}
          onViewAll={() => {
            setShowTasks(false);
            setScreen({ kind: "tasks" });
          }}
        />
      )}
      {screen.kind === "hub" && (
        <Dashboard onSelect={(tile) => setScreen({ kind: tile })} disabledFeatures={disabledFeatures} />
      )}
      {screen.kind === "invoices" && <InvoicesPage onBack={goHome} initialClientId={screen.clientId} />}
      {screen.kind === "performance" && <PerformancePage onBack={goHome} />}
      {screen.kind === "invoice-generator" && <InvoiceGeneratorPage onBack={goHome} />}
      {screen.kind === "expenses" && <ExpensesPage onBack={goHome} />}
      {screen.kind === "tax" && <TaxPage onBack={goHome} />}
      {screen.kind === "time" && <TimeKeepingPage onBack={goHome} />}
      {screen.kind === "clients" && (
        <ClientsPage onBack={goHome} onViewInvoices={(clientId) => setScreen({ kind: "invoices", clientId })} />
      )}
      {screen.kind === "tasks" && <TasksPage onBack={goHome} />}
      {screen.kind === "documents" && <AllDocumentsPage onBack={goHome} />}
      {screen.kind === "correspondence" && <LetterGeneratorPage onBack={goHome} />}
      {screen.kind === "admin" && (
        <AdminPage
          onBack={goHome}
          onDisabledFeaturesChange={setDisabledFeatures}
          fullName={fullName}
          onFullNameChanged={onFullNameChanged}
        />
      )}
    </main>
  );
}
