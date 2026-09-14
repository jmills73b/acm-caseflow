// Client-side text extraction for Correspondence's Analysis stage document
// upload: a PDF or Word file never leaves the browser as a file -- only the
// extracted, user-reviewed text is ever sent anywhere (see
// LetterGeneratorPage.tsx's document-attach panel). Both libraries are
// dynamically imported so their runtime weight only loads once someone
// actually attaches a document, same lazy pattern as letterExport.ts's
// docx/pdf-lib generation.

const SUPPORTED_EXTENSIONS = [".pdf", ".docx"] as const;

export function isSupportedDocument(file: File): boolean {
  const name = file.name.toLowerCase();
  return SUPPORTED_EXTENSIONS.some((ext) => name.endsWith(ext));
}

async function extractPdfText(file: File): Promise<string> {
  const pdfjs = await import("pdfjs-dist");
  const workerUrl = (await import("pdfjs-dist/build/pdf.worker.min.mjs?url")).default;
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

  const data = await file.arrayBuffer();
  const doc = await pdfjs.getDocument({ data }).promise;
  const pages: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    pages.push(content.items.map((item) => ("str" in item ? item.str : "")).join(" "));
  }
  return pages.join("\n\n").trim();
}

async function extractDocxText(file: File): Promise<string> {
  const mammoth = await import("mammoth");
  const arrayBuffer = await file.arrayBuffer();
  const result = await mammoth.extractRawText({ arrayBuffer });
  return result.value.trim();
}

// Dispatches on file extension rather than MIME type -- browsers report
// inconsistent MIME types for .docx (some send the generic
// application/zip), while the extension is exactly what the file picker's
// `accept` already filtered on.
export async function extractDocumentText(file: File): Promise<string> {
  const name = file.name.toLowerCase();
  if (name.endsWith(".pdf")) return extractPdfText(file);
  if (name.endsWith(".docx")) return extractDocxText(file);
  throw new Error("Unsupported file type -- only PDF and Word (.docx) documents can be attached");
}
