import { matchesKey, type Component } from "@earendil-works/pi-tui";
import type { AvailableAction } from "../interaction/context-actions.js";

/** Horizontal, content-driven action chooser used at the stable main-screen boundary. */
export class ContextActionBar implements Component {
  private selectedRef: string | undefined;

  constructor(private readonly actions: () => readonly AvailableAction[]) {}

  current(): AvailableAction | undefined {
    const values = this.actions();
    const selected = values.find((entry) => entry.command.ref === this.selectedRef) ?? values[0];
    this.selectedRef = selected?.command.ref;
    return selected;
  }

  move(delta: -1 | 1): void {
    const values = this.actions();
    if (values.length === 0) {
      this.selectedRef = undefined;
      return;
    }
    const current = this.current();
    const index = Math.max(
      0,
      values.findIndex((entry) => entry.command.ref === current?.command.ref),
    );
    this.selectedRef = values[(index + delta + values.length) % values.length]?.command.ref;
  }

  handleInput(data: string): void {
    if (matchesKey(data, "left")) this.move(-1);
    else if (matchesKey(data, "right")) this.move(1);
  }

  invalidate(): void {}

  render(width: number): string[] {
    const values = this.actions();
    if (values.length === 0) return ["当前没有可执行动作".slice(0, width)];
    const current = this.current();
    const text = `◀  ${values
      .map((entry) => (entry.command.ref === current?.command.ref ? `[${entry.command.name}]` : entry.command.name))
      .join("   ")}  ▶`;
    return [text.slice(0, width)];
  }
}
