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
  SLACK_BOT_TOKEN,
  SLACK_CHANNEL_ID,
  GEMINI_API_KEY,
  DEBUG: DEBUG_RAW = "false",
  ALWAYS_ALERT: ALWAYS_ALERT_RAW = "false",
  RACHEL_USER_ID = "D08MAQ61878",
  HARITHA_USER_ID = "D08HQ5GQCAW",
  HUBSPOT_API_KEY,
  GMAIL_USER,
  GMAIL_APP_PASSWORD,
  EMAIL_FROM = "logistics@geomiq.com"
} = process.env;

const DEBUG = (DEBUG_RAW || "false").toLowerCase() === "true";
const ALWAYS_ALERT = (ALWAYS_ALERT_RAW || "false").toLowerCase() === "true";

console.log("Environment check:");
console.log("DEBUG:", DEBUG);
console.log("GMAIL_USER configured:", !!GMAIL_USER);

if (!MONDAY_TOKEN || !SLACK_BOT_TOKEN || !SLACK_CHANNEL_ID) {
  console.error("Missing required environment variables");
  process.exit(1);
}

const app = express();
app.use(express.json({ type: "*/*" }));

const monday = mondaySdk();
monday.setToken(MONDAY_TOKEN);

const slack = new WebClient(SLACK_BOT_TOKEN);
const genAI = GEMINI_API_KEY ? new GoogleGenerativeAI(GEMINI_API_KEY) : null;

// Configure Gmail SMTP
let transporter = null;
if (GMAIL_USER && GMAIL_APP_PASSWORD) {
  transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: GMAIL_USER,
      pass: GMAIL_APP_PASSWORD
    }
  });
  
  console.log("Gmail SMTP configured successfully");
} else {
  console.log("Gmail credentials not configured - email notifications disabled");
}

// Multi-board configuration
const BOARD_CONFIGS = {
  "9371038978": { // India Board
    name: "India",
    region: "INDIA",
    coordinator: `<@${HARITHA_USER_ID}>`,
    columns: {
      region: "status77",
      customerName: "text1",
      companyName: "text3", 
      customerTracking: "text_mkvcce8m",
      latestUpdate: "text_mkvc93tw",
      latestLocation: "text_mkvcg0xs",
      latestUpdateDate: "date_mkvey807",
      transitStatus: "color_mkvew24q",
      partNumber: "text0"
    }
  },
  "9371042358": { // Portugal Board
    name: "Portugal", 
    region: "PORTUGAL",
    coordinator: null, // No tagging for Portugal
    columns: {
      region: "status77",
      companyName: "text3",
      customerTracking: "text_mkvc9fc5", 
      customerName: "text1",
      latestUpdateDate: "date_mkvc9ja0",
      latestUpdate: "text_mkvccynd",
      latestLocation: "text_mkvcna6n",
      transitStatus: "color_mkvedscf",
      partNumber: "text0"
    }
  },
  "9371034380": { // China Board
    name: "China",
    region: "CHINA", 
    coordinator: `<@${RACHEL_USER_ID}>`,
    columns: {
      region: "status77",
      companyName: "text3",
      customerName: "text1",
      customerTracking: "text_mkvcdqrw",
      latestUpdate: "text_mkvcmtre", 
      latestLocation: "text_mkvc8tw8",
      latestUpdateDate: "date_mkvcbzsv",
      transitStatus: "color_mkvev72x",
      partNumber: "text0"
    }
  },
  "162479257": { // Main Board (Mixed Regions)
    name: "Main",
    region: "MIXED", // Will check region column for each item
    coordinator: null, // Will be determined by region column
    columns: {
      region: "status77",
      customerName: "text1",
      companyName: "text3", 
      customerTracking: "text_mkvcce8m", 
      latestUpdate: "text_1__1", // Correct column for main board
      latestLocation: "text_mkvcg0xs",
      latestUpdateDate: "date_mkvey807",
      transitStatus: "color_mkvew24q",
      partNumber: "text0"
    }
  }
};

const recentAlerts = new Map();
const updateHistory = new Map();
const ambiguousStatusHistory = new Map();

const AMBIGUOUS_STATUSES = {
  "clearance event": { hours: 18 },
  "customs clearance": { hours: 18 },
  "processing": { hours: 24 },
  "exception": { hours: 12 },
  "clearance processing": { hours: 18 }
};

const LOGISTICS_COORDINATORS = {
  RACHEL_CHINA: `<@${RACHEL_USER_ID}>`,
  HARITHA_INDIA: `<@${HARITHA_USER_ID}>`
};

const CUSTOMER_NOTIFICATION_PATTERNS = {
  premisesClosed: /(consignee premises closed|premises closed|office closed|business closed)/i,
  consigneeUnavailable: /(consignee unavailable|recipient unavailable|no one available|customer not available)/i,
  refusedDelivery: /(refused delivery|delivery refused|consignee refused)/i,
  incorrectAddress: /(address incorrect|incorrect address|address insufficient|invalid address)/i
};

function getBoardConfig(boardId) {
  const config = BOARD_CONFIGS[String(boardId)];
  if (!config) {
    console.error(`No configuration found for board ID: ${boardId}`);
    return null;
  }
  return config;
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
  
  console.log(`Checking ambiguous status "${ambiguousStatus}" for item ${itemId} (${timeoutHours}h timeout)`);
  
  if (!ambiguousStatusHistory.has(itemId)) {
    ambiguousStatusHistory.set(itemId, {
      status: ambiguousStatus,
      updateText: updateText,
      firstSeenAt: now,
      timeoutHours: timeoutHours
    });
    console.log(`Started tracking ambiguous status "${ambiguousStatus}" - will alert in ${timeoutHours} hours`);
    return null;
  }
  
  const history = ambiguousStatusHistory.get(itemId);
  
  if (!lowerText.includes(history.status)) {
    console.log(`Ambiguous status "${history.status}" resolved - clearing tracking`);
    ambiguousStatusHistory.delete(itemId);
    return null;
  }
  
  const timeSinceFirstSeen = now - history.firstSeenAt;
  
  if (timeSinceFirstSeen >= timeoutMs) {
    console.log(`Ambiguous status "${ambiguousStatus}" persisted for ${Math.round(timeSinceFirstSeen / (1000 * 60 * 60))} hours`);
    
    ambiguousStatusHistory.delete(itemId);
    
    return {
      type: "experiencing delayed customs processing",
      severity: "high",
      reason: `Status "${ambiguousStatus}" persisted for ${Math.round(timeSinceFirstSeen / (1000 * 60 * 60))} hours`,
      isAmbiguousTimeout: true,
      hoursStuck: Math.round(timeSinceFirstSeen / (1000 * 60 * 60))
    };
  }
  
  return null;
}

function checkStuckStatus(itemDetails, boardConfig) {
  const transitStatusColumn = boardConfig.columns.transitStatus;
  const transitStatus = itemDetails?.columnMap?.[transitStatusColumn];
  
  if (transitStatus && transitStatus.toLowerCase().includes("stuck")) {
    console.log(`Stuck status detected: ${transitStatus}`);
    return {
      type: "stuck in transit",
      severity: "high", 
      reason: "Transit status marked as stuck",
      isStuckStatus: true
    };
  }
  
  return null;
}

function getLogisticsCoordinator(boardConfig, itemDetails) {
  // For mixed region boards (like Main board), check the region column
  if (boardConfig.region === "MIXED") {
    const region = itemDetails?.columnMap?.[boardConfig.columns.region];
    
    if (region) {
      const upperRegion = region.toUpperCase();
      console.log(`Mixed board - Region found: ${region}`);
      
      // Assign coordinator based on region
      if (upperRegion.includes("INDIA") || upperRegion.includes("IN")) {
        console.log("Assigning Haritha (India coordinator)");
        return `<@${HARITHA_USER_ID}>`;
      } else if (upperRegion.includes("CHINA") || upperRegion.includes("CN")) {
        console.log("Assigning Rachel (China coordinator)");
        return `<@${RACHEL_USER_ID}>`;
      } else if (upperRegion.includes("PORTUGAL") || upperRegion.includes("PT")) {
        console.log("Portugal region - no coordinator tagging");
        return null;
      }
    }
    
    // Fallback for mixed board if region unclear
    console.log("Mixed board - region unclear, no coordinator assigned");
    return null;
  }
  
  // For single-region boards, use the predefined coordinator
  return boardConfig.coordinator;
}

function detectCarrier(updateText) {
  if (!updateText) return "unknown";
  
  const text = updateText.toLowerCase();
  
  if (text.includes("ups")) return "UPS";
  if (text.includes("dhl")) return "DHL";
  if (text.includes("fedex")) return "FedEx";
  
  return "unknown";
}

function shouldNotifyCustomer(updateText) {
  const text = (updateText || "").toLowerCase();
  
  for (const [reason, pattern] of Object.entries(CUSTOMER_NOTIFICATION_PATTERNS)) {
    if (pattern.test(text)) {
      console.log(`Customer notification required: ${reason}`);
      return {
        shouldNotify: true,
        reason: reason,
        actionRequired: getCustomerAction(reason)
      };
    }
  }
  
  return { shouldNotify: false };
}

function getCustomerAction(reason) {
  const actions = {
    premisesClosed: "Please arrange to be available during business hours or provide alternative delivery instructions.",
    consigneeUnavailable: "Please ensure someone is available to receive the package or arrange alternative delivery.",
    refusedDelivery: "Please contact the carrier if you wish to arrange redelivery.",
    incorrectAddress: "Please verify and provide the correct delivery address."
  };
  
  return actions[reason] || "Please contact the carrier to resolve this delivery issue.";
}

async function getCustomerFromMonday(itemDetails, boardConfig) {
  try {
    console.log("Looking for customer information in Monday columns...");
    
    // Check customer name column
    const customerNameColumn = boardConfig.columns.customerName;
    if (itemDetails.columnMap[customerNameColumn]) {
      console.log(`Found customer in ${customerNameColumn}: ${itemDetails.columnMap[customerNameColumn]}`);
      return {
        name: itemDetails.columnMap[customerNameColumn],
        columnId: customerNameColumn
      };
    }
    
    console.log("No customer information found in Monday columns");
    return null;
    
  } catch (error) {
    console.error("Error getting customer from Monday:", error.message);
    return null;
  }
}

async function searchCustomerInHubSpot(customerName) {
  if (!HUBSPOT_API_KEY) {
    console.log("HubSpot API key not configured");
    return null;
  }
  
  try {
    console.log(`Searching for customer in HubSpot: ${customerName}`);
    
    // Split name for better searching
    const nameParts = customerName.trim().split(/\s+/);
    const firstName = nameParts[0];
    const lastName = nameParts.length > 1 ? nameParts[nameParts.length - 1] : "";
    
    console.log(`Searching with firstName: "${firstName}", lastName: "${lastName}"`);
    
    const searchUrl = "https://api.hubapi.com/crm/v3/objects/contacts/search";
    
    // Try multiple search strategies
    const searchStrategies = [
      // Strategy 1: Search by full name in company field
      {
        filterGroups: [{
          filters: [{
            propertyName: "company",
            operator: "CONTAINS_TOKEN",
            value: customerName
          }]
        }],
        strategy: "company name"
      },
      // Strategy 2: Search by first name
      {
        filterGroups: [{
          filters: [{
            propertyName: "firstname",
            operator: "CONTAINS_TOKEN",
            value: firstName
          }]
        }],
        strategy: "first name"
      },
      // Strategy 3: Search by last name if available
      lastName ? {
        filterGroups: [{
          filters: [{
            propertyName: "lastname",
            operator: "CONTAINS_TOKEN",
            value: lastName
          }]
        }],
        strategy: "last name"
      } : null,
      // Strategy 4: Search by email containing name
      {
        filterGroups: [{
          filters: [{
            propertyName: "email",
            operator: "CONTAINS_TOKEN",
            value: firstName.toLowerCase()
          }]
        }],
        strategy: "email"
      }
    ].filter(Boolean);
    
    for (const searchPayload of searchStrategies) {
      console.log(`Trying search strategy: ${searchPayload.strategy}`);
      
      const response = await fetch(searchUrl, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${HUBSPOT_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          ...searchPayload,
          properties: ["email", "firstname", "lastname", "company"],
          limit: 5
        })
      });
      
      if (!response.ok) {
        console.error(`HubSpot API error: ${response.status} - ${await response.text()}`);
        continue;
      }
      
      const data = await response.json();
      
      if (data.results && data.results.length > 0) {
        console.log(`Found ${data.results.length} contacts using ${searchPayload.strategy} strategy`);
        
        // Log all found contacts for debugging
        data.results.forEach((contact, index) => {
          console.log(`Contact ${index + 1}:`, {
            email: contact.properties.email,
            firstName: contact.properties.firstname,
            lastName: contact.properties.lastname,
            company: contact.properties.company
          });
        });
        
        const contact = data.results[0];
        console.log(`Using first contact: ${contact.properties.email}`);
        
        return {
          email: contact.properties.email,
          firstName: contact.properties.firstname,
          lastName: contact.properties.lastname,
          company: contact.properties.company
        };
      } else {
        console.log(`No results for ${searchPayload.strategy} strategy`);
      }
    }
    
    console.log("Customer not found in HubSpot with any search strategy");
    return null;
    
  } catch (error) {
    console.error("HubSpot search failed:", error.message);
    return null;
  }
}

async function sendEmailToCustomer(customer, poNumber, deliveryIssue, location, updateText) {
  if (!transporter) {
    console.log("Email transporter not configured - cannot send email");
    return false;
  }
  
  try {
    console.log(`Sending delivery notification email to ${customer.email}`);
    
    const emailSubject = `Delivery Update Required - Order ${poNumber}`;
    const emailBody = `
Dear ${customer.firstName || "Valued Customer"},

We wanted to inform you about a delivery attempt for your order ${poNumber}.

Delivery Status: ${updateText}
Current Location: ${location}
Action Required: ${deliveryIssue.actionRequired}

Please contact your carrier to arrange redelivery or provide alternative delivery instructions.

If you have any questions, please don't hesitate to reach out to our customer service team.

Best regards,
Logistics Team
    `.trim();
    
    const mailOptions = {
      from: EMAIL_FROM,
      to: customer.email,
      subject: emailSubject,
      text: emailBody
    };
    
    const info = await transporter.sendMail(mailOptions);
    console.log(`Email sent successfully: ${info.messageId}`);
    
    return true;
    
  } catch (error) {
    console.error("Failed to send email:", error.message);
    return false;
  }
}

function getLocationFromColumns(itemDetails, boardConfig) {
  console.log("Searching for location in Monday columns...");
  
  const locationColumn = boardConfig.columns.latestLocation;
  const location = itemDetails?.columnMap?.[locationColumn];
  
  if (DEBUG) {
    console.log("Available Monday columns:");
    for (const [colId, colText] of Object.entries(itemDetails.columnMap)) {
      if (colText) console.log(`   ${colId}: "${colText}"`);
    }
  }
  
  if (location) {
    console.log(`Found location: ${location}`);
    return location;
  }
  
  return "Unknown Location";
}

function getLatestUpdateFromColumns(itemDetails, boardConfig) {
  const colId = boardConfig.columns.latestUpdate;
  return (itemDetails?.columnMap?.[colId] || "").trim();
}

async function getItemDetails(itemId, boardId) {
  try {
    console.log("Fetching item details for:", itemId, "from board:", boardId);
    
    const query = `
      query($itemIds: [ID!]) {
        items(ids: $itemIds) {
          id
          name
          board { id }
          column_values { 
            id 
            type
            text 
            value 
          }
        }
      }`;
      
    const response = await monday.api(query, {
      variables: { itemIds: [String(itemId)] }
    });
    
    const item = response?.data?.items?.[0];
    if (!item) {
      console.log("Item not found");
      return null;
    }
    
    const columnMap = {};
    item.column_values.forEach(col => {
      columnMap[col.id] = col.text || "";
    });
    
    return {
      id: item.id,
      name: item.name,
      boardId: item.board.id,
      columnMap,
      poNumber: item.name
    };
    
  } catch (error) {
    console.error("Monday API Error:", error.message);
    return null;
  }
}

/* =========================
   ADDED HELPERS (NEW)
   ========================= */

// --- Tracking number helpers ---
function extractTrackingNumber(raw) {
  if (!raw) return "";
  const s = String(raw).trim();

  // If already a plain token (no scheme/whitespace), keep it
  if (!/^https?:\/\//i.test(s) && !/\s/.test(s)) return s;

  // DHL: tracking-id=..., AWB=..., piececode=..., trackingNumber=...
  const dhl = /(?:tracking-id|awb|piececode|trackingNumber)[=\-:]?([A-Za-z0-9]{8,35})/i;

  // FedEx: tracknumbers=..., trackingNumber=...
  const fedex = /(?:tracknumbers?|trackingNumber)[=\-:]?([A-Za-z0-9]{8,35})/i;

  // UPS: tracknum=..., trackingNumber=...
  const ups = /(?:tracknum|trackingNumber)[=\-:]?([A-Za-z0-9]{8,35})/i;

  // Generic fallback: last token-ish segment
  const generic = /(?:\/|=)([A-Za-z0-9]{8,35})(?:[\/&?#]|$)/;

  for (const rx of [dhl, fedex, ups, generic]) {
    const m = s.match(rx);
    if (m && m[1]) return m[1];
  }
  return s; // fallback
}

async function normalizeCustomerTracking(itemDetails, boardConfig) {
  try {
    const colId = boardConfig.columns.customerTracking;
    if (!colId) return;

    const current = itemDetails?.columnMap?.[colId] || "";
    if (!current) return;

    const cleaned = extractTrackingNumber(current);
    if (!cleaned || cleaned === current) return; // nothing to do

    const mutation = `
      mutation SetPlainTracking($itemId: ID!, $columnId: String!, $value: String!) {
        change_simple_column_value(item_id: $itemId, column_id: $columnId, value: $value) { id }
      }
    `;

    await monday.api(mutation, {
      variables: {
        itemId: String(itemDetails.id),
        columnId: colId,
        value: cleaned
      }
    });

    console.log(`Normalized tracking for item ${itemDetails.id}: "${current}" -> "${cleaned}"`);
  } catch (e) {
    console.error("Failed to normalize customer tracking:", e.message);
  }
}
/* =========================
   END ADDED HELPERS
   ========================= */

function createSlackMessage(issue, itemDetails, boardConfig, updateText, location) {
  const poNumber = itemDetails.poNumber;
  const coordinator = getLogisticsCoordinator(boardConfig, itemDetails);
  const carrierEmoji = issue.carrier === "UPS" ? "📦" : issue.carrier === "DHL" ? "🚚" : issue.carrier === "FedEx" ? "✈️" : "📫";
  
  let mainMessage;
  if (coordinator) {
    mainMessage = `${coordinator} ${poNumber} is ${issue.type} from ${location}. Please review.`;
  } else {
    // For Portugal or mixed board with no coordinator - make origin bold instead of tagging
    mainMessage = `**${boardConfig.name}**: ${poNumber} is ${issue.type} from ${location}. Please review.`;
  }
  
  const detailsBlock = `${carrierEmoji} Item: ${poNumber}\n📝 Latest Update: ${updateText || "(n/a)"}\n📍 Current Location: ${location}\n🔍 Issue Type: ${issue.type}\n⚡ Severity: ${issue.severity}\n🚛 Carrier: ${issue.carrier}\n🌍 Origin: ${boardConfig.name}\n🤖 Analysis: ${issue.reason}`;
  
  return {
    text: mainMessage,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: mainMessage
        }
      },
      {
        type: "section", 
        text: {
          type: "mrkdwn",
          text: detailsBlock
        }
      },
      {
        type: "divider"
      }
    ]
  };
}

async function analyzeIssue(updateText) {
  const text = (updateText || "").toLowerCase();
  const carrier = detectCarrier(updateText);
  
  if (text.includes("delivered")) return null;
  
  if (text.includes("held by customs") || text.includes("hold in customs") || text.includes("document required") || text.includes("on hold")) {
    return {
      type: "held in customs",
      severity: "high",
      reason: "Customs issue detected",
      carrier: carrier
    };
  }
  
  if (text.includes("delivery attempted") || text.includes("recipient unavailable") || text.includes("premises closed")) {
    return {
      type: "experiencing delivery failure",
      severity: "high", 
      reason: "Failed delivery attempt",
      carrier: carrier
    };
  }
  
  return null;
}

app.post("/monday-webhook", async (req, res) => {
  const event = req.body?.event;
  const eventType = event?.type;
  const boardId = event?.boardId || event?.board?.id;
  const itemId = event?.pulseId || event?.itemId || event?.entityId;
  const rawUpdateText = event?.value?.value; // only present for create_update
  const changedColumnId = event?.columnId;   // present for change_column_value

  console.log("Webhook type:", eventType, "| board:", boardId, "| item:", itemId);
  if (rawUpdateText) {
    console.log("Update text (from event):", rawUpdateText);
  }
  if (changedColumnId) {
    console.log("Changed columnId:", changedColumnId);
  }

  try {
    if (req.body?.challenge) {
      return res.json({ challenge: req.body.challenge });
    }

    if (!event || !boardId || !itemId) {
      console.log("Missing event/boardId/itemId - skipping");
      return res.status(200).end();
    }

    // Get board configuration
    const boardConfig = getBoardConfig(boardId);
    if (!boardConfig) {
      console.log(`Unknown board ID: ${boardId} - skipping`);
      return res.status(200).end();
    }

    console.log(`Processing webhook from ${boardConfig.name} board`);

    // Always fetch fresh item details
    const itemDetails = await getItemDetails(itemId, boardId);
    if (!itemDetails) {
      return res.status(200).end();
    }

    // Always normalize the Customer tracking column (idempotent)
    await normalizeCustomerTracking(itemDetails, boardConfig);

    // Determine update text for analysis
    const updateText = rawUpdateText || getLatestUpdateFromColumns(itemDetails, boardConfig);

    // Check for "stuck" status first (immediate alert)
    const stuckIssue = checkStuckStatus(itemDetails, boardConfig);
    if (stuckIssue) {
      console.log("Stuck status detected - sending immediate alert");
      const location = getLocationFromColumns(itemDetails, boardConfig);
      stuckIssue.carrier = detectCarrier(updateText);
      
      const slackMessage = createSlackMessage(stuckIssue, itemDetails, boardConfig, updateText, location);
      
      try {
        await slack.chat.postMessage({
          channel: SLACK_CHANNEL_ID,
          ...slackMessage
        });
        console.log("Slack alert sent for stuck status");
      } catch (slackError) {
        console.error("Slack error:", slackError.message);
      }
      
      return res.status(200).end();
    }

    // Check for ambiguous statuses
    const ambiguousIssue = checkAmbiguousStatus(itemId, updateText);
    if (ambiguousIssue) {
      console.log("Ambiguous status timeout reached");
      const location = getLocationFromColumns(itemDetails, boardConfig);
      ambiguousIssue.carrier = detectCarrier(updateText);
      
      const slackMessage = createSlackMessage(ambiguousIssue, itemDetails, boardConfig, updateText, location);
      
      try {
        await slack.chat.postMessage({
          channel: SLACK_CHANNEL_ID,
          ...slackMessage
        });
        console.log("Slack alert sent for ambiguous status timeout");
      } catch (slackError) {
        console.error("Slack error:", slackError.message);
      }
      
      return res.status(200).end();
    }

    // Check for immediate issues (only if we have some text to analyze)
    const issue = await analyzeIssue(updateText);
    if (issue) {
      const location = getLocationFromColumns(itemDetails, boardConfig);
      
      const customerNotification = shouldNotifyCustomer(updateText);
      if (customerNotification.shouldNotify) {
        console.log("Customer notification required");
        
        const customer = await getCustomerFromMonday(itemDetails, boardConfig);
        if (customer) {
          const hubspotCustomer = await searchCustomerInHubSpot(customer.name);
          if (hubspotCustomer) {
            const emailSent = await sendEmailToCustomer(
              hubspotCustomer, 
              itemDetails.poNumber, 
              customerNotification, 
              location, 
              updateText
            );
            
            if (emailSent) {
              console.log(`Customer email sent to ${hubspotCustomer.email}`);
            }
          } else {
            console.log("Customer not found in HubSpot");
          }
        } else {
          console.log("Customer not found in Monday");
        }
      }
      
      // Send Slack alert
      const slackMessage = createSlackMessage(issue, itemDetails, boardConfig, updateText, location);
      
      try {
        await slack.chat.postMessage({
          channel: SLACK_CHANNEL_ID,
          ...slackMessage
        });
        console.log("Slack alert sent");
      } catch (slackError) {
        console.error("Slack error:", slackError.message);
      }
    } else {
      console.log("No issues detected");
    }

    res.status(200).end();
    
  } catch (err) {
    console.error("Webhook error:", err.message);
    res.status(200).end();
  }
});

app.get("/test", (req, res) => {
  res.send("Multi-board logistics watcher running: " + new Date().toISOString());
});

// Debug endpoint to see what Monday sends
app.post("/webhook-debug", (req, res) => {
  console.log("=== WEBHOOK DEBUG ===");
  console.log("Headers:", req.headers);
  console.log("Body:", JSON.stringify(req.body, null, 2));
  console.log("===================");
  
  // Handle Monday's challenge
  if (req.body?.challenge) {
    console.log("Challenge received:", req.body.challenge);
    return res.json({ challenge: req.body.challenge });
  }
  
  res.status(200).json({ status: "received" });
});

app.listen(PORT, () => {
  console.log(`Multi-board watcher listening on ${PORT}`);
});
