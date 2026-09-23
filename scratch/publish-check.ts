import { publishDemoConfig } from "../src/simulation/demo.js";

const { config } = await publishDemoConfig();
process.stdout.write(
  `${JSON.stringify(
    config.items.map((item) => `${item.ref}:${item.typeRef}`),
    null,
    1,
  )}\n`,
);
