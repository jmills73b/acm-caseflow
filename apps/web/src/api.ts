import type { ClientCaseStatus } from "@acm-caseflow/core";

// Every call goes to the Worker API on its own domain, so credentials:
// "include" is required for the session cookie to be sent — plain
// same-origin defaults won't do that.
const API_URL = import.meta.env.VITE_API_URL ?? "";

export interface ClientCategory {
  id: number;
  name: string;
}

export interface Client {
  id: number;
  name: string;
  email: string | null;
  summary: string | null;
  first_invoice_date: string | null;
  caseStatus: ClientCaseStatus;
  categories: ClientCategory[];
  feeEstimate: number | null;
  feeEstimateNote: string | null;
  billedToDate: number;
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...options,
    credentials: "include",
    headers: { "Content-Type": "application/json", ...options.headers },
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}) as { error?: string });
    throw new Error(body.error ?? `Something went wrong (${res.status})`);
  }

  return res.json() as Promise<T>;
}

export function getSetupStatus(): Promise<{ completed: boolean }> {
  return request("/api/setup/status");
}

export function setup(
  email: string,
  password: string,
  fullName: string,
): Promise<{ email: string; fullName: string | null }> {
  return request("/api/setup", { method: "POST", body: JSON.stringify({ email, password, fullName }) });
}

export function login(email: string, password: string): Promise<{ email: string; fullName: string | null }> {
  return request("/api/login", { method: "POST", body: JSON.stringify({ email, password }) });
}

export function register(
  email: string,
  password: string,
  inviteCode: string,
  fullName: string,
): Promise<{ email: string; fullName: string | null }> {
  return request("/api/register", {
    method: "POST",
    body: JSON.stringify({ email, password, inviteCode, fullName }),
  });
}

export function logout(): Promise<{ ok: boolean }> {
  return request("/api/logout", { method: "POST" });
}

export function me(): Promise<{ email: string; fullName: string | null }> {
  return request("/api/me");
}

export function updateFullName(fullName: string): Promise<{ email: string; fullName: string | null }> {
  return request("/api/me", { method: "PATCH", body: JSON.stringify({ fullName }) });
}

export function getClients(): Promise<Client[]> {
  return request("/api/clients");
}

export function addClient(input: {
  name: string;
  email?: string | null;
  summary?: string | null;
  categoryIds?: number[];
  caseStatus?: ClientCaseStatus;
  feeEstimate?: number | null;
  feeEstimateNote?: string | null;
}): Promise<Client> {
  return request("/api/clients", { method: "POST", body: JSON.stringify(input) });
}

export function updateClient(
  id: number,
  patch: Partial<{
    name: string;
    email: string | null;
    summary: string | null;
    categoryIds: number[];
    caseStatus: ClientCaseStatus;
    feeEstimate: number | null;
    feeEstimateNote: string | null;
  }>,
): Promise<Client> {
  return request(`/api/clients/${id}`, { method: "PATCH", body: JSON.stringify(patch) });
}

export function deleteClient(id: number): Promise<{ ok: boolean }> {
  return request(`/api/clients/${id}`, { method: "DELETE" });
}

export function getClientCategories(): Promise<ClientCategory[]> {
  return request("/api/client-categories");
}

export function addClientCategory(name: string): Promise<ClientCategory> {
  return request("/api/client-categories", { method: "POST", body: JSON.stringify({ name }) });
}

export function renameClientCategory(id: number, name: string): Promise<ClientCategory> {
  return request(`/api/client-categories/${id}`, { method: "PATCH", body: JSON.stringify({ name }) });
}

export function deleteClientCategory(id: number): Promise<{ ok: boolean }> {
  return request(`/api/client-categories/${id}`, { method: "DELETE" });
}

export interface Invoice {
  id: number;
  invoiceDate: string;
  clientId: number;
  clientName: string;
  totalAmount: number;
  anitaIncome: number;
  status: string;
  reference: string | null;
  matter: string | null;
  batchId: number | null;
  dateSettledClient: string | null;
  dateSettledFirm: string | null;
  lagDays: number | null;
}

export function getInvoices(): Promise<Invoice[]> {
  return request("/api/invoices");
}

export function addInvoice(input: {
  invoiceDate: string;
  clientId: number;
  totalAmount: number;
  reference?: string;
  matter?: string;
}): Promise<Invoice> {
  return request("/api/invoices", { method: "POST", body: JSON.stringify(input) });
}

export function updateInvoice(
  id: number,
  patch: Partial<{
    invoiceDate: string;
    clientId: number;
    totalAmount: number;
    reference: string | null;
    matter: string | null;
    status: string;
    dateSettledClient: string | null;
    dateSettledFirm: string | null;
  }>,
): Promise<Invoice> {
  return request(`/api/invoices/${id}`, { method: "PATCH", body: JSON.stringify(patch) });
}

export function deleteInvoice(id: number): Promise<{ ok: boolean }> {
  return request(`/api/invoices/${id}`, { method: "DELETE" });
}

export interface TaxRates {
  personalAllowance: number | null;
  basicRate: number | null;
  basicRateThreshold: number | null;
  higherRate: number | null;
  higherRateThreshold: number | null;
  additionalRate: number | null;
  niLowerThreshold: number | null;
  niUpperThreshold: number | null;
  niLowerRate: number | null;
  niUpperRate: number | null;
  class2FlatRate: number | null;
}

export interface TaxYearSettings {
  startYear: number;
  taxYear: string;
  startDate: string;
  monthlyTarget: number | null;
  splitPercentage: number | null;
  rates: TaxRates;
  ratesConfirmedAt: string | null;
}

export function getTaxYearSettings(startYear: number): Promise<TaxYearSettings> {
  return request(`/api/tax-year-settings/${startYear}`);
}

export function setTaxYearTarget(startYear: number, monthlyTarget: number): Promise<TaxYearSettings> {
  return request(`/api/tax-year-settings/${startYear}`, {
    method: "POST",
    body: JSON.stringify({ monthlyTarget }),
  });
}

export function setTaxYearRates(
  startYear: number,
  rates: Record<keyof TaxRates, number>,
): Promise<TaxYearSettings> {
  return request(`/api/tax-year-settings/${startYear}/rates`, {
    method: "PUT",
    body: JSON.stringify(rates),
  });
}

export function setTaxYearSplit(startYear: number, splitPercentage: number): Promise<TaxYearSettings> {
  return request(`/api/tax-year-settings/${startYear}/split`, {
    method: "POST",
    body: JSON.stringify({ splitPercentage }),
  });
}

export interface Firm {
  id: number;
  name: string;
  contactEmail: string | null;
  contactAddress: string | null;
  contactPostcode: string | null;
  contactPhone: string | null;
}

export function getFirms(): Promise<Firm[]> {
  return request("/api/firms");
}

export function updateFirm(
  id: number,
  patch: Partial<{
    contactEmail: string | null;
    contactAddress: string | null;
    contactPostcode: string | null;
    contactPhone: string | null;
  }>,
): Promise<Firm> {
  return request(`/api/firms/${id}`, { method: "PATCH", body: JSON.stringify(patch) });
}

export interface InvoiceSettings {
  fromName: string;
  fromEmail: string;
  fromAddress: string;
  fromPostcode: string;
  fromPhone: string;
  bankAccountName: string;
  bankSortCode: string;
  bankAccountNumber: string;
  referencePrefix: string;
  nextReferenceNumber: number;
}

export function getInvoiceSettings(): Promise<InvoiceSettings> {
  return request("/api/invoice-settings");
}

export function updateInvoiceSettings(settings: InvoiceSettings): Promise<InvoiceSettings> {
  return request("/api/invoice-settings", { method: "PUT", body: JSON.stringify(settings) });
}

export interface InvoiceBatchSummary {
  id: number;
  reference: string;
  invoiceDate: string;
  totalFee: number;
  totalAmountDue: number;
  billToName: string;
  createdAt: string;
}

export interface InvoiceBatchLineItem {
  id: number;
  invoiceDate: string;
  fileNo: string | null;
  matter: string | null;
  clientName: string;
  totalAmount: number;
  anitaIncome: number;
}

export interface InvoiceBatchDetail {
  id: number;
  reference: string;
  invoiceDate: string;
  totalFee: number;
  totalAmountDue: number;
  createdAt: string;
  from: { name: string; email: string; address: string; postcode: string; phone: string };
  billTo: { name: string; email: string; address: string; postcode: string; phone: string };
  bank: { accountName: string; sortCode: string; accountNumber: string };
  lineItems: InvoiceBatchLineItem[];
}

export function getInvoiceBatches(): Promise<InvoiceBatchSummary[]> {
  return request("/api/invoice-batches");
}

export function getInvoiceBatch(id: number): Promise<InvoiceBatchDetail> {
  return request(`/api/invoice-batches/${id}`);
}

export function createInvoiceBatch(input: {
  invoiceIds: number[];
  firmId: number;
  invoiceDate: string;
}): Promise<InvoiceBatchDetail> {
  return request("/api/invoice-batches", { method: "POST", body: JSON.stringify(input) });
}

export function deleteInvoiceBatch(id: number): Promise<{ ok: boolean }> {
  return request(`/api/invoice-batches/${id}`, { method: "DELETE" });
}

export interface ExpenseCategory {
  id: number;
  name: string;
}

export function getExpenseCategories(): Promise<ExpenseCategory[]> {
  return request("/api/expense-categories");
}

export function addExpenseCategory(name: string): Promise<ExpenseCategory> {
  return request("/api/expense-categories", { method: "POST", body: JSON.stringify({ name }) });
}

export function renameExpenseCategory(id: number, name: string): Promise<ExpenseCategory> {
  return request(`/api/expense-categories/${id}`, { method: "PATCH", body: JSON.stringify({ name }) });
}

// reassignToId: where this category's existing expenses go once it's
// gone — another category's id, or null to leave them uncategorised.
export function deleteExpenseCategory(id: number, reassignToId: number | null): Promise<{ ok: boolean }> {
  return request(`/api/expense-categories/${id}`, {
    method: "DELETE",
    body: JSON.stringify({ reassignToId }),
  });
}

export interface Expense {
  id: number;
  date: string;
  description: string;
  cost: number;
  categoryId: number | null;
  category: string | null;
}

export function getExpenses(): Promise<Expense[]> {
  return request("/api/expenses");
}

export function addExpense(input: {
  date: string;
  description: string;
  cost: number;
  categoryId?: number | null;
}): Promise<Expense> {
  return request("/api/expenses", { method: "POST", body: JSON.stringify(input) });
}

export function updateExpense(
  id: number,
  patch: Partial<{ date: string; description: string; cost: number; categoryId: number | null }>,
): Promise<Expense> {
  return request(`/api/expenses/${id}`, { method: "PATCH", body: JSON.stringify(patch) });
}

export function deleteExpense(id: number): Promise<{ ok: boolean }> {
  return request(`/api/expenses/${id}`, { method: "DELETE" });
}

export interface AccountSettings {
  inviteCode: string;
  disabledFeatures: string[];
  complianceGuidelines: string;
  aiModel: string;
}

export function getAccountSettings(): Promise<AccountSettings> {
  return request("/api/account-settings");
}

export function updateAccountSettings(inviteCode: string): Promise<AccountSettings> {
  return request("/api/account-settings", { method: "PUT", body: JSON.stringify({ inviteCode }) });
}

export function updateDisabledFeatures(disabledFeatures: string[]): Promise<{ disabledFeatures: string[] }> {
  return request("/api/account-settings/features", { method: "PUT", body: JSON.stringify({ disabledFeatures }) });
}

export function updateComplianceGuidelines(complianceGuidelines: string): Promise<{ complianceGuidelines: string }> {
  return request("/api/account-settings/compliance-guidelines", {
    method: "PUT",
    body: JSON.stringify({ complianceGuidelines }),
  });
}

// Mirrors anthropic.ts's AI_MODELS on the backend -- kept as a small fixed
// list here rather than fetched, same as LetterGeneratorPage's personal-
// field tokens, since it only ever changes when a new Claude generation
// ships and this app is updated to support it.
// The first entry is the cheapest -- LetterGeneratorPage's per-letter model
// picker defaults to it (AI_MODEL_OPTIONS[0]), independent of whatever
// Admin's AI settings panel has chosen as the account-wide default.
export const AI_MODEL_OPTIONS = [
  { id: "claude-haiku-4-5", label: "Haiku 4.5 (fast & economical)" },
  { id: "claude-sonnet-5", label: "Sonnet 5 (higher quality)" },
];

export function updateAiModel(aiModel: string): Promise<{ aiModel: string }> {
  return request("/api/account-settings/ai-model", { method: "PUT", body: JSON.stringify({ aiModel }) });
}

export interface AiUsageByModel {
  model: string;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
}

export interface AiUsageSummary {
  totalInputTokens: number;
  totalOutputTokens: number;
  estimatedCostUsd: number;
  byModel: AiUsageByModel[];
}

export function getAiUsage(): Promise<AiUsageSummary> {
  return request("/api/letters/usage");
}

export interface TimeSettings {
  unitMinutes: number;
}

export function getTimeSettings(): Promise<TimeSettings> {
  return request("/api/time-settings");
}

export function updateTimeSettings(unitMinutes: number): Promise<TimeSettings> {
  return request("/api/time-settings", { method: "PUT", body: JSON.stringify({ unitMinutes }) });
}

export interface TimeCategory {
  id: number;
  name: string;
}

export function getTimeCategories(): Promise<TimeCategory[]> {
  return request("/api/time-categories");
}

export function addTimeCategory(name: string): Promise<TimeCategory> {
  return request("/api/time-categories", { method: "POST", body: JSON.stringify({ name }) });
}

export function renameTimeCategory(id: number, name: string): Promise<TimeCategory> {
  return request(`/api/time-categories/${id}`, { method: "PATCH", body: JSON.stringify({ name }) });
}

export function deleteTimeCategory(id: number, reassignToId: number | null): Promise<{ ok: boolean }> {
  return request(`/api/time-categories/${id}`, { method: "DELETE", body: JSON.stringify({ reassignToId }) });
}

export interface HourlyRate {
  id: number;
  rate: number;
  startDate: string;
  endDate: string | null;
}

export function getHourlyRates(): Promise<HourlyRate[]> {
  return request("/api/hourly-rates");
}

export function addHourlyRate(rate: number, startDate: string): Promise<HourlyRate> {
  return request("/api/hourly-rates", { method: "POST", body: JSON.stringify({ rate, startDate }) });
}

export function updateHourlyRate(id: number, rate: number): Promise<HourlyRate & { entriesUpdated: number }> {
  return request(`/api/hourly-rates/${id}`, { method: "PATCH", body: JSON.stringify({ rate }) });
}

export interface TimeEntry {
  id: number;
  clientId: number;
  clientName: string;
  matter: string | null;
  date: string;
  units: number;
  minutes: number;
  description: string;
  categoryId: number | null;
  category: string | null;
  rateAtEntry: number | null;
  feeValue: number | null;
}

export function getTimeEntries(): Promise<TimeEntry[]> {
  return request("/api/time-entries");
}

export function addTimeEntry(input: {
  date: string;
  clientId: number;
  matter?: string;
  units: number;
  description: string;
  categoryId?: number | null;
}): Promise<TimeEntry> {
  return request("/api/time-entries", { method: "POST", body: JSON.stringify(input) });
}

export function updateTimeEntry(
  id: number,
  patch: Partial<{
    date: string;
    clientId: number;
    matter: string | null;
    units: number;
    description: string;
    categoryId: number | null;
  }>,
): Promise<TimeEntry> {
  return request(`/api/time-entries/${id}`, { method: "PATCH", body: JSON.stringify(patch) });
}

export function deleteTimeEntry(id: number): Promise<{ ok: boolean }> {
  return request(`/api/time-entries/${id}`, { method: "DELETE" });
}

export interface ExportData {
  exportedAt: string;
  tables: Record<string, unknown[]>;
}

export function exportAllData(): Promise<ExportData> {
  return request("/api/export");
}

export interface UsageMetric {
  used: number;
  cap: number;
}

export interface UsageStats {
  workersRequests: UsageMetric;
  d1RowsRead: UsageMetric;
  d1RowsWritten: UsageMetric;
  d1Storage: UsageMetric;
  r2Storage: UsageMetric;
}

export function getUsage(): Promise<UsageStats> {
  return request("/api/usage");
}

export interface NoteCategory {
  id: number;
  name: string;
}

export function getNoteCategories(): Promise<NoteCategory[]> {
  return request("/api/note-categories");
}

export function addNoteCategory(name: string): Promise<NoteCategory> {
  return request("/api/note-categories", { method: "POST", body: JSON.stringify({ name }) });
}

export function renameNoteCategory(id: number, name: string): Promise<NoteCategory> {
  return request(`/api/note-categories/${id}`, { method: "PATCH", body: JSON.stringify({ name }) });
}

export function deleteNoteCategory(id: number): Promise<{ ok: boolean }> {
  return request(`/api/note-categories/${id}`, { method: "DELETE" });
}

export interface NoteVersion {
  id: number;
  date: string;
  categoryId: number | null;
  category: string | null;
  body: string;
  createdAt: string;
}

export interface ClientNoteSummary {
  id: number;
  clientId: number;
  clientName: string;
  createdAt: string;
  versionCount: number;
  latest: NoteVersion;
}

export interface ClientNoteDetail {
  id: number;
  clientId: number;
  clientName: string;
  createdAt: string;
  versions: NoteVersion[];
}

export function getClientNotes(): Promise<ClientNoteSummary[]> {
  return request("/api/client-notes");
}

export function getClientNote(id: number): Promise<ClientNoteDetail> {
  return request(`/api/client-notes/${id}`);
}

export function addClientNote(input: {
  clientId: number;
  date: string;
  categoryId?: number | null;
  body: string;
}): Promise<ClientNoteDetail> {
  return request("/api/client-notes", { method: "POST", body: JSON.stringify(input) });
}

export function addClientNoteVersion(
  id: number,
  input: { date: string; categoryId?: number | null; body: string },
): Promise<ClientNoteDetail> {
  return request(`/api/client-notes/${id}/versions`, { method: "POST", body: JSON.stringify(input) });
}

export type TaskFrequency =
  | "once"
  | "daily"
  | "weekly"
  | "fortnightly"
  | "four_weekly"
  | "monthly"
  | "quarterly"
  | "yearly";
export type TaskAction = "completed" | "skipped" | "not_needed";
export type TaskStatus = "active" | "paused" | "done";

export interface TaskOccurrence {
  id: number;
  dueDate: string;
  action: TaskAction;
  actedAt: string;
}

export interface Task {
  id: number;
  title: string;
  description: string | null;
  frequency: TaskFrequency;
  daysOfWeek: number[] | null;
  nextDueDate: string;
  dueTime: string;
  status: TaskStatus;
  completedAt: string | null;
  createdAt: string;
  clientId: number | null;
  clientName: string | null;
}

export interface TaskDetail extends Task {
  occurrences: TaskOccurrence[];
}

export function getTasks(): Promise<Task[]> {
  return request("/api/tasks");
}

export function getTask(id: number): Promise<TaskDetail> {
  return request(`/api/tasks/${id}`);
}

export function addTask(input: {
  title: string;
  description?: string | null;
  frequency: TaskFrequency;
  daysOfWeek?: number[] | null;
  nextDueDate: string;
  dueTime?: string;
  clientId?: number | null;
}): Promise<TaskDetail> {
  return request("/api/tasks", { method: "POST", body: JSON.stringify(input) });
}

export function updateTask(
  id: number,
  patch: Partial<{
    title: string;
    description: string | null;
    frequency: TaskFrequency;
    daysOfWeek: number[] | null;
    nextDueDate: string;
    dueTime: string;
    status: Exclude<TaskStatus, "done">;
    clientId: number | null;
  }>,
): Promise<TaskDetail> {
  return request(`/api/tasks/${id}`, { method: "PATCH", body: JSON.stringify(patch) });
}

export function actOnTask(id: number, action: TaskAction): Promise<TaskDetail> {
  return request(`/api/tasks/${id}/actions`, { method: "POST", body: JSON.stringify({ action }) });
}

export interface DocumentCategory {
  id: number;
  name: string;
}

export function getDocumentCategories(): Promise<DocumentCategory[]> {
  return request("/api/document-categories");
}

export function addDocumentCategory(name: string): Promise<DocumentCategory> {
  return request("/api/document-categories", { method: "POST", body: JSON.stringify({ name }) });
}

export function renameDocumentCategory(id: number, name: string): Promise<DocumentCategory> {
  return request(`/api/document-categories/${id}`, { method: "PATCH", body: JSON.stringify({ name }) });
}

export function deleteDocumentCategory(id: number): Promise<{ ok: boolean }> {
  return request(`/api/document-categories/${id}`, { method: "DELETE" });
}

export type DocumentDirection = "inbound" | "outbound";

export interface CaseDocument {
  id: number;
  clientId: number;
  clientName: string;
  categoryId: number | null;
  categoryName: string | null;
  direction: DocumentDirection;
  filename: string;
  contentType: string;
  size: number;
  uploadedByEmail: string;
  uploadedAt: string;
}

export interface DeletedDocument extends CaseDocument {
  deletedAt: string;
  deletedByEmail: string | null;
}

// clientId omitted lists every non-deleted document across every client —
// used by the holistic "All Documents" dashboard tile, as opposed to a
// specific client's own Documents page.
export function getDocuments(clientId?: number): Promise<CaseDocument[]> {
  return request(clientId !== undefined ? `/api/documents?clientId=${clientId}` : "/api/documents");
}

export function getDeletedDocuments(): Promise<DeletedDocument[]> {
  return request("/api/documents/deleted");
}

// Bypasses the JSON `request()` helper: a FormData body needs the browser
// to set its own multipart boundary Content-Type, which request()'s
// hardcoded "application/json" header would stomp on.
export async function uploadDocument(input: {
  clientId: number;
  categoryId: number | null;
  direction: DocumentDirection;
  file: File;
}): Promise<CaseDocument> {
  const form = new FormData();
  form.set("file", input.file);
  form.set("clientId", String(input.clientId));
  form.set("direction", input.direction);
  if (input.categoryId !== null) {
    form.set("categoryId", String(input.categoryId));
  }

  const res = await fetch(`${API_URL}/api/documents`, {
    method: "POST",
    credentials: "include",
    body: form,
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}) as { error?: string });
    throw new Error(body.error ?? `Something went wrong (${res.status})`);
  }

  return res.json() as Promise<CaseDocument>;
}

export function deleteDocument(id: number): Promise<{ ok: boolean }> {
  return request(`/api/documents/${id}`, { method: "DELETE" });
}

// A plain same-origin GET link (see functions/api/[[path]].ts's proxy) does
// the actual download/open — no fetch+blob handling needed, and the
// session cookie rides along automatically since this is a top-level
// navigation, which SameSite=Lax still allows.
export function documentDownloadUrl(id: number): string {
  return `${API_URL}/api/documents/${id}/download`;
}

export interface ReviewFlag {
  severity: "ok" | "concern";
  text: string;
}

export interface PiiScanMatch {
  kind: "email" | "phone" | "postcode" | "niNumber";
  match: string;
}

export type LetterFormat = "letter" | "email";

// A "letter" is a whole staged lifecycle record -- Analysis (facts and UK
// family-law basis with a legal-analyst agent) -> Composition (drafting,
// guided by the Analysis Summary) -> Review (a legal-reviewer agent checks
// the draft, looping back to Composition as needed) -> Finalized -- not
// just the finished result. See ARCHITECTURE.md's Correspondence section.
export type LetterStage = "analysis" | "composition" | "review" | "finalized";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

// One "Send to review": appended to reviewRounds, never replaced, so the
// full history survives a back-navigation to Composition and feeds the
// finalize-time narrative. selectedFlagTexts/feedbackText/respondedAt stay
// null until sendReviewFeedback is called for this round.
export interface ReviewRound {
  createdAt: string;
  draftSnapshot: string;
  piiScanClean: boolean;
  piiMatches: PiiScanMatch[];
  reviewConfigured: boolean;
  truncated: boolean;
  flags: ReviewFlag[];
  selectedFlagTexts: string[] | null;
  feedbackText: string | null;
  respondedAt: string | null;
}

// What GET /api/letters (the history list) returns -- deliberately
// excludes the message histories and review rounds, which only the
// full-detail getLetter() below includes, so a client's whole history
// doesn't ship every conversation on every page load.
export interface LetterSummary {
  id: number;
  clientId: number;
  clientName: string;
  letterType: string | null;
  format: LetterFormat;
  personalFields: string[];
  stage: LetterStage;
  draftBody: string;
  analysisSummary: string | null;
  processSummary: string | null;
  reviewFlags: ReviewFlag[] | null;
  piiScanClean: boolean | null;
  // Chosen once at creation (see createLetterSession) and fixed for the
  // session's lifetime -- null only for a letter created before this was
  // trackable, which falls back to the account's configured default model.
  aiModel: string | null;
  createdByEmail: string;
  createdAt: string;
  updatedAt: string;
}

export interface DeletedLetterSummary extends LetterSummary {
  deletedAt: string;
  deletedByEmail: string | null;
}

// clientId scopes the history to one client, which is how
// LetterGeneratorPage.tsx always calls this -- omitting it is kept for
// parity with getDocuments' all-clients mode, not currently used.
export function getLetters(clientId?: number): Promise<LetterSummary[]> {
  return request(clientId !== undefined ? `/api/letters?clientId=${clientId}` : "/api/letters");
}

export function getDeletedLetters(): Promise<DeletedLetterSummary[]> {
  return request("/api/letters/deleted");
}

// The full staged session, including every message history and review
// round -- what creating a session, resuming one, and every stage-
// transition call below returns.
export interface LetterSession extends LetterSummary {
  analysisMessages: ChatMessage[];
  compositionMessages: ChatMessage[];
  reviewRounds: ReviewRound[];
}

export function getLetter(id: number): Promise<LetterSession> {
  return request(`/api/letters/${id}`);
}

// Starts a new session at the analysis stage -- no draft yet. personalFields
// carries only token names (e.g. "CLIENT_NAME"), never real client data;
// that's fixed for the whole session, never resent as free text on a turn.
// aiModel defaults server-side to the cheapest option if omitted.
export function createLetterSession(input: {
  clientId: number;
  letterType: string;
  format: LetterFormat;
  personalFields: string[];
  aiModel?: string;
}): Promise<LetterSession> {
  return request("/api/letters", { method: "POST", body: JSON.stringify(input) });
}

export interface StageResult {
  letter: LetterSession;
  truncated: boolean;
}

// A stateful chat turn -- the server owns the conversation and appends both
// the new message and the agent's reply before persisting, so only the new
// message is ever sent here (contrast the old stateless chatDraftLetter,
// which resent the whole history every turn).
export function sendAnalysisMessage(id: number, message: string): Promise<StageResult> {
  return request(`/api/letters/${id}/analysis`, { method: "POST", body: JSON.stringify({ message }) });
}

// The explicit Analysis -> Composition handoff: turns the analyst
// conversation into a structured Analysis Summary and transitions the
// session to the composition stage.
export function summarizeAnalysis(id: number): Promise<StageResult> {
  return request(`/api/letters/${id}/analysis/summarize`, { method: "POST" });
}

export function sendCompositionMessage(id: number, message: string): Promise<StageResult> {
  return request(`/api/letters/${id}/composition`, { method: "POST", body: JSON.stringify({ message }) });
}

// Runs the deterministic personal-data scan plus the advisory legal/
// compliance review against the current draft, appends a new round to
// reviewRounds, and moves the session to the review stage.
export function requestLetterReview(id: number): Promise<StageResult> {
  return request(`/api/letters/${id}/review`, { method: "POST" });
}

// Records the user's response to the latest review round and forwards it
// as the next composition turn, routing the session back to composition --
// the reviewer's findings are never applied automatically.
export function sendReviewFeedback(
  id: number,
  input: { selectedFlagIndexes: number[]; feedbackText: string },
): Promise<StageResult> {
  return request(`/api/letters/${id}/review/feedback`, { method: "POST", body: JSON.stringify(input) });
}

// Manual back-navigation -- moves the stage pointer only. Nothing is ever
// deleted: every message array and reviewRounds only ever grow, so going
// back and having another exchange just adds to the record.
export function goBackToStage(id: number, stage: "analysis" | "composition"): Promise<StageResult> {
  return request(`/api/letters/${id}/back`, { method: "POST", body: JSON.stringify({ stage }) });
}

// Generates the AI-written narrative process summary (per the deliberate
// choice of a narrative over a structured log) and locks the session as
// finalized.
export function finalizeLetter(id: number): Promise<StageResult> {
  return request(`/api/letters/${id}/finalize`, { method: "POST" });
}

export function deleteLetter(id: number): Promise<{ ok: boolean }> {
  return request(`/api/letters/${id}`, { method: "DELETE" });
}
