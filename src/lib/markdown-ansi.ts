/**
 * Streaming Markdown → ANSI escape code converter for xterm.js.
 * Processes complete lines with formatting, streams partial lines immediately.
 * Handles: **bold**, *italic*, `code`, ```code blocks```, # headings, - bullets.
 * Word-wraps prose at a readable width.
 */

const BOLD_ON = "\x1b[1m";
const BOLD_OFF = "\x1b[22m";
const ITALIC_ON = "\x1b[3m";
const ITALIC_OFF = "\x1b[23m";
const CODE_ON = "\x1b[36m"; // cyan
const CODE_OFF = "\x1b[39m";
const HEADING_ON = "\x1b[1;32m"; // bold green
const DIM_ON = "\x1b[2m";
const RESET = "\x1b[0m";

/** Apply inline markdown formatting to a single complete line. */
function formatLine(line: string): string {
  // Inline code `...` — do first to protect contents from other transforms
  line = line.replace(/`([^`]+)`/g, `${CODE_ON}$1${CODE_OFF}`);

  // Bold **...** — matched pairs only
  line = line.replace(/\*\*([^*]+)\*\*/g, `${BOLD_ON}$1${BOLD_OFF}`);

  // Italic *...* — matched pairs only (single asterisks, not inside bold)
  line = line.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, `${ITALIC_ON}$1${ITALIC_OFF}`);

  return line;
}

/** Strip ANSI escape sequences to get visible character count. */
function visibleLength(s: string): number {
  return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}

/** Word-wrap a formatted line at the given visible width. */
function wrapText(text: string, width: number, indent = ""): string {
  if (visibleLength(text) <= width) return text;

  // Split on spaces, keeping ANSI codes attached to their words
  const words = text.split(/( +)/);
  const lines: string[] = [];
  let current = "";
  let currentLen = 0;

  for (const word of words) {
    const wordLen = visibleLength(word);
    if (currentLen + wordLen > width && currentLen > 0) {
      lines.push(current.trimEnd());
      current = indent + word.trimStart();
      currentLen = indent.length + visibleLength(word.trimStart());
    } else {
      current += word;
      currentLen += wordLen;
    }
  }
  if (current.trimEnd()) lines.push(current.trimEnd());

  return lines.join("\r\n");
}

export function createMarkdownRenderer(termCols = 120) {
  let partial = ""; // Incomplete line waiting for \n
  let partialWritten = 0; // How many chars of partial we already wrote to terminal
  let inCodeBlock = false;
  const wrapWidth = Math.min(termCols - 2, 100);

  function renderLine(line: string): string {
    // Code block fence
    if (line.trimStart().startsWith("```")) {
      inCodeBlock = !inCodeBlock;
      if (inCodeBlock) {
        return DIM_ON;
      } else {
        return RESET;
      }
    }

    // Inside code block — pass through dimmed, no wrapping
    if (inCodeBlock) {
      return line;
    }

    // Heading: # ## ### at line start — no wrapping
    const headingMatch = line.match(/^(#{1,4})\s+(.*)$/);
    if (headingMatch) {
      return HEADING_ON + headingMatch[2] + RESET;
    }

    // Bullet: - or * at line start (with optional leading spaces)
    const bulletMatch = line.match(/^(\s*)[-*]\s+(.*)$/);
    if (bulletMatch) {
      const indent = bulletMatch[1];
      const content = formatLine(bulletMatch[2]);
      const prefix = `${indent}\x1b[33m•\x1b[0m `;
      return wrapText(prefix + content, wrapWidth, indent + "  ");
    }

    // Numbered list: 1. 2. etc
    const numberedMatch = line.match(/^(\s*)(\d+)\.\s+(.*)$/);
    if (numberedMatch) {
      const indent = numberedMatch[1];
      const num = numberedMatch[2];
      const content = formatLine(numberedMatch[3]);
      const prefix = `${indent}\x1b[33m${num}.\x1b[0m `;
      return wrapText(prefix + content, wrapWidth, indent + "   ");
    }

    // Regular line — apply inline formatting and wrap
    return wrapText(formatLine(line), wrapWidth);
  }

  /** Erase partialWritten chars — may span multiple visual lines in the terminal. */
  function erasePartial(): string {
    if (partialWritten === 0) return "";
    const visualLines = Math.ceil(partialWritten / termCols);
    let esc = "";
    // Move up to the first visual line of the partial
    if (visualLines > 1) {
      esc += `\x1b[${visualLines - 1}A`; // cursor up
    }
    esc += "\r"; // go to start of line
    // Clear from cursor to end of screen (clears all visual lines below too)
    esc += "\x1b[J";
    partialWritten = 0;
    return esc;
  }

  return {
    /** Feed a chunk of streamed markdown. Returns formatted string for term.write(). */
    push(chunk: string): string {
      const input = partial + chunk;
      const lines = input.split("\n");

      // Last element is the new incomplete line
      partial = lines.pop()!;

      let out = "";

      // If we had previously written partial content and now have complete lines,
      // erase all visual lines from the partial
      if (partialWritten > 0 && lines.length > 0) {
        out += erasePartial();
      }

      // Render complete lines
      for (const line of lines) {
        out += renderLine(line) + "\r\n";
      }

      // Stream partial line immediately so text appears in real-time
      // Cap at wrapWidth to avoid terminal auto-wrapping causing duplication
      if (partial) {
        const visLen = visibleLength(partial);
        if (visLen <= wrapWidth) {
          const newChars = partial.slice(partialWritten);
          if (newChars) {
            out += newChars;
            partialWritten = partial.length;
          }
        }
        // If over wrapWidth, stop streaming — will be rendered with wrapping on line complete
      }

      return out;
    },

    /** Flush remaining partial line with formatting and reset state. */
    end(): string {
      let out = "";
      if (partial) {
        out += erasePartial();
        out += renderLine(partial);
        partial = "";
        partialWritten = 0;
      }
      if (inCodeBlock) {
        out += RESET;
        inCodeBlock = false;
      }
      return out;
    },
  };
}
