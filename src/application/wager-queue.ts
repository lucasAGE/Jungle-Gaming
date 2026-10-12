export interface QueueDelivery {
  readonly brokerMessageId: string;
  readonly receiptHandle: string;
  readonly body: string;
  readonly receiveCount: number;
  readonly messageGroupId: string | undefined;
  readonly traceContext?: Readonly<Record<string, string>>;
}

export abstract class WagerQueue {
  abstract receive(): Promise<QueueDelivery | null>;
  abstract acknowledge(delivery: QueueDelivery): Promise<void>;
  abstract retry(delivery: QueueDelivery, delaySeconds: number): Promise<void>;
  abstract deadLetter(delivery: QueueDelivery, reasonCode: string): Promise<void>;
}
