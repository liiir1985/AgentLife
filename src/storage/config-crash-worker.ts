import { RuntimeStore } from "./runtime-store.js";
import type { FailurePoint } from "./runtime-store-probe.js";

/**
 * Crash harness for configuration commits: writes exactly one runtime config
 * version and then dies at the requested point. A hard `process.exit` leaves the
 * database exactly as the commit left it, which is what recovery has to read.
 *
 * Exit codes: 0 committed and acknowledged, 3 committed without acknowledgement,
 * 1 died before the commit.
 */
const [filename, failurePoint, identity] = process.argv.slice(2) as [string, FailurePoint, string];
if (filename === undefined || failurePoint === undefined || identity === undefined)
  throw new Error("usage: config-crash-worker <db-file> <failure-point> <identity>");

const store = new RuntimeStore(filename);
const document = {
  kernelVersion: "1.0.0",
  systems: [{ systemId: "agentlife.world", version: "1.0.0", specHash: "spec-1.0.0" }],
  packs: [
    {
      namespace: "agentlife.demo",
      root: true,
      contentId: "content-identity",
      manifest: {
        namespace: "agentlife.demo",
        version: "1.0.0",
        kernel: ">=1.0.0 <2.0.0",
        dependencies: [],
        systems: ["agentlife.world/system@1.0.0"],
        sections: {},
      },
      items: [],
      rules: [],
      formulas: [],
    },
  ],
};

try {
  store.saveConfig({ configId: identity, namespace: "agentlife.demo", packVersion: "1.0.0", document }, failurePoint);
} catch (error) {
  if (failurePoint !== "after-commit") throw error;
}
if (failurePoint === "after-commit") process.exit(3);
store.close();
process.exit(0);
