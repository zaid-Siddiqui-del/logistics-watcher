import { WebClient } from "@slack/web-api";
import dotenv from "dotenv";
dotenv.config();

const slack = new WebClient(process.env.SLACK_BOT_TOKEN);

async function main() {
  const res = await slack.chat.postMessage({
    channel: process.env.SLACK_CHANNEL_ID,
    text: "✅ Logistics bot test: Hello from Node!"
  });
  console.log("Message sent, ts:", res.ts);
}

main().catch(console.error);

