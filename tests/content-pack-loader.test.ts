import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ContentPackLoader, type ContentPackSnapshot } from "../src/content/content-pack-loader.js";

const FIXTURE_PACK = fileURLToPath(new URL("fixtures/content-pack", import.meta.url));
const loader = new ContentPackLoader();

const TEMP_FILES: Record<string, string> = {
  "manifest.yaml": "id: temp\nlocations: locations.yaml\n",
  "locations.yaml": "locations:\n  - id: plaza\n    detail: plaza.md\n",
  "plaza.md": "# Plaza\n\nBack to [locations](locations.yaml).\n",
};

async function withTempDirectory<T>(run: (directory: string) => Promise<T>): Promise<T> {
  const directory = mkdtempSync(path.join(tmpdir(), "agent-life-pack-"));
  try {
    return await run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function writePack(directory: string, files: readonly (readonly [string, string])[]): void {
  for (const [name, content] of files) {
    const absolute = path.join(directory, name);
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, content);
  }
}

function expectRejection(promise: Promise<unknown>, message: RegExp): Promise<void> {
  return expect(promise).rejects.toThrow(message);
}

describe("ContentPackLoader", () => {
  it("loads the fixture pack with its manifest, references and hashed identity", async () => {
    const snapshot = await loader.load(FIXTURE_PACK);

    expect(snapshot.manifest).toEqual({
      id: "phase-0-fixture",
      title: "Phase 0 Fixture Pack",
      locations: "locations.yaml",
      overview: "overview.md",
    });
    expect(snapshot.references).toEqual(["locations.yaml", "overview.md", "plaza.md"]);
    expect(snapshot.files.map((file) => file.path)).toEqual([
      "locations.yaml",
      "manifest.yaml",
      "overview.md",
      "plaza.md",
    ]);
    expect(snapshot.identity).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(snapshot.files.find((file) => file.path === "locations.yaml")?.document).toEqual({
      locations: [{ id: "plaza", name: "Plaza", detail: "plaza.md" }],
    });
    expect(snapshot.files.find((file) => file.path === "plaza.md")?.document).toBeUndefined();
  });

  it("freezes the snapshot, its file list and every file", async () => {
    const snapshot = await loader.load(FIXTURE_PACK);

    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.files)).toBe(true);
    expect(Object.isFrozen(snapshot.references)).toBe(true);
    expect(snapshot.files.every((file) => Object.isFrozen(file))).toBe(true);
    expect(() => (snapshot.files as ContentPackSnapshot["files"] as unknown[]).push({})).toThrow(TypeError);
  });

  it("derives the same identity regardless of traversal order", async () => {
    const entries = Object.entries(TEMP_FILES);
    const forward = await withTempDirectory(async (directory) => {
      writePack(directory, entries);
      return loader.load(directory);
    });
    const reversed = await withTempDirectory(async (directory) => {
      writePack(directory, [...entries].reverse());
      return loader.load(directory);
    });

    expect(forward.identity).toBe(reversed.identity);
    expect(forward.files.map((file) => file.path)).toEqual(reversed.files.map((file) => file.path));
  });

  it("changes the identity whenever a participating file changes", async () => {
    await withTempDirectory(async (directory) => {
      writePack(directory, Object.entries(TEMP_FILES));
      const original = await loader.load(directory);

      writeFileSync(path.join(directory, "plaza.md"), "# Plaza\n\nEdited.\n");
      const edited = await loader.load(directory);
      expect(edited.identity).not.toBe(original.identity);

      writeFileSync(path.join(directory, "plaza.md"), TEMP_FILES["plaza.md"]!);
      const restored = await loader.load(directory);
      expect(restored.identity).toBe(original.identity);

      rmSync(path.join(directory, "plaza.md"));
      await expectRejection(loader.load(directory), /Missing content file: plaza\.md/);
    });
  });

  it("cannot be tricked by moving bytes across file boundaries", async () => {
    const manifest = "id: temp\nfirst: first.md\nsecond: second.md\n";
    const split = async (first: string, second: string): Promise<string> =>
      withTempDirectory(async (directory) => {
        writePack(directory, [
          ["manifest.yaml", manifest],
          ["first.md", first],
          ["second.md", second],
        ]);
        return (await loader.load(directory)).identity;
      });

    expect(await split("ab", "c")).not.toBe(await split("a", "bc"));
  });

  it("rejects absolute, drive-letter and escaping references", async () => {
    const cases: readonly (readonly [string, RegExp])[] = [
      ["id: temp\nnote: /etc/passwd.md\n", /Absolute content reference is not allowed/],
      ["id: temp\nnote: C:/secret.md\n", /Absolute content reference is not allowed/],
      ["id: temp\nnote: ../outside.md\n", /Content reference escapes pack root/],
      ["id: temp\nnote: ..\\outside.md\n", /Content reference escapes pack root/],
      ["id: temp\nnote: nested/../../outside.md\n", /Content reference escapes pack root/],
    ];

    for (const [manifest, message] of cases) {
      await withTempDirectory(async (directory) => {
        writePack(directory, [["manifest.yaml", manifest]]);
        await expectRejection(loader.load(directory), message);
      });
    }
  });

  it("rejects markdown links that escape the pack", async () => {
    await withTempDirectory(async (directory) => {
      writePack(directory, [
        ["manifest.yaml", "id: temp\nnote: notes.md\n"],
        ["notes.md", "[outside](../outside.md)\n"],
      ]);
      await expectRejection(loader.load(directory), /Content reference escapes pack root/);
    });
  });

  it("rejects missing referenced files and unsupported extensions", async () => {
    await withTempDirectory(async (directory) => {
      writePack(directory, [["manifest.yaml", "id: temp\nnote: missing.md\n"]]);
      await expectRejection(loader.load(directory), /Missing content file: missing\.md/);
    });

    await withTempDirectory(async (directory) => {
      writePack(directory, [
        ["manifest.yaml", "id: temp\n"],
        ["notes.txt", "plain text\n"],
      ]);
      await expectRejection(loader.load(directory), /Unsupported content file: notes\.txt/);
    });
  });

  it("refuses directory junctions that point outside the pack before reading through them", async () => {
    await withTempDirectory(async (directory) => {
      const pack = path.join(directory, "pack");
      const outside = path.join(directory, "outside");
      writePack(pack, [["manifest.yaml", "id: temp\n"]]);
      writePack(outside, [
        ["secret.md", "EXTERNAL SECRET\n"],
        ["secret.bin", "EXTERNAL SECRET\n"],
      ]);
      symlinkSync(outside, path.join(pack, "linked"), "junction");

      // The walk refuses the link itself: were it followed, the unsupported
      // secret.bin would be reported instead, and secret.md would be read.
      await expectRejection(loader.load(pack), /Symbolic links are not allowed: linked/);
    });
  });

  it("refuses file symlinks when the platform permits creating them", async (context) => {
    await withTempDirectory(async (directory) => {
      const pack = path.join(directory, "pack");
      const outside = path.join(directory, "outside.md");
      writePack(pack, [["manifest.yaml", "id: temp\n"]]);
      writeFileSync(outside, "EXTERNAL SECRET\n");
      try {
        symlinkSync(outside, path.join(pack, "linked.md"), "file");
      } catch (error) {
        context.skip();
        return;
      }
      await expectRejection(loader.load(pack), /Symbolic links are not allowed: linked\.md/);
    });
  });

  it("requires a mapping manifest", async () => {
    await withTempDirectory(async (directory) => {
      writePack(directory, [["locations.yaml", "locations: []\n"]]);
      await expectRejection(loader.load(directory), /requires manifest\.yaml/);
    });

    await withTempDirectory(async (directory) => {
      writePack(directory, [["manifest.yaml", "- not\n- a mapping\n"]]);
      await expectRejection(loader.load(directory), /must contain a mapping/);
    });
  });

  it("reports a missing pack root as a content error", async () => {
    await expectRejection(loader.load(path.join(tmpdir(), "agent-life-missing-pack")), /Content pack root is missing/);
  });
});
