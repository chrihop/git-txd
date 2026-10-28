import { readFile } from "node:fs/promises";
import { Coordinator } from "../dist/coordinator.js";
import { Repository } from "../dist/repository.js";

const config = JSON.parse(await readFile(process.argv[2], "utf8"));
const stage = process.argv[3];
const method = { staged: "stage", committed: "commit", pushed: "push" }[stage];
const original = Repository.prototype[method];
Repository.prototype[method] = async function (...args) {
  const result = await original.apply(this, args);
  process.stdout.write("CHECKPOINT\n");
  await new Promise(() => {
    setInterval(() => {}, 1000);
  });
  return result;
};
const coordinator = await Coordinator.open(config);
await coordinator.commitAndPush({
  request_id: "crash",
  files: [{ path: "crash.txt", operation: "add" }],
  message: "Add crash",
});
