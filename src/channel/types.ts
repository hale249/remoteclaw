export interface InboundMessage {
  userId: string;
  telegramId: number;
  userName: string;
  chatId: number;
  threadId?: number;
  text: string;
  isCommand: boolean;
  command?: string;
  args?: string;
}

export interface Gateway {
  onMessage(handler: (msg: InboundMessage) => void): void;
  send(chatId: number, text: string): Promise<void>;
  start(): void;
  stop(): void;
}
