import "reflect-metadata";
import { exitWithParent } from "./processes.js";

if (process.env.DEMO_MANAGED_PROCESS !== "true") throw new Error("Use bun run demo to start demonstration processes");
exitWithParent();

if (process.env.DEMO_PAUSE_BEFORE_ACK === "true") {
  // The barrier belongs only to this demonstration bootstrap. The real adapter
  // remains unchanged, and it reaches acknowledge only after processing commits.
  const { SqsWagerQueue } = await import(new URL("../../dist/infrastructure/messaging/sqs-wager-queue.js", import.meta.url).href);
  SqsWagerQueue.prototype.acknowledge = async function (delivery: { brokerMessageId: string }): Promise<void> {
    console.log(JSON.stringify({ event: "demo_ack_paused", brokerMessageId: delivery.brokerMessageId }));
    await new Promise<void>(() => {});
  };
}

await import(new URL("../../dist/main.js", import.meta.url).href);
