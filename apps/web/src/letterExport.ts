// Client-side document generation for Correspondence -- both libraries are
// dynamically imported so their runtime weight (docx, pdf-lib) only loads
// once someone actually exports a letter, same lazy pattern as
// invoicePdf.ts's PDF generation. The exported file always contains the
// draft body verbatim, {{TOKEN}} placeholders and all -- filling those in
// stays a step the account holder does outside the system, same as saving
// to Correspondence history.

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

// Blank lines become paragraph breaks; single line breaks within a
// paragraph are kept as line breaks rather than merged, since the drafting
// agent sometimes uses them for address blocks or a sign-off.
function toParagraphs(body: string): string[][] {
  return body.split(/\n{2,}/).map((paragraph) => paragraph.split("\n"));
}

export async function generateLetterDocx(body: string): Promise<Blob> {
  const { Document, Packer, Paragraph, TextRun } = await import("docx");

  const paragraphs = toParagraphs(body).map(
    (lines) =>
      new Paragraph({
        children: lines.flatMap((line, i) => [
          ...(i > 0 ? [new TextRun({ text: "", break: 1 })] : []),
          new TextRun(line),
        ]),
        spacing: { after: 240 },
      }),
  );

  const doc = new Document({ sections: [{ children: paragraphs }] });
  return Packer.toBlob(doc);
}

const PAGE_SIZE: [number, number] = [595.28, 841.89]; // A4

function wrapLine(text: string, font: import("pdf-lib").PDFFont, size: number, maxWidth: number): string[] {
  if (text.trim() === "") return [""];
  const words = text.split(" ");
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (current && font.widthOfTextAtSize(candidate, size) > maxWidth) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines;
}

export async function generateLetterPdf(body: string): Promise<Uint8Array> {
  const { PDFDocument, StandardFonts, rgb } = await import("pdf-lib");

  const INK = rgb(0.11, 0.094, 0.082);
  const doc = await PDFDocument.create();
  let page = doc.addPage(PAGE_SIZE);
  const font = await doc.embedFont(StandardFonts.Helvetica);

  const margin = 56;
  const size = 11;
  const lineHeight = 16;
  const maxWidth = page.getWidth() - margin * 2;
  let y = page.getHeight() - margin;

  for (const paragraph of toParagraphs(body)) {
    for (const rawLine of paragraph) {
      for (const line of wrapLine(rawLine, font, size, maxWidth)) {
        if (y < margin) {
          page = doc.addPage(PAGE_SIZE);
          y = page.getHeight() - margin;
        }
        page.drawText(line, { x: margin, y, size, font, color: INK });
        y -= lineHeight;
      }
    }
    y -= lineHeight * 0.5;
  }

  return doc.save();
}
