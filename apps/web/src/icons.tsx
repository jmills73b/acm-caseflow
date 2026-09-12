// Hand-drawn to match the app's existing icon style (see ThemeQuickSwitch's
// sun/moon) -- no icon library, since the CSP that governs published
// artifacts and this app's own bundle both avoid third-party icon CDNs.
// One meaning per icon everywhere it's used: Edit is always the pencil,
// Delete is always the bin, regardless of which page or record type.
//
// The one deliberate collision to avoid: Documents' "download an existing
// file" (the tray) and Invoice Generator's "produce a PDF from data right
// now" (the printer) never share an icon, even though both end with a
// file leaving the browser -- see docs/ARCHITECTURE.md's Design System
// section for the full reasoning.

export type IconName =
  | "edit"
  | "delete"
  | "save"
  | "add"
  | "cancel"
  | "back"
  | "clients"
  | "time"
  | "invoices"
  | "performance"
  | "generator"
  | "expenses"
  | "tax"
  | "tasks"
  | "documents"
  | "mail"
  | "admin"
  | "doc-file"
  | "download"
  | "upload"
  | "notepad"
  | "export"
  | "tag"
  | "usage"
  | "done"
  | "skip"
  | "not-needed"
  | "history"
  | "pause"
  | "resume";

const PATHS: Record<IconName, JSX.Element> = {
  edit: (
    <>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
    </>
  ),
  delete: <path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" />,
  save: <path d="M20 6L9 17l-5-5" />,
  add: <path d="M12 5v14M5 12h14" />,
  cancel: <path d="M18 6L6 18M6 6l12 12" />,
  back: <path d="M19 12H5M12 19l-7-7 7-7" />,
  clients: (
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21c0-4.4 3.6-8 8-8s8 3.6 8 8" />
    </>
  ),
  time: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 3" />
    </>
  ),
  invoices: (
    <>
      <path d="M6 3h12v16l-2-1.5L14 19l-2-1.5L10 19l-2-1.5L6 19V3z" />
      <path d="M9 7.5h6M9 11h6M9 14.5h4" />
    </>
  ),
  performance: (
    <>
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="5" />
      <circle cx="12" cy="12" r="1" />
    </>
  ),
  generator: (
    <>
      <path d="M7 8V3h10v5" />
      <rect x="4" y="8" width="16" height="8" rx="1" />
      <rect x="8" y="13" width="8" height="7" />
    </>
  ),
  expenses: (
    <>
      <rect x="3" y="6" width="18" height="14" rx="2" />
      <path d="M3 10h18" />
      <path d="M16 14.5h.01" />
    </>
  ),
  tax: (
    <>
      <circle cx="7" cy="7" r="2.5" />
      <circle cx="17" cy="17" r="2.5" />
      <line x1="19" y1="5" x2="5" y2="19" />
    </>
  ),
  tasks: (
    <>
      <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
      <path d="M10 21a2 2 0 0 0 4 0" />
    </>
  ),
  documents: <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />,
  mail: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M3 7l9 6 9-6" />
    </>
  ),
  admin: (
    <>
      <line x1="4" y1="6" x2="20" y2="6" />
      <circle cx="9" cy="6" r="2" />
      <line x1="4" y1="12" x2="20" y2="12" />
      <circle cx="15" cy="12" r="2" />
      <line x1="4" y1="18" x2="20" y2="18" />
      <circle cx="7" cy="18" r="2" />
    </>
  ),
  "doc-file": (
    <>
      <path d="M6 2h9l5 5v15H6z" />
      <path d="M15 2v5h5" />
    </>
  ),
  download: (
    <>
      <path d="M12 3v11m0 0l-4-4m4 4l4-4" />
      <path d="M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" />
    </>
  ),
  upload: (
    <>
      <path d="M12 21V10m0 0l-4 4m4-4l4 4" />
      <path d="M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" />
    </>
  ),
  notepad: (
    <>
      <rect x="5" y="4" width="14" height="17" rx="1" />
      <path d="M9 2v3M12 2v3M15 2v3" />
      <path d="M8 9h8M8 12.5h8M8 16h5" />
    </>
  ),
  export: (
    <>
      <path d="M3 8l1.5-4h15L21 8" />
      <rect x="3" y="8" width="18" height="12" rx="1" />
      <line x1="9" y1="13" x2="15" y2="13" />
    </>
  ),
  tag: (
    <>
      <path d="M20 12.5L11.5 21 3 12.5V4h8.5z" />
      <circle cx="7.5" cy="7.5" r="1.2" />
    </>
  ),
  usage: (
    <>
      <path d="M4 16a8 8 0 0 1 16 0" />
      <path d="M12 16l4-4" />
      <path d="M12 16h.01" />
    </>
  ),
  done: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M8 12l3 3 6-6" />
    </>
  ),
  skip: (
    <>
      <path d="M5 5l11 7-11 7V5z" />
      <line x1="19" y1="5" x2="19" y2="19" />
    </>
  ),
  "not-needed": (
    <>
      <circle cx="12" cy="12" r="9" />
      <line x1="5.5" y1="18.5" x2="18.5" y2="5.5" />
    </>
  ),
  history: (
    <>
      <path d="M3 3v5h5" />
      <path d="M3.5 9a9 9 0 1 0 2-6.5" />
      <path d="M13 8v5l3 2" />
    </>
  ),
  pause: (
    <>
      <line x1="8" y1="5" x2="8" y2="19" />
      <line x1="16" y1="5" x2="16" y2="19" />
    </>
  ),
  resume: <path d="M6 4l14 8-14 8V4z" />,
};

export function Icon({ name, size = "sm" }: { name: IconName; size?: "sm" | "lg" }) {
  return (
    <svg className={size === "lg" ? "icon icon-lg" : "icon"} viewBox="0 0 24 24" aria-hidden="true">
      {PATHS[name]}
    </svg>
  );
}
