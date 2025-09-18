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

// Board configuration
const BOARDS = {
  MAIN: "162479257",
  CHINA: "9371034380", 
  INDIA: "9371038978"
};

// Board-specific column IDs for customer tracking
const TRACKING_COLUMN_IDS = {
  [BOARDS.MAIN]: "text_mkvcdqrw",
  [BOARDS.CHINA]: "text_mkvcdqrw", 
  [BOARDS.INDIA]: "text_mkvcce8m"
};

// Function to get board name for logging
function getBoardName(boardId) {
  const boardIdStr = String(boardId);
  switch (boardIdStr) {
    case BOARDS.MAIN: return "Main Board";
    case BOARDS.CHINA: return "China Board";
    case BOARDS.INDIA: return "India Board";
    default: return `Board ${boardId}`;
  }
}

// Function to get the correct tracking column ID for a board
function getTrackingColumnId(boardId) {
  return TRACKING_COLUMN_IDS[String(boardId)] || "text_mkvcdqrw"; // fallback to main/china column ID
}

console.log("Environment variables loaded:");
console.log("- MONDAY_TOKEN:", MONDAY_TOKEN ? `Present (${MONDAY_TOKEN.substring(0, 20)}...)` : "❌ Missing");
console.log("- MONDAY_BOARD_ID:", MONDAY_BOARD_ID);
console.log("- SLACK_BOT_TOKEN:", SLACK_BOT_TOKEN ? "Present" : "❌ Missing");
console.log("- SLACK_CHANNEL_ID:", SLACK_CHANNEL_ID);

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

// Test Monday.com connection on startup
async function testMondayConnection() {
  try {
    const query = `query { me { name email } }`;
    const response = await monday.api(query);
    
    if (response.errors) {
      console.error("❌ Monday.com authentication failed:", response.errors);
    } else {
      console.log("✅ Monday.com authenticated as:", response.data.me.name);
    }
  } catch (error) {
    console.error("❌ Monday.com connection error:", error.message);
  }
}

// Test connection after a delay to ensure everything is initialized
setTimeout(testMondayConnection, 2000);

const slack = new WebClient(SLACK_BOT_TOKEN);
const genAI = GEMINI_API_KEY ? new GoogleGenerativeAI(GEMINI_API_KEY) : null;

const ambiguousStatusHistory = new Map();

const AMBIGUOUS_STATUSES = {
  "clearance event": { hours: 18 },
  "customs clearance": { hours: 18 },
  "processing": { hours: 24 },
  "import scan": { hours: 24 },
  "arrival scan": { hours: 24 },
  "departure scan": { hours: 48 },
  "on hold": { hours: 6 },
  "exception": { hours: 12 },
  "clearance processing": { hours: 18 },
  "in transit": { hours: 72 }, // 3 days for in transit
  "shipment information received": { hours: 48 },
  "electronic information received": { hours: 24 },
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

function getLogisticsCoordinator(route, carrier, boardId) {
  const boardIdStr = String(boardId);
  
  // Board-specific coordinators
  if (boardIdStr === BOARDS.CHINA) return LOGISTICS_COORDINATORS.RACHEL_CHINA;
  if (boardIdStr === BOARDS.INDIA) return LOGISTICS_COORDINATORS.HARITHA_INDIA;
  
  // Fallback to route/carrier logic
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

async function updateTrackingColumn(itemId, trackingNumber, boardId = MONDAY_BOARD_ID) {
  try {
    const trackingColumnId = getTrackingColumnId(boardId);
    
    const mutation = `
      mutation($itemId: ID!, $boardId: ID!, $columnId: String!, $value: String!) {
        change_simple_column_value(
          item_id: $itemId,
          board_id: $boardId,
          column_id: $columnId,
          value: $value
        ) {
          id
        }
      }
    `;
    
    console.log(`🔄 Attempting to update item ${itemId} with tracking: ${trackingNumber}`);
    console.log(`📋 Board: ${getBoardName(boardId)} (${boardId})`);
    console.log(`📝 Column ID: ${trackingColumnId}`);
    
    const response = await monday.api(mutation, {
      variables: {
        itemId: String(itemId),
        boardId: String(boardId),
        columnId: trackingColumnId,
        value: trackingNumber
      }
    });
    
    console.log(`📊 Monday.com API response:`, JSON.stringify(response, null, 2));
    
    if (response.errors) {
      console.error(`❌ Monday.com API errors:`, response.errors);
    } else {
      console.log(`✅ Updated tracking for item ${itemId} on ${getBoardName(boardId)}: ${trackingNumber}`);
    }
    
  } catch (error) {
    console.error(`❌ Failed to update tracking for item ${itemId}:`, error);
    console.error(`❌ Error details:`, error.message);
    console.error(`❌ Stack trace:`, error.stack);
  }
}

async function findItemByName(itemName) {
  try {
    const query = `query($boardId: ID!) {
      boards(ids: [$boardId]) {
        items_page {
          items {
            id
            name
            column_values { id text }
          }
        }
      }
    }`;
    
    const response = await monday.api(query, { variables: { boardId: String(MONDAY_BOARD_ID) } });
    
    if (response.errors) {
      console.error("Error finding items:", response.errors);
      return null;
    }
    
    const items = response.data.boards[0]?.items_page?.items || [];
    const foundItem = items.find(item => item.name === itemName);
    
    if (foundItem) {
      console.log(`🔍 Found item by name: ${foundItem.name} -> ID: ${foundItem.id}`);
      return foundItem;
    }
    
    console.log(`❌ Item "${itemName}" not found in board`);
    return null;
    
  } catch (error) {
    console.error("Error searching for item by name:", error);
    return null;
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
  // Use the correct tracking column ID based on the board
  const boardId = itemDetails?.boardId || MONDAY_BOARD_ID;
  const trackingColumnId = getTrackingColumnId(boardId);
  const customerTracking = itemDetails?.columnMap?.[trackingColumnId] || "N/A";

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

function createSlackMessage(issue, itemDetails, updateText, location, boardId) {
  const poNumber = itemDetails.poNumber;
  const coordinator = getLogisticsCoordinator(issue.route, issue.carrier, boardId);
  const carrierEmoji = issue.carrier === "UPS" ? "📦" : issue.carrier === "DHL" ? "🚚" : issue.carrier === "FedEx" ? "✈️" : "📫";
  const aiEmoji = issue.aiAnalysis ? "🤖" : "🔍";
  const boardName = getBoardName(boardId);
  const mainMessage = `${poNumber} is ${issue.type} from ${location}. Please review.`;
  const detailsBlock = `${carrierEmoji} Item: ${poNumber}\n📋 Board: ${boardName}\n📝 Latest Update: ${updateText}\n📍 Current Location: ${location}\n🔍 Issue Type: ${issue.type}\n⚡ Severity: ${issue.severity}\n🚛 Carrier: ${issue.carrier}\n${aiEmoji} Analysis: ${issue.reason}`;
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

async function analyzeIssueWithGemini(updateText, carrier, location) {
  if (!genAI) {
    console.log("⚠️ Gemini API not configured, using basic analysis");
    return await analyzeIssueBasic(updateText);
  }

  try {
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
    
    const prompt = `Analyze this shipping/logistics update and determine if it indicates a problem that requires human attention.

UPDATE: "${updateText}"
CARRIER: ${carrier}
LOCATION: ${location || "Unknown"}

Respond with JSON only:
{
  "hasIssue": boolean,
  "issueType": "customs_hold" | "delivery_failure" | "exception" | "delay" | "damage" | "lost" | "address_issue" | "none",
  "severity": "low" | "medium" | "high",
  "reason": "brief explanation",
  "requiresAction": boolean
}

Consider these as issues:
- Customs holds, clearance problems, document requirements
- Failed delivery attempts, recipient issues, address problems  
- Exceptions, holds, delays, damage, lost packages
- Anything requiring customer or logistics team action

Normal updates (delivered, in transit, departed facility) are NOT issues.`;

    const result = await model.generateContent(prompt);
    const response = await result.response;
    const text = response.text();
    
    // Try to parse JSON response
    try {
      const analysis = JSON.parse(text.replace(/```json\n?|```\n?/g, ''));
      
      if (analysis.hasIssue && analysis.requiresAction) {
        return {
          type: analysis.issueType.replace('_', ' '),
          severity: analysis.severity,
          reason: `AI Analysis: ${analysis.reason}`,
          carrier,
          route: carrier === "UPS" ? "India-UK" : "China-UK",
          aiAnalysis: true
        };
      }
      
      console.log(`🤖 Gemini: No issue detected - ${analysis.reason}`);
      return null;
      
    } catch (parseError) {
      console.error("Failed to parse Gemini response:", text);
      return await analyzeIssueBasic(updateText);
    }
    
  } catch (error) {
    console.error("Gemini API error:", error);
    return await analyzeIssueBasic(updateText);
  }
}

async function analyzeIssueBasic(updateText) {
  const text = (updateText || "").toLowerCase();
  const carrier = detectCarrier(updateText);
  
  // Skip normal delivery completion
  if (text.includes("delivered") && !text.includes("delivery attempted")) return null;
  
  // Immediate high-priority issues
  if (text.includes("held by customs") || text.includes("document required") || 
      text.includes("clearance required") || text.includes("customs examination")) {
    return { 
      type: "held in customs", 
      severity: "high", 
      reason: "Customs issue detected", 
      carrier, 
      route: carrier === "UPS" ? "India-UK" : "China-UK" 
    };
  }
  
  // Delivery failures
  if (text.includes("delivery attempted") || text.includes("recipient unavailable") || 
      text.includes("premises closed") || text.includes("address insufficient") ||
      text.includes("delivery exception") || text.includes("unable to deliver")) {
    return { 
      type: "experiencing delivery failure", 
      severity: "high", 
      reason: "Failed delivery attempt detected", 
      carrier, 
      route: carrier === "UPS" ? "India-UK" : "China-UK" 
    };
  }
  
  // Exceptions and holds
  if (text.includes("exception") || text.includes("on hold") || 
      text.includes("delayed") || text.includes("missent") ||
      text.includes("damaged") || text.includes("lost")) {
    return { 
      type: "experiencing shipping exception", 
      severity: "medium", 
      reason: "Shipping exception detected", 
      carrier, 
      route: carrier === "UPS" ? "India-UK" : "China-UK" 
    };
  }
  
  // Weather or facility issues
  if (text.includes("weather") || text.includes("natural disaster") || 
      text.includes("facility issue") || text.includes("mechanical failure")) {
    return { 
      type: "delayed due to external factors", 
      severity: "medium", 
      reason: "External delay factors detected", 
      carrier, 
      route: carrier === "UPS" ? "India-UK" : "China-UK" 
    };
  }
  
  return null;
}

// Update the main analyzeIssue function
async function analyzeIssue(updateText, location = null) {
  return await analyzeIssueWithGemini(updateText, detectCarrier(updateText), location);
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
    console.log("Column ID:", columnId);
    console.log("Pulse ID:", itemId);
    console.log("Board ID from webhook:", event.boardId, `(${getBoardName(event.boardId)})`);
    
    // Validate that this is one of our expected boards
    const boardId = String(event.boardId);
    const validBoards = Object.values(BOARDS);
    if (!validBoards.includes(boardId)) {
      console.log(`⚠️  Webhook from unexpected board ${boardId}, skipping`);
      return res.status(200).end();
    }

    // Always try to extract tracking numbers from URLs, regardless of column
    const trackingNumber = extractTrackingNumber(updateText);
    if (trackingNumber && trackingNumber !== updateText.trim()) {
      console.log(`🔍 Extracted tracking number: ${trackingNumber} from URL`);
      console.log(`📍 Column ID: ${columnId}`);
      console.log(`📍 Pulse ID: ${itemId}`);
      console.log(`📍 Board: ${getBoardName(event.boardId)} (${event.boardId})`);
      
      // Try to update the tracking column with the correct board ID
      await updateTrackingColumn(itemId, trackingNumber, event.boardId);
      return res.status(200).end();
    }

    const itemDetails = await getItemDetails(itemId);
    if (!itemDetails) return res.status(200).end();

    const ambiguousIssue = checkAmbiguousStatus(itemId, updateText);
    if (ambiguousIssue) {
      const location = getLocationFromColumns(itemDetails.columnMap);
      const slackMessage = createSlackMessage(ambiguousIssue, itemDetails, updateText, location, event.boardId);
      try {
        await slack.chat.postMessage({ channel: SLACK_CHANNEL_ID, ...slackMessage });
      } catch (_) {}
      return res.status(200).end();
    }

    const issue = await analyzeIssue(updateText, getLocationFromColumns(itemDetails.columnMap));
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
      const slackMessage = createSlackMessage(issue, itemDetails, updateText, location, event.boardId);
      await slack.chat.postMessage({ channel: SLACK_CHANNEL_ID, ...slackMessage });
      console.log("Alert sent successfully" + (issue.aiAnalysis ? " (AI-detected)" : " (rule-based)"));
    }
    res.status(200).end();
  } catch (e) {
    console.error("Webhook error:", e);
    res.status(200).end();
  }
});

app.get("/test-monday-auth", async (req, res) => {
  try {
    // Test Monday.com authentication with a simple query
    const query = `query { me { name email } }`;
    const response = await monday.api(query);
    
    if (response.errors) {
      res.status(401).json({
        success: false,
        error: "Monday.com authentication failed",
        details: response.errors
      });
    } else {
      res.json({
        success: true,
        message: "Monday.com authentication successful",
        user: response.data.me
      });
    }
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.get("/test-gemini/:text", async (req, res) => {
  try {
    const text = decodeURIComponent(req.params.text);
    console.log(`🧪 Testing Gemini analysis on: "${text}"`);
    
    const issue = await analyzeIssueWithGemini(text, "DHL", "LONDON-UK");
    
    res.json({
      success: true,
      input: text,
      analysis: issue,
      geminiAvailable: !!genAI
    });
    
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.get("/test-update/:itemId/:trackingNumber", async (req, res) => {
  try {
    const { itemId, trackingNumber } = req.params;
    
    console.log(`🧪 Test update: Item ${itemId}, Tracking: ${trackingNumber}`);
    
    await updateTrackingColumn(itemId, trackingNumber);
    
    res.json({
      success: true,
      message: `Attempted to update item ${itemId} with tracking ${trackingNumber}`,
      itemId,
      trackingNumber
    });
    
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.get("/debug-columns/:itemId", async (req, res) => {
  try {
    const itemId = req.params.itemId;
    const itemDetails = await getItemDetails(itemId);
    
    if (!itemDetails) {
      return res.status(404).send("Item not found");
    }
    
    // Show all columns and their IDs
    const columnInfo = itemDetails.columnMap;
    
    res.json({
      itemId,
      itemName: itemDetails.name,
      columns: columnInfo,
      note: "Look for the 'Customer tracking' column to find the correct column ID"
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
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
