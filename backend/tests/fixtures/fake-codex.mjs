import { createInterface } from "node:readline";

let initializeCount = 0;
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
const ignoredMethod = process.argv.find((argument) => argument.startsWith("--ignore-method="))?.slice("--ignore-method=".length);

lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === ignoredMethod) return;
  if (message.method === "test/exit") process.exit(1);
  if (message.method === "initialize") {
    initializeCount += 1;
    process.stdout.write(`${JSON.stringify({
      id: message.id,
      result: { protocolVersion: "test", initializeCount },
    })}\n`);
    return;
  }
  if (message.method === "thread/start") {
    process.stdout.write(`${JSON.stringify({
      id: message.id,
      result: { thread: { id: "thread-test" } },
    })}\n`);
    return;
  }
  if (message.method === "turn/start") {
    process.stdout.write(`${JSON.stringify({
      id: message.id,
      result: { turn: { id: "turn-test", status: "inProgress" } },
    })}\n`);
    process.stdout.write(`${JSON.stringify({
      method: "turn/completed",
      params: {
        threadId: message.params.threadId,
        turn: { id: "turn-test", status: "failed" },
      },
    })}\n`);
    return;
  }
  if (Object.hasOwn(message, "id")) {
    process.stdout.write(`${JSON.stringify({
      id: message.id,
      result: { method: message.method },
    })}\n`);
  }
});
