import { SendMessageCommand, type SQSClient } from "@aws-sdk/client-sqs";
import { EventPublisher } from "../../application/event-publisher.js";
import type { OutboxMessage } from "../../domain/outbox-message.js";
import { getEventsQueueUrl } from "./sqs-client.js";
import { SpanKind } from "@opentelemetry/api";
import { currentTraceCarrier, extractTraceContext, inSpan } from "../observability/tracing.js";

export class SqsEventPublisher extends EventPublisher {
  constructor(private readonly client: SQSClient, private queueUrl?: string) { super(); }

  override async publish(message: OutboxMessage): Promise<void> {
    await inSpan("sqs.outbox.publish", SpanKind.PRODUCER, async () => {
      this.queueUrl ??= await getEventsQueueUrl(this.client);
      const attributes = Object.fromEntries(Object.entries(currentTraceCarrier())
        .map(([key, value]) => [key, { DataType: "String", StringValue: value }]));
      await this.client.send(new SendMessageCommand({
        QueueUrl: this.queueUrl,
        // Reuse the persisted envelope/eventId on every send, including crash recovery.
        MessageBody: JSON.stringify(message.payload),
        ...(Object.keys(attributes).length ? { MessageAttributes: attributes } : {}),
      }), { abortSignal: AbortSignal.timeout(5_000) });
    }, { "messaging.system": "aws_sqs", "messaging.operation.type": "send", "messaging.message.id": message.id,
      "wagering.event_type": message.eventType }, extractTraceContext(message.payload));
  }
}
