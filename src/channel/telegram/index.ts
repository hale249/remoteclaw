import { Bot } from "grammy";
import type { Gateway, InboundMessage } from "../types.js";
import type { Config } from "../../config/index.js";
import type { Logger } from "pino";

export class TelegramGateway implements Gateway {
  private bot: Bot;
  private handler?: (msg: InboundMessage) => void;
  private allowedIds: Set<number>;

  constructor(
    private config: NonNullable<Config["channels"]["telegram"]>,
    private auth: Config["auth"],
    private logger: Logger,
  ) {
    this.bot = new Bot(config.bot_token);
    this.allowedIds = new Set(auth.allowed_telegram_ids);
    this.setup();
  }

  onMessage(handler: (msg: InboundMessage) => void) {
    this.handler = handler;
  }

  async send(chatId: number, text: string) {
    // Telegram max message length = 4096
    const truncated = text.length > 4000 ? text.slice(0, 4000) + "..." : text;
    await this.bot.api.sendMessage(chatId, truncated, { parse_mode: "HTML" });
  }

  start() {
    this.logger.info("telegram bot starting");
    this.bot.start({ onStart: () => this.logger.info("telegram bot started") });
  }

  stop() {
    this.bot.stop();
  }

  private setup() {
    // Auth middleware
    this.bot.use(async (ctx, next) => {
      const senderId = ctx.from?.id;
      if (!senderId || !this.allowedIds.has(senderId)) {
        this.logger.warn({ senderId }, "unauthorized access");
        await ctx.reply("Access denied.");
        return;
      }
      await next();
    });

    // Commands
    this.bot.command("start", (ctx) =>
      ctx.reply("<b>RemoteClaw</b> — AI Coding Agent\n\nSend a message or use /help", { parse_mode: "HTML" }),
    );

    this.bot.command("help", (ctx) =>
      ctx.reply(
        `<b>Commands:</b>
/projects — List projects
/switch &lt;name&gt; — Switch project
/preview — Get preview URL
/status — Show status
/agents — List agent profiles
/skills — List available skills
/memory — Show project memory
/cron — Show cron jobs
/cost — Today's spend
/help — This message

<b>Skills:</b> /deploy /review /test /fix /explain /refactor

Send any text to start coding.`,
        { parse_mode: "HTML" },
      ),
    );

    for (const cmd of ["projects", "switch", "preview", "status", "agents", "skills", "memory", "cron", "cost"]) {
      this.bot.command(cmd, (ctx) => {
        this.dispatch(ctx, true, cmd, ctx.match ?? "");
      });
    }

    // Free text
    this.bot.on("message:text", (ctx) => {
      this.dispatch(ctx, false, undefined, ctx.message.text);
    });
  }

  private dispatch(ctx: any, isCommand: boolean, command?: string, args?: string) {
    if (!this.handler) return;

    this.handler({
      userId: `tg_${ctx.from.id}`,
      telegramId: ctx.from.id,
      userName: ctx.from.first_name ?? "User",
      chatId: ctx.chat.id,
      threadId: ctx.message?.message_thread_id,
      text: isCommand ? (args ?? "") : ctx.message?.text ?? "",
      isCommand,
      command,
      args,
    });
  }
}
