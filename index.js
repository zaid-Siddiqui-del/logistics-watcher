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
  LATEST_UPDATE_COLUMN_ID,
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

const recentAlerts = new Map();
const updateHistory = new Map();
const ambiguousStatusHistory = new Map();

const AMBIGUOUS_STATUSES = {
  "clearance event": { hours: 18 },
  "customs clearance": { hours: 18 },
  "processing": { hours: 24 },
  "on hold": { hours: 6 },
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

function checkAmbiguousStatus(itemId, updateText) {
  const now = Date.now();
  const lowerText = updateText.toLowerCase();
  
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

function getLogisticsCoordinator(itemDetails, carrier) {
  // Get region from Monday board (status77 column)
  const region = itemDetails?.columnMap?.status77;
  
  if (region) {
    const upperRegion = region.toUpperCase();
    console.log(`Region found: ${region}`);
    
    // Assign coordinator based on region
    if (upperRegion.includes("INDIA") || upperRegion.includes("IN")) {
      console.log("Assigning Haritha (India coordinator)");
      return LOGISTICS_COORDINATORS.HARITHA_INDIA;
    } else if (upperRegion.includes("CHINA") || upperRegion.includes("CN")) {
      console.log("Assigning Rachel (China coordinator)");
      return LOGISTICS_COORDINATORS.RACHEL_CHINA;
    }
  }
  
  // Fallback logic if region column is empty or doesn't match
  console.log("Region not found or doesn't match India/China, using carrier-based fallback");
  if (carrier === "UPS") {
    console.log("UPS carrier detected - defaulting to Haritha (India)");
    return LOGISTICS_COORDINATORS.HARITHA_INDIA;
  } else {
    console.log("Non-UPS carrier detected - defaulting to Rachel (China)");
    return LOGISTICS_COORDINATORS.RACHEL_CHINA;
  }
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
  const text = updateText.toLowerCase();
  
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

async function getCustomerFromMonday(itemDetails) {
  try {
    console.log("Looking for customer information in Monday columns...");
    
    // Check specific customer column first
    if (itemDetails.columnMap['text1']) {
      console.log(`Found customer in text1: ${itemDetails.columnMap['text1']}`);
      return {
        name: itemDetails.columnMap['text1'],
        columnId: 'text1'
      };
    }
    
    // Fallback patterns
    const customerPatterns = ["customer", "customer_name", "client", "company", "consignee"];
    
    for (const pattern of customerPatterns) {
      if (itemDetails.columnMap[pattern]) {
        console.log(`Found customer in ${pattern}: ${itemDetails.columnMap[pattern]}`);
        return {
          name: itemDetails.columnMap[pattern],
          columnId: pattern
        };
      }
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

function getLocationFromColumns(columnMap) {
  console.log("Searching for location in Monday columns...");
  
  if (DEBUG) {
    console.log("Available Monday columns:");
    for (const [colId, colText] of Object.entries(columnMap)) {
      if (colText) console.log(`   ${colId}: "${colText}"`);
    }
  }
  
  if (columnMap["text5__1"]) {
    console.log(`Found location: ${columnMap["text5__1"]}`);
    return columnMap["text5__1"];
  }
  
  return "Unknown Location";
}

async function getItemDetails(itemId) {
  try {
    console.log("Fetching item details for:", itemId);
    
    const query = `
      query($itemIds: [ID!]) {
        items(ids: $itemIds) {
          id
          name
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
      columnMap,
      poNumber: item.name
    };
    
  } catch (error) {
    console.error("Monday API Error:", error.message);
    return null;
  }
}

function createSlackMessage(issue, itemDetails, updateText, location) {
  const poNumber = itemDetails.poNumber;
  const coordinator = getLogisticsCoordinator(itemDetails, issue.carrier);
  const carrierEmoji = issue.carrier === "UPS" ? "📦" : issue.carrier === "DHL" ? "🚚" : issue.carrier === "FedEx" ? "✈️" : "📫";
  
  const mainMessage = `${poNumber} is ${issue.type} from ${location}. Please review.`;
  
  const detailsBlock = `${carrierEmoji} Item: ${poNumber}\n📝 Latest Update: ${updateText}\n📍 Current Location: ${location}\n🔍 Issue Type: ${issue.type}\n⚡ Severity: ${issue.severity}\n🚛 Carrier: ${issue.carrier}\n🤖 Analysis: ${issue.reason}`;
  
  return {
    text: `${coordinator} ${mainMessage}`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `${coordinator} ${mainMessage}`
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
  const text = updateText.toLowerCase();
  const carrier = detectCarrier(updateText);
  
  if (text.includes("delivered")) return null;
  
  if (text.includes("held by customs") || text.includes("document required") || text.includes("on hold")) {
    return {
      type: "held in customs",
      severity: "high",
      reason: "Customs issue detected",
      carrier: carrier,
      route: carrier === "UPS" ? "India-UK" : "China-UK"
    };
  }
  
  if (text.includes("delivery attempted") || text.includes("recipient unavailable") || text.includes("premises closed")) {
    return {
      type: "experiencing delivery failure",
      severity: "high", 
      reason: "Failed delivery attempt",
      carrier: carrier,
      route: carrier === "UPS" ? "India-UK" : "China-UK"
    };
  }
  
  return null;
}

app.post("/monday-webhook", async (req, res) => {
  console.log("Processing:", req.body?.event?.pulseName, "->", req.body?.event?.value?.value);
  
  try {
    if (req.body?.challenge) {
      return res.json({ challenge: req.body.challenge });
    }

    const event = req.body?.event;
    if (!event) {
      return res.status(200).end();
    }

    const updateText = event.value?.value;
    const itemId = event.pulseId;

    if (!updateText) {
      console.log("No update text - skipping");
      return res.status(200).end();
    }

    const itemDetails = await getItemDetails(itemId);
    if (!itemDetails) {
      return res.status(200).end();
    }

    const ambiguousIssue = checkAmbiguousStatus(itemId, updateText);
    if (ambiguousIssue) {
      console.log("Ambiguous status timeout reached");
      return res.status(200).end();
    }

    const issue = await analyzeIssue(updateText);
    if (issue) {
      const location = getLocationFromColumns(itemDetails.columnMap);
      
      const customerNotification = shouldNotifyCustomer(updateText);
      if (customerNotification.shouldNotify) {
        console.log("Customer notification required");
        
        const customer = await getCustomerFromMonday(itemDetails);
        if (customer) {
          const hubspotCustomer = await searchCustomerInHubSpot(customer.name);
          if (hubspotCustomer) {
            const emailSent = await sendEmailToCustomer(
              hubspotCustomer, 
              itemDetails.poNumber, 
              customerNotification, 
              location, 
              updateText,
              itemDetails
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
        
        // Skip coordinator tagging for customer-side delivery failures
        const slackMessage = createSlackMessage(issue, itemDetails, updateText, location, true);
        
        try {
          await slack.chat.postMessage({
            channel: SLACK_CHANNEL_ID,
            ...slackMessage
          });
          console.log("Slack alert sent (no coordinator tag - customer notified)");
        } catch (slackError) {
          console.error("Slack error:", slackError.message);
        }
      } else {
        // For non-customer delivery failures (customs, etc.), tag coordinators
        const slackMessage = createSlackMessage(issue, itemDetails, updateText, location, false);
        
        try {
          await slack.chat.postMessage({
            channel: SLACK_CHANNEL_ID,
            ...slackMessage
          });
          console.log("Slack alert sent (with coordinator tag)");
        } catch (slackError) {
          console.error("Slack error:", slackError.message);
        }
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
  res.send("Logistics watcher running: " + new Date().toISOString());
});

app.listen(PORT, () => {
  console.log(`Watcher listening on ${PORT}`);
});
