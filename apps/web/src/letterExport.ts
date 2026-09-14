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

interface TextRunSpec {
  text: string;
  bold: boolean;
}

// `**Subheading**` is the one piece of markdown the drafting agent is
// allowed to produce (see letters.ts's drafter prompt) -- rendered bold
// here rather than left as literal asterisks, the same convention
// LetterGeneratorPage.tsx's renderWithTokens uses for the on-screen chat.
function parseBoldRuns(line: string): TextRunSpec[] {
  const parts = line.split(/(\*\*[^*]+\*\*)/g).filter((part) => part.length > 0);
  if (parts.length === 0) return [{ text: "", bold: false }];
  return parts.map((part) => {
    const match = /^\*\*([^*]+)\*\*$/.exec(part);
    return match ? { text: match[1] ?? "", bold: true } : { text: part, bold: false };
  });
}

export async function generateLetterDocx(body: string): Promise<Blob> {
  const { Document, Packer, Paragraph, TextRun } = await import("docx");

  const paragraphs = toParagraphs(body).map(
    (lines) =>
      new Paragraph({
        children: lines.flatMap((line, i) => [
          ...(i > 0 ? [new TextRun({ text: "", break: 1 })] : []),
          ...parseBoldRuns(line).map((run) => new TextRun({ text: run.text, bold: run.bold })),
        ]),
        spacing: { after: 240 },
      }),
  );

  const doc = new Document({ sections: [{ children: paragraphs }] });
  return Packer.toBlob(doc);
}

const PAGE_SIZE: [number, number] = [595.28, 841.89]; // A4

interface Word {
  text: string;
  bold: boolean;
}

function toWords(line: string): Word[] {
  const words: Word[] = [];
  for (const run of parseBoldRuns(line)) {
    for (const word of run.text.split(" ")) {
      if (word !== "") words.push({ text: word, bold: run.bold });
    }
  }
  return words;
}

// Word-by-word wrapping (rather than the whole line at once) so a bold
// subheading and a plain paragraph can each be measured against their own
// font's metrics, and so a line that mixes the two (rare, but the prompt
// doesn't forbid it) still wraps and draws correctly.
function wrapWords(
  words: Word[],
  font: import("pdf-lib").PDFFont,
  boldFont: import("pdf-lib").PDFFont,
  size: number,
  maxWidth: number,
): Word[][] {
  if (words.length === 0) return [[]];
  const spaceWidth = font.widthOfTextAtSize(" ", size);
  const lines: Word[][] = [];
  let current: Word[] = [];
  let currentWidth = 0;
  for (const word of words) {
    const wordWidth = (word.bold ? boldFont : font).widthOfTextAtSize(word.text, size);
    const nextWidth = currentWidth + (current.length > 0 ? spaceWidth : 0) + wordWidth;
    if (current.length > 0 && nextWidth > maxWidth) {
      lines.push(current);
      current = [word];
      currentWidth = wordWidth;
    } else {
      current.push(word);
      currentWidth = nextWidth;
    }
  }
  if (current.length > 0) lines.push(current);
  return lines;
}

export async function generateLetterPdf(body: string): Promise<Uint8Array> {
  const { PDFDocument, StandardFonts, rgb } = await import("pdf-lib");

  const INK = rgb(0.11, 0.094, 0.082);
  const doc = await PDFDocument.create();
  let page = doc.addPage(PAGE_SIZE);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const boldFont = await doc.embedFont(StandardFonts.HelveticaBold);

  const margin = 56;
  const size = 11;
  const lineHeight = 16;
  const maxWidth = page.getWidth() - margin * 2;
  const spaceWidth = font.widthOfTextAtSize(" ", size);
  let y = page.getHeight() - margin;

  for (const paragraph of toParagraphs(body)) {
    for (const rawLine of paragraph) {
      const wrapped = rawLine.trim() === "" ? [[]] : wrapWords(toWords(rawLine), font, boldFont, size, maxWidth);
      for (const line of wrapped) {
        if (y < margin) {
          page = doc.addPage(PAGE_SIZE);
          y = page.getHeight() - margin;
        }
        let x = margin;
        for (const word of line) {
          const wordFont = word.bold ? boldFont : font;
          page.drawText(word.text, { x, y, size, font: wordFont, color: INK });
          x += wordFont.widthOfTextAtSize(word.text, size) + spaceWidth;
        }
        y -= lineHeight;
      }
    }
    y -= lineHeight * 0.5;
  }

  return doc.save();
}
