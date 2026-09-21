import { Type } from "typebox";
import { RuntimeStoreProbe, type FailurePoint } from "./runtime-store-probe.js";

/**
 * Crash harness: performs exactly one commit against a real database file and then
 * dies at the requested point. A hard `process.exit` leaves no chance to roll back,
 * which is precisely the failure shape recovery has to survive.
 *
 * Exit codes: 0 committed and acknowledged, 3 died without acknowledging.
 */
const [filename, failurePoint] = process.argv.slice(2) as [string, FailurePoint];
if (filename === undefined || failurePoint === undefined)
  throw new Error("usage: crash-worker <db-file> <failure-point>");

const store = new RuntimeStoreProbe(filename);
store.registerPayloadSchema("1", "probe", Type.Object({ value: Type.Number() }));
store.initializeTimeline("timeline-a");
try {
  store.commitSnapshot(
    {
      timelineId: "timeline-a",
      tick: 1,
      phase: "stable",
      payload: { schemaVersion: "1", type: "probe", data: { value: 1 } },
    },
    "round-1:tick-1",
    failurePoint,
  );
} catch (error) {
  // A crash inside or before the transaction must escape: the transaction is left
  // open and recovery has to roll it back on the next open.
  if (failurePoint !== "after-commit") throw error;
}
if (failurePoint === "after-commit") process.exit(3);
store.close();
process.exit(0);
