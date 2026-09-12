import { useEffect, useState } from "react";
import { currentTaxYearStartYear } from "@acm-caseflow/core";
import { getInvoices, getTasks, getTaxYearSettings } from "./api";
import { Icon } from "./icons";
import { currentYearToDateSummary } from "./PerformancePage";

const money = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" });

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

const TILES = [
  {
    key: "clients",
    name: "Clients",
    desc: "Maintain the client list, with contact details and categories.",
    icon: "clients",
    active: true,
  },
  {
    key: "time",
    name: "Time Keeping",
    desc: "Log chargeable time against a client, in configurable billing units.",
    icon: "time",
    active: true,
  },
  {
    key: "invoices",
    name: "Invoice Management",
    desc: "Log invoices, track status, and see performance by client.",
    icon: "invoices",
    active: true,
  },
  {
    key: "performance",
    name: "Performance & Targets",
    desc: "See where you stand against this month's target.",
    icon: "performance",
    active: true,
  },
  {
    key: "invoice-generator",
    name: "Invoice Generator",
    desc: "Bill Newmans for invoices awaiting payment, and see past invoices sent.",
    icon: "generator",
    active: true,
  },
  {
    key: "expenses",
    name: "Expenses",
    desc: "Log and categorise business expenses.",
    icon: "expenses",
    active: true,
  },
  {
    key: "tax",
    name: "Tax & NI Estimate",
    desc: "Estimate this year's income tax and National Insurance.",
    icon: "tax",
    active: true,
  },
  {
    key: "tasks",
    name: "Tasks & Reminders",
    desc: "Track recurring and one-off things to do, with due dates and history.",
    icon: "tasks",
    active: true,
  },
  {
    key: "documents",
    name: "All Documents",
    desc: "Search every stored document across every client in one place.",
    icon: "documents",
    active: true,
  },
  {
    key: "correspondence",
    name: "Correspondence",
    desc: "Draft client letters with an AI reviewer for compliance and personal data.",
    icon: "mail",
    active: true,
  },
  {
    key: "admin",
    name: "Admin & Settings",
    desc: "Manage categories, billing settings, and account tools for every function.",
    icon: "admin",
    active: true,
  },
] as const;

export type DashboardTile = (typeof TILES)[number]["key"];

interface HeadlineStats {
  ytd: { actual: number; target: number; monthlyTarget: number } | null;
  outstanding: { amount: number; count: number } | null;
  tasks: { late: number; dueToday: number } | null;
}

export function Dashboard({
  onSelect,
  disabledFeatures = [],
}: {
  onSelect: (tile: DashboardTile) => void;
  disabledFeatures?: string[];
}) {
  const visibleTiles = TILES.filter((tile) => !disabledFeatures.includes(tile.key));
  const [stats, setStats] = useState<HeadlineStats>({ ytd: null, outstanding: null, tasks: null });

  // Headline stats are the answer to "how am I doing right now" without
  // opening a tile first -- each is best-effort and independent, so one
  // failing (or its feature being toggled off) just leaves that card out
  // rather than blocking the others or the tile grid itself.
  useEffect(() => {
    const showPerformance = !disabledFeatures.includes("performance");
    const showInvoices = !disabledFeatures.includes("invoices");
    const showTasks = !disabledFeatures.includes("tasks");

    if (showPerformance || showInvoices) {
      getInvoices()
        .then(async (invoices) => {
          if (showInvoices) {
            const open = invoices.filter((invoice) => invoice.status !== "Complete");
            setStats((prev) => ({
              ...prev,
              outstanding: { amount: open.reduce((sum, invoice) => sum + invoice.anitaIncome, 0), count: open.length },
            }));
          }
          if (showPerformance) {
            const settings = await getTaxYearSettings(currentTaxYearStartYear());
            const monthlyTarget = settings.monthlyTarget;
            if (!monthlyTarget) return;
            const summary = currentYearToDateSummary(invoices, currentTaxYearStartYear(), monthlyTarget);
            setStats((prev) => ({ ...prev, ytd: { ...summary, monthlyTarget } }));
          }
        })
        .catch(() => {
          // Best-effort -- the headline card just stays out.
        });
    }

    if (showTasks) {
      getTasks()
        .then((tasks) => {
          const today = todayISO();
          const active = tasks.filter((task) => task.status === "active");
          setStats((prev) => ({
            ...prev,
            tasks: {
              late: active.filter((task) => task.nextDueDate < today).length,
              dueToday: active.filter((task) => task.nextDueDate === today).length,
            },
          }));
        })
        .catch(() => {
          // Best-effort -- the headline card just stays out.
        });
    }
  }, [disabledFeatures]);

  const monthsIn = stats.ytd ? Math.round(stats.ytd.target / stats.ytd.monthlyTarget) : 0;
  const pctOfTarget = stats.ytd && stats.ytd.target > 0 ? Math.round((stats.ytd.actual / stats.ytd.target) * 100) : 0;
  const hasHeadline = stats.ytd || stats.outstanding || stats.tasks;

  return (
    <>
      <h1 className="sr-only">Dashboard</h1>

      {hasHeadline && (
        <>
          <p className="section-eyebrow">Overview</p>
          <div className="client-stats">
            {stats.ytd && (
              <div className="client-stat">
                <div className="n">{money.format(stats.ytd.actual)}</div>
                <div className="l">Received this tax year</div>
              </div>
            )}
            {stats.outstanding && (
              <div className="client-stat">
                <div className={`n ${stats.outstanding.count > 0 ? "stat-warn" : ""}`}>
                  {money.format(stats.outstanding.amount)}
                </div>
                <div className="l">
                  Outstanding · {stats.outstanding.count} invoice{stats.outstanding.count === 1 ? "" : "s"}
                </div>
              </div>
            )}
            {stats.tasks && (
              <div className="client-stat">
                <div className={`n ${stats.tasks.late > 0 ? "stat-warn" : ""}`}>
                  {stats.tasks.late} late · {stats.tasks.dueToday} today
                </div>
                <div className="l">Tasks needing attention</div>
              </div>
            )}
            {stats.ytd && (
              <div className="client-stat">
                <div className="n">{pctOfTarget}% of target</div>
                <div className="l">
                  {monthsIn} month{monthsIn === 1 ? "" : "s"} in · {money.format(stats.ytd.actual)} vs{" "}
                  {money.format(stats.ytd.target)}
                </div>
                <div className="progress-bar">
                  <div className="progress-bar-fill" style={{ width: `${Math.min(pctOfTarget, 100)}%` }} />
                </div>
              </div>
            )}
          </div>
        </>
      )}

      <p className="section-eyebrow">Everything else</p>
      <div className="hero-grid">
        {visibleTiles.map((tile) =>
          tile.active ? (
            <button
              key={tile.key}
              type="button"
              className="hero-tile"
              onClick={() => onSelect(tile.key)}
            >
              <span className="tile-heading">
                <Icon name={tile.icon} size="lg" />
                <span className="tile-name">{tile.name}</span>
              </span>
              <p className="tile-desc">{tile.desc}</p>
            </button>
          ) : (
            <div key={tile.key} className="hero-tile upcoming">
              <div className="tile-top">
                <span className="tile-heading">
                  <Icon name={tile.icon} size="lg" />
                  <span className="tile-name">{tile.name}</span>
                </span>
                <span className="tile-status">Coming soon</span>
              </div>
              <p className="tile-desc">{tile.desc}</p>
            </div>
          ),
        )}
      </div>
    </>
  );
}
