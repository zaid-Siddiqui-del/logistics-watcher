import express from "express";
import dotenv from "dotenv";
import mondaySdk from "monday-sdk-js";
import { WebClient } from "@slack/web-api";
import { GoogleGenerativeAI } from "@google/generative-ai";
import nodemailer from "nodemailer";

dotenv.config();

const {
  PORT = 3000,
  MONDAY_TOKEN,
  MONDAY_BOARD_ID,
  SLACK_BOT_TOKEN,
  SLACK_CHANNEL_ID,
  GEMINI_API_KEY,
  DEBUG: DEBUG_RAW = "false",
  ALWAYS_ALERT: ALWAYS_ALERT_RAW = "false",
  RACHEL_USER_ID = "D08MAQ61878",
  HARITHA_USER_ID = "D08HQ5GQCAW",
  HUBSPOT_API_KEY,
  HUBSPOT_BCC_ADDRESS,
  SMTP_HOST,
  SMTP_PORT = 465,
  SMTP_SECURE = "true",
  SMTP_USER,
  SMTP_PASS,
  EMAIL_FROM,
  EMAIL_FROM_NAME = "Geomiq Support",
} = process.env;

console.log("SMTP config:", {
  host: SMTP_HOST,
  port: SMTP_PORT,
  secure: SMTP_SECURE,
  user: SMTP_USER,
  from: EMAIL_FROM,
});

const DEBUG = (DEBUG_RAW || "false").toLowerCase() === "true";
const ALWAYS_ALERT = (ALWAYS_ALERT_RAW || "false").toLowerCase() === "true";

if (!MONDAY_TOKEN || !MONDAY_BOARD_ID || !SLACK_BOT_TOKEN || !SLACK_CHANNEL_ID) {
  console.error("Missing required environment variables");
  process.exit(1);
}

const app = express();
app.use(express.json({ type: "*/*" }));

const monday = mondaySdk();
monday.setToken(MONDAY_TOKEN);

const slack = new WebClient(SLACK_BOT_TOKEN);
const genAI = GEMINI_API_KEY ? new GoogleGenerativeAI(GEMINI_API_KEY) : null;

const ambiguousStatusHistory = new Map();

const AMBIGUOUS_STATUSES = {
  "clearance event": { hours: 18 },
  "customs clearance": { hours: 18 },
  "processing": { hours: 24 },
  "on hold": { hours: 6 },
  "exception": { hours: 12 },
  "clearance processing": { hours: 18 },
};

const LOGISTICS_COORDINATORS = {
  RACHEL_CHINA: `<@${RACHEL_USER_ID}>`,
  HARITHA_INDIA: `<@${HARITHA_USER_ID}>`,
};

const CUSTOMER_NOTIFICATION_PATTERNS = {
  premisesClosed: /(consignee premises closed|premises closed|office closed|business closed)/i,
  consigneeUnavailable: /(consignee (unavailable|not available)|recipient unavailable|no one (available|home)|customer not available|no answer|no response( at consignee address)?|not answering)/i,
  refusedDelivery: /(refused delivery|delivery refused|consignee refused)/i,
  incorrectAddress: /(address incorrect|incorrect address|address insufficient|invalid address)/i,
};

function getCustomerAction(reason) {
  const actions = {
    premisesClosed: "Please arrange to be available during business hours or provide alternative delivery instructions.",
    consigneeUnavailable: "Please ensure someone is available to receive the package or arrange alternative delivery.",
    refusedDelivery: "Please contact the carrier if you wish to arrange redelivery.",
    incorrectAddress: "Please verify and provide the correct delivery address.",
    deliveryAttempt: "Please arrange to be available or provide alternative delivery instructions.",
  };
  return actions[reason] || "Please contact the carrier to resolve this delivery issue.";
}

function shouldNotifyCustomer(updateText) {
  const text = (updateText || "").toLowerCase();
  for (const [reason, pattern] of Object.entries(CUSTOMER_NOTIFICATION_PATTERNS)) {
    if (pattern.test(text)) {
      return { shouldNotify: true, reason, actionRequired: getCustomerAction(reason) };
    }
  }
  if (text.includes("delivery attempted")) {
    return {
      shouldNotify: true,
      reason: "deliveryAttempt",
      actionRequired: getCustomerAction("deliveryAttempt"),
    };
  }
  return { shouldNotify: false };
}

function detectCarrier(updateText) {
  const text = (updateText || "").toLowerCase();
  if (text.includes("ups")) return "UPS";
  if (text.includes("dhl")) return "DHL";
  if (text.includes("fedex")) return "FedEx";
  return "unknown";
}

function getLogisticsCoordinator(route, carrier) {
  if (route && route.toUpperCase().includes("INDIA")) return LOGISTICS_COORDINATORS.HARITHA_INDIA;
  if (route && route.toUpperCase().includes("CHINA")) return LOGISTICS_COORDINATORS.RACHEL_CHINA;
  if (carrier === "UPS") return LOGISTICS_COORDINATORS.HARITHA_INDIA;
  return LOGISTICS_COORDINATORS.RACHEL_CHINA;
}

function extractTrackingNumber(text) {
  if (!text) return null;
  
  // Check if it's a URL
  if (text.includes('http')) {
    // DHL tracking URL patterns
    const dhlMatch = text.match(/tracking-id=([A-Z0-9]+)/i);
    if (dhlMatch) return dhlMatch[1];
    
    // UPS tracking URL patterns
    const upsMatch = text.match(/tracknum=([A-Z0-9]+)/i) || 
                     text.match(/TrackingNumber=([A-Z0-9]+)/i);
    if (upsMatch) return upsMatch[1];
    
    // FedEx tracking URL patterns
    const fedexMatch = text.match(/tracknumber=([A-Z0-9]+)/i) || 
                       text.match(/trknbr=([A-Z0-9]+)/i);
    if (fedexMatch) return fedexMatch[1];
    
    // Generic tracking number extraction from URL parameters
    const genericMatch = text.match(/(?:tracking|track|trk)(?:_?(?:id|num|number))?\=([A-Z0-9]+)/i);
    if (genericMatch) return genericMatch[1];
  }
  
  // If it's already just a tracking number (alphanumeric, 8-20 chars)
  if (/^[A-Z0-9]{8,20}$/i.test(text.trim())) {
    return text.trim().toUpperCase();
  }
  
  return null;
}

async function updateTrackingColumn(itemId, trackingNumber) {
  try {
    const mutation = `
      mutation($itemId: ID!, $columnId: String!, $value: String!) {
        change_simple_column_value(
          item_id: $itemId,
          board_id: ${MONDAY_BOARD_ID},
          column_id: $columnId,
          value: $value
        ) {
          id
        }
      }
    `;
    
    await monday.api(mutation, {
      variables: {
        itemId: String(itemId),
        columnId: "text6__1", // This is your customer tracking column ID
        value: trackingNumber
      }
    });
    
    console.log(`✅ Updated tracking for item ${itemId}: ${trackingNumber}`);
  } catch (error) {
    console.error(`❌ Failed to update tracking for item ${itemId}:`, error);
  }
}

async function getItemDetails(itemId) {
  const query = `query($itemIds: [ID!]) {
    items(ids: $itemIds) {
      id
      name
      column_values { id text }
    }
  }`;
  const response = await monday.api(query, { variables: { itemIds: [String(itemId)] } });
  const item = response?.data?.items?.[0];
  if (!item) return null;
  const columnMap = {};
  item.column_values.forEach((col) => {
    columnMap[col.id] = col.text || "";
  });
  return { id: item.id, name: item.name, columnMap, poNumber: item.name };
}

function getLocationFromColumns(columnMap) {
  return columnMap["text5__1"] || "Unknown Location";
}

function getNameAndCompanyFromMonday(itemDetails) {
  const name = (itemDetails.columnMap["text1"] || "").trim();
  const company = (itemDetails.columnMap["text3"] || "").trim();
  return { name, company };
}

// -------- Email (SMTP) --------
// ✅ Updated to include part number & customer tracking
async function sendCustomerNotificationSMTP(toEmail, toName, poNumber, deliveryIssue, location, updateText, itemDetails) {
  const transporter = nodemailer.createTransporter({
    host: SMTP_HOST,
    port: Number(SMTP_PORT),
    secure: (SMTP_SECURE || "false").toLowerCase() === "true",
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });

  const partNumber = itemDetails?.columnMap?.["text0"] || "N/A";
  const customerTracking = itemDetails?.columnMap?.["text6__1"] || "N/A";

  const mail = await transporter.sendMail({
    from: { name: EMAIL_FROM_NAME, address: EMAIL_FROM },
    to: { name: toName, address: toEmail },
    replyTo: "support@geomiq.com",
    bcc: HUBSPOT_BCC_ADDRESS || undefined,
    subject: `Delivery Update Required`,
    text: `Dear ${toName},

We attempted to deliver your parts, but the delivery was unsuccessful.

Carrier Update: ${updateText}
Part Number: ${partNumber}
Customer Tracking: ${customerTracking}
Current Location: ${location}
Action Required: ${deliveryIssue.actionRequired}

Please contact your carrier to arrange redelivery or provide alternative delivery instructions.

Best regards,
Geomiq Support`,
  });

  console.log("SMTP message sent:", mail.messageId);
}

function createSlackMessage(issue, itemDetails, updateText, location) {
  const poNumber = itemDetails.poNumber;
  const coordinator = getLogisticsCoordinator(issue.route, issue.carrier);
  const carrierEmoji = issue.carrier === "UPS" ? "📦" : issue.carrier === "DHL" ? "🚚" : issue.carrier === "FedEx" ? "✈️" : "📫";
  const mainMessage = `${poNumber} is ${issue.type} from ${location}. Please review.`;
  const detailsBlock = `${carrierEmoji} Item: ${poNumber}\n📝 Latest Update: ${updateText}\n📍 Current Location: ${location}\n🔍 Issue Type: ${issue.type}\n⚡ Severity: ${issue.severity}\n🚛 Carrier: ${issue.carrier}\n🤖 Analysis: ${issue.reason}`;
  return {
    text: `${coordinator} ${mainMessage}`,
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: `${coordinator} ${mainMessage}` } },
      { type: "section", text: { type: "mrkdwn", text: detailsBlock } },
      { type: "divider" },
    ],
  };
}

function checkAmbiguousStatus(itemId, updateText) {
  const now = Date.now();
  const lowerText = (updateText || "").toLowerCase();
  let ambiguousStatus = null;
  let timeoutHours = 0;
  for (const [status, config] of Object.entries(AMBIGUOUS_STATUSES)) {
    if (lowerText.includes(status)) {
      ambiguousStatus = status;
      timeoutHours = config.hours;
      break;
    }
  }
  if (!ambiguousStatus) {
    ambiguousStatusHistory.delete(itemId);
    return null;
  }
  const timeoutMs = timeoutHours * 60 * 60 * 1000;
  if (!ambiguousStatusHistory.has(itemId)) {
    ambiguousStatusHistory.set(itemId, { status: ambiguousStatus, updateText, firstSeenAt: now, timeoutHours });
    return null;
  }
  const history = ambiguousStatusHistory.get(itemId);
  if (!lowerText.includes(history.status)) {
    ambiguousStatusHistory.delete(itemId);
    return null;
  }
  const timeSinceFirstSeen = now - history.firstSeenAt;
  if (timeSinceFirstSeen >= timeoutMs) {
    ambiguousStatusHistory.delete(itemId);
    return {
      type: `experiencing delayed customs processing`,
      severity: "high",
      reason: `Status "${ambiguousStatus}" has persisted for ${Math.round(timeSinceFirstSeen / (1000 * 60 * 60))} hours`,
      isAmbiguousTimeout: true,
      hoursStuck: Math.round(timeSinceFirstSeen / (1000 * 60 * 60)),
      originalStatus: ambiguousStatus,
    };
  }
  return null;
}

async function analyzeIssue(updateText) {
  const text = (updateText || "").toLowerCase();
  const carrier = detectCarrier(updateText);
  if (text.includes("delivered")) return null;
  if (text.includes("held by customs") || text.includes("document required")) {
    return { type: "held in customs", severity: "high", reason: "Customs issue detected", carrier, route: carrier === "UPS" ? "India-UK" : "China-UK" };
  }
  if (text.includes("delivery attempted") || text.includes("recipient unavailable") || text.includes("premises closed")) {
    return { type: "experiencing delivery failure", severity: "high", reason: "Failed delivery attempt", carrier, route: carrier === "UPS" ? "India-UK" : "China-UK" };
  }
  return null;
}

app.post("/monday-webhook", async (req, res) => {
  try {
    if (req.body?.challenge) return res.json({ challenge: req.body.challenge });
    
    const event = req.body?.event;
    if (!event) return res.status(200).end();
    
    const updateText = event.value?.value;
    const itemId = event.pulseId;
    const columnId = event.columnId; // This tells us which column was updated
    
    if (!updateText) return res.status(200).end();
    
    console.log("Processing:", event.pulseName, "->", updateText);

    // Check if this is the customer tracking column being updated with a URL
    if (columnId === "text6__1") { // Customer tracking column
      const trackingNumber = extractTrackingNumber(updateText);
      if (trackingNumber && trackingNumber !== updateText.trim()) {
        console.log(`🔍 Extracted tracking number: ${trackingNumber} from URL`);
        await updateTrackingColumn(itemId, trackingNumber);
        return res.status(200).end();
      }
    }

    const itemDetails = await getItemDetails(itemId);
    if (!itemDetails) return res.status(200).end();

    const ambiguousIssue = checkAmbiguousStatus(itemId, updateText);
    if (ambiguousIssue) {
      const location = getLocationFromColumns(itemDetails.columnMap);
      const slackMessage = createSlackMessage(ambiguousIssue, itemDetails, updateText, location);
      try {
        await slack.chat.postMessage({ channel: SLACK_CHANNEL_ID, ...slackMessage });
      } catch (_) {}
      return res.status(200).end();
    }

    const issue = await analyzeIssue(updateText);
    if (issue) {
      const location = getLocationFromColumns(itemDetails.columnMap);
      const notify = shouldNotifyCustomer(updateText);
      if (notify.shouldNotify) {
        const { name, company } = getNameAndCompanyFromMonday(itemDetails);
        if (!company) {
          console.log("Company (text3) not set in Monday - cannot notify");
        } else {
          const contacts = []; // Use HubSpot API if needed
          if (contacts?.length) {
            const contact = contacts[0];
            await sendCustomerNotificationSMTP(
              contact.email,
              `${contact.firstName} ${contact.lastName}`.trim(),
              itemDetails.poNumber,
              notify,
              location,
              updateText,
              itemDetails
            );
            console.log("Customer notification sent to", contact.email);
          }
        }
      }
      const slackMessage = createSlackMessage(issue, itemDetails, updateText, location);
      await slack.chat.postMessage({ channel: SLACK_CHANNEL_ID, ...slackMessage });
      console.log("Alert sent successfully");
    }
    res.status(200).end();
  } catch (e) {
    console.error("Webhook error:", e);
    res.status(200).end();
  }
});

app.get("/test", (req, res) => {
  res.send("Logistics watcher is running! " + new Date().toISOString());
});

app.get("/smtp-verify", async (req, res) => {
  try {
    const transporter = nodemailer.createTransporter({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT),
      secure: (process.env.SMTP_SECURE || "false").toLowerCase() === "true",
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
    await transporter.verify();
    res.send("✅ SMTP connection OK (Gmail reachable)");
  } catch (e) {
    res.status(500).send("❌ SMTP verify failed: " + e.message);
  }
});

app.listen(PORT, () => {
  console.log(`Watcher listening on ${PORT}`);
});
