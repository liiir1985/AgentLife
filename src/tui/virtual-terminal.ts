import { visibleWidth, type Terminal } from "@earendil-works/pi-tui";

type InputHandler = (data: string) => void;
type ResizeHandler = () => void;

/**
 * Terminal double for automated TUI tests: it records frames into a screen buffer and
 * lets a test deliver input and resizes exactly when it wants to.
 *
 * It understands the subset of ANSI the renderer emits (absolute cursor placement,
 * line/screen erase, SGR and OSC/APC noise) which is all the spike needs to read back
 * what a user would have seen.
 */
export class VirtualTerminal implements Terminal {
  private readonly lines: string[] = [];
  private cursorRow = 0;
  private cursorCol = 0;
  private onInput: InputHandler | undefined;
  private onResize: ResizeHandler | undefined;

  /** Number of `write` calls the renderer made, i.e. rendered frames. */
  frames = 0;
  /** Every byte written since construction, escape sequences included. */
  raw = "";
  title = "";
  cursorVisible = false;

  constructor(
    private cols: number,
    private lineCount: number,
    private readonly kitty: boolean = false,
  ) {}

  get columns(): number {
    return this.cols;
  }

  get rows(): number {
    return this.lineCount;
  }

  get kittyProtocolActive(): boolean {
    return this.kitty;
  }

  start(onInput: InputHandler, onResize: ResizeHandler): void {
    this.onInput = onInput;
    this.onResize = onResize;
  }

  stop(): void {
    this.onInput = undefined;
    this.onResize = undefined;
  }

  async drainInput(): Promise<void> {}

  /** Deliver raw terminal input as if the user typed it. */
  sendInput(data: string): void {
    if (this.onInput === undefined) throw new Error("VirtualTerminal has not been started");
    this.onInput(data);
  }

  /** Change the reported window size and notify the renderer. */
  resize(cols: number, lineCount: number): void {
    this.cols = cols;
    this.lineCount = lineCount;
    this.onResize?.();
  }

  /** The visible screen, one string per row, trailing blanks trimmed. */
  screen(): string[] {
    const rows: string[] = [];
    for (let row = 0; row < this.lineCount; row += 1) rows.push((this.lines[row] ?? "").replace(/\s+$/, ""));
    return rows;
  }

  write(data: string): void {
    this.frames += 1;
    this.raw += data;
    const characters = Array.from(data);
    for (let index = 0; index < characters.length; index += 1) {
      const character = characters[index] as string;
      if (character === "\x1b") {
        index = this.consumeEscape(characters, index);
        continue;
      }
      if (character === "\r") {
        this.cursorCol = 0;
        continue;
      }
      if (character === "\n") {
        this.cursorRow = Math.min(this.lineCount - 1, this.cursorRow + 1);
        continue;
      }
      this.putCharacter(character);
    }
  }

  moveBy(lines: number): void {
    this.cursorRow = Math.max(0, Math.min(this.lineCount - 1, this.cursorRow + lines));
    this.cursorCol = 0;
  }

  hideCursor(): void {
    this.cursorVisible = false;
  }

  showCursor(): void {
    this.cursorVisible = true;
  }

  clearLine(): void {
    this.lines[this.cursorRow] = "";
  }

  clearFromCursor(): void {
    this.lines[this.cursorRow] = (this.lines[this.cursorRow] ?? "").slice(0, this.cursorCol);
  }

  clearScreen(): void {
    this.lines.length = 0;
  }

  setTitle(title: string): void {
    this.title = title;
  }

  setProgress(): void {}

  /** Consume one escape sequence starting at `start`; returns its last index. */
  private consumeEscape(characters: readonly string[], start: number): number {
    const kind = characters[start + 1];
    if (kind === "[") {
      let end = start + 2;
      while (end < characters.length && !isFinalByte(characters[end] as string)) end += 1;
      this.applyControlSequence(characters.slice(start + 2, end).join("") as string, characters[end] as string);
      return end;
    }
    if (kind === "]" || kind === "_") {
      let end = start + 2;
      while (end < characters.length) {
        if (characters[end] === "\x07") return end;
        if (characters[end] === "\x1b" && characters[end + 1] === "\\") return end + 1;
        end += 1;
      }
      return end;
    }
    return start + 1;
  }

  private applyControlSequence(parameters: string, final: string): void {
    const [first = "", second = ""] = parameters.replace(/^\?/, "").split(";");
    if (final === "H" || final === "f") {
      this.cursorRow = Math.max(0, Number(first || "1") - 1);
      this.cursorCol = Math.max(0, Number(second || "1") - 1);
      return;
    }
    if (final === "K") {
      if (parameters === "2") this.lines[this.cursorRow] = "";
      else this.clearFromCursor();
      return;
    }
    if (final === "J" && parameters === "2") {
      this.lines.length = 0;
      return;
    }
    if (final === "A") this.moveBy(-Number(first || "1"));
  }

  private putCharacter(character: string): void {
    const width = visibleWidth(character);
    if (width === 0) return;
    const line = this.lines[this.cursorRow] ?? "";
    const padding = Math.max(0, this.cursorCol - visibleWidth(line));
    this.lines[this.cursorRow] = line + " ".repeat(padding) + character;
    this.cursorCol += width;
  }
}

function isFinalByte(character: string): boolean {
  return character >= "@" && character <= "~";
}
