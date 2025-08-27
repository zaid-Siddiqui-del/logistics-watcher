// index.js - Enhanced version with AI analysis for India→UK/EU and China→UK/EU routes
import express from "express";
import dotenv from "dotenv";
import mondaySdk from "monday-sdk-js";
import { WebClient } from "@slack/web-api";
import { GoogleGenerativeAI } from "@google/generative-ai";

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
} = process.env;

const DEBUG = (DEBUG_RAW || "false").toLowerCase() === "true";
const ALWAYS_ALERT = (ALWAYS_ALERT_RAW || "false").toLowerCase() === "true";

console.log("🔧 Environment check:");
console.log("DEBUG:", DEBUG);
console.log("ALWAYS_ALERT:", ALWAYS_ALERT);
console.log("LATEST_UPDATE_COLUMN_ID:", LATEST_UPDATE_COLUMN_ID);

if (!MONDAY_TOKEN || !MONDAY_BOARD_ID || !SLACK_BOT_TOKEN || !SLACK_CHANNEL_ID) {
  console.error("Missing env: MONDAY_TOKEN, MONDAY_BOARD_ID, SLACK_BOT_TOKEN, SLACK_CHANNEL_ID are required");
  process.exit(1);
}

const app = express();
app.use(express.json({ type: "*/*" }));

const monday = mondaySdk();
monday.setToken(MONDAY_TOKEN);

const slack = new WebClient(SLACK_BOT_TOKEN);
const genAI = GEMINI_API_KEY ? new GoogleGenerativeAI(GEMINI_API_KEY) : null;

const recentAlerts = new Map();
const updateHistory = new Map(); // Track update history for stale detection

function checkForStaleUpdate(itemId, updateText, lastUpdateDate) {
  const historyKey = `${itemId}`;
  const now = Date.now();
  const staleThresholdHours = 36;
  const staleThresholdMs = staleThresholdHours * 60 * 60 * 1000;
  
  console.log(`🕐 Checking for stale updates on item ${itemId}`);
  
  if (!updateHistory.has(historyKey)) {
    // First time seeing this item
    updateHistory.set(historyKey, {
      lastUpdateText: updateText,
      firstSeenAt: now,
      lastSeenAt: now,
      updateCount: 1
    });
    console.log(`📝 First time tracking item ${itemId}`);
    return null;
  }
  
  const history = updateHistory.get(historyKey);
  
  // Check if the update text is the same
  if (history.lastUpdateText === updateText) {
    // Same update text
    const timeSinceFirstSeen = now - history.firstSeenAt;
    history.lastSeenAt = now;
    history.updateCount += 1;
    
    console.log(`⏰ Same update for ${Math.round(timeSinceFirstSeen / (1000 * 60 * 60))} hours (count: ${history.updateCount})`);
    
    if (timeSinceFirstSeen > staleThresholdMs) {
      console.log(`🚨 STALE UPDATE DETECTED! Same update for ${Math.round(timeSinceFirstSeen / (1000 * 60 * 60))} hours`);
      return {
        type: "showing stale tracking information",
        severity: "medium", 
        reason: `Same update "${updateText}" for ${Math.round(timeSinceFirstSeen / (1000 * 60 * 60))} hours`,
        isStaleUpdate: true,
        hoursStale: Math.round(timeSinceFirstSeen / (1000 * 60 * 60))
      };
    }
  } else {
    // New update text - reset tracking
    console.log(`✅ New update detected, resetting tracking for item ${itemId}`);
    history.lastUpdateText = updateText;
    history.firstSeenAt = now;
    history.lastSeenAt = now;
    history.updateCount = 1;
  }
  
  updateHistory.set(historyKey, history);
  return null;
}

function isDuplicateAlert(itemId, updateText, issueType) {
  const alertKey = `${itemId}-${updateText}-${issueType}`;
  const now = Date.now();
  const fiveMinutesAgo = now - (5 * 60 * 1000);
  
  for (const [key, timestamp] of recentAlerts.entries()) {
    if (timestamp < fiveMinutesAgo) {
      recentAlerts.delete(key);
    }
  }
  
  if (recentAlerts.has(alertKey)) {
    console.log("🔄 Duplicate alert detected - skipping");
    return true;
  }
  
  recentAlerts.set(alertKey, now);
  return false;
}

const LOCATION_CODES = {
  // Origins
  'IN': 'India',
  'CN': 'China',
  
  // UK destinations
  'UK': 'United Kingdom',
  'GB': 'United Kingdom',
  
  // EU destinations
  'DE': 'Germany',
  'FR': 'France',
  'IT': 'Italy', 
  'ES': 'Spain',
  'NL': 'Netherlands',
  'BE': 'Belgium',
  'AT': 'Austria',
  'SE': 'Sweden',
  'DK': 'Denmark',
  'FI': 'Finland',
  'NO': 'Norway',
  'CH': 'Switzerland',
  'PL': 'Poland',
  'CZ': 'Czech Republic',
  'HU': 'Hungary',
  'RO': 'Romania',
  'BG': 'Bulgaria',
  'GR': 'Greece',
  'PT': 'Portugal',
  'IE': 'Ireland',
  'LU': 'Luxembourg',
  'SK': 'Slovakia',
  'SI': 'Slovenia',
  'EE': 'Estonia',
  'LV': 'Latvia',
  'LT': 'Lithuania',
  'MT': 'Malta',
  'CY': 'Cyprus',
  'HR': 'Croatia',
  
  // Major hubs and cities
  'HEATHROW': 'London Heathrow - UK',
  'GATWICK': 'London Gatwick - UK', 
  'STANSTED': 'London Stansted - UK',
  'EAST MIDLANDS': 'East Midlands - UK',
  'BIRMINGHAM': 'Birmingham - UK',
  'MANCHESTER': 'Manchester - UK',
  'EDINBURGH': 'Edinburgh - UK',
  'GLASGOW': 'Glasgow - UK',
  'COLOGNE': 'Cologne - Germany',
  'LEIPZIG': 'Leipzig - Germany',
  'FRANKFURT': 'Frankfurt - Germany',
  'PARIS': 'Paris - France',
  'AMSTERDAM': 'Amsterdam - Netherlands',
  'MADRID': 'Madrid - Spain',
  'MILAN': 'Milan - Italy',
  'BRUSSELS': 'Brussels - Belgium',
  'VIENNA': 'Vienna - Austria',
  'STOCKHOLM': 'Stockholm - Sweden',
  'COPENHAGEN': 'Copenhagen - Denmark',
  'WARSAW': 'Warsaw - Poland',
  'PRAGUE': 'Prague - Czech Republic',
  'BUDAPEST': 'Budapest - Hungary',
  'BUCHAREST': 'Bucharest - Romania',
  'ATHENS': 'Athens - Greece',
  'LISBON': 'Lisbon - Portugal',
  'DUBLIN': 'Dublin - Ireland',
  'ZURICH': 'Zurich - Switzerland',
  
  // India origins
  'MUMBAI': 'Mumbai - India',
  'DELHI': 'Delhi - India', 
  'BANGALORE': 'Bangalore - India',
  'CHENNAI': 'Chennai - India',
  'KOLKATA': 'Kolkata - India',
  'HYDERABAD': 'Hyderabad - India',
  'PUNE': 'Pune - India',
  'GURGAON': 'Gurgaon - India',
  'NOIDA': 'Noida - India',
  
  // China origins
  'SHANGHAI': 'Shanghai - China',
  'BEIJING': 'Beijing - China',
  'GUANGZHOU': 'Guangzhou - China',
  'SHENZHEN': 'Shenzhen - China',
  'HONG KONG': 'Hong Kong',
  'HK': 'Hong Kong',
  'TIANJIN': 'Tianjin - China',
  'QINGDAO': 'Qingdao - China',
  'XIAMEN': 'Xiamen - China',
  'CHENGDU': 'Chengdu - China'
};

function extractLocationFromUpdate(updateText) {
  if (!updateText) return null;
  
  console.log("🔍 Extracting location from:", updateText);
  
  // Enhanced location extraction patterns
  const locationPatterns = [
    // Format: "STANSTED - UK", "GATWICK - UK"
    /([A-Z][A-Z\s]+)\s*-\s*([A-Z]{2})/g,
    // Format: "BRISTOL-UK", "LONDON-UK"  
    /([A-Z][A-Z\s]+)-([A-Z]{2})/g,
    // Format: "at STANSTED", "in LONDON"
    /(?:at|in)\s+([A-Z][A-Z\s]+)/g,
    // Country codes at end: "processing in UK"
    /(?:in|from|to)\s+([A-Z]{2})(?:\s|$)/g
  ];
  
  for (const pattern of locationPatterns) {
    const matches = [...updateText.matchAll(pattern)];
    if (matches.length > 0) {
      const match = matches[matches.length - 1]; // Get the last match (most recent location)
      
      if (match[2]) {
        // Has country code
        const city = match[1].trim();
        const countryCode = match[2].trim();
        const country = LOCATION_CODES[countryCode] || countryCode;
        const fullLocation = `${city} - ${country}`;
        console.log(`✅ Extracted location: ${fullLocation}`);
        return fullLocation;
      } else if (match[1]) {
        // Just location name
        const location = match[1].trim();
        console.log(`✅ Extracted location: ${location}`);
        return location;
      }
    }
  }
  
  console.log("❌ No location extracted from update");
  return null;
}

function getLocationFromColumns(columnMap) {
  console.log("🔍 Searching for location in Monday columns...");
  
  // Priority order for location detection - Latest Location is AUTHORITATIVE
  const locationSources = [
    { patterns: ['latest_location', 'latest_loc'], label: 'Latest Location', priority: 1 },
    { patterns: ['current_location', 'current_loc'], label: 'Current Location', priority: 2 },
    { patterns: ['location'], label: 'Location', priority: 3 },
    { patterns: ['hub'], label: 'Hub', priority: 4 },
    { patterns: ['qc_hub'], label: 'QC Hub', priority: 5 },
    { patterns: ['region'], label: 'Region', priority: 6 }
  ];
  
  for (const source of locationSources) {
    // Check exact matches first
    for (const pattern of source.patterns) {
      if (columnMap[pattern]) {
        console.log(`✅ Found location in ${source.label} (exact): ${columnMap[pattern]}`);
        return columnMap[pattern];
      }
    }
    
    // Check partial matches in column IDs
    for (const [colId, colText] of Object.entries(columnMap)) {
      if (colText) {
        const lowerColId = colId.toLowerCase();
        for (const pattern of source.patterns) {
          if (lowerColId.includes(pattern.toLowerCase())) {
            console.log(`✅ Found location in ${source.label} (${colId}): ${colText}`);
            return colText;
          }
        }
      }
    }
  }
  
  console.log("❌ No location found in Monday columns");
  return 'Unknown Location';
}

// Enhanced patterns for India→UK/EU (UPS) and China→UK/EU (DHL/FedEx)
const ISSUE_PATTERNS = {
  // Delivery success patterns (no alerts)
  delivered: /\b(delivered|shipment delivered|delivery complete|left with|signed for by)\b/i,
  
  // NORMAL OPERATIONS - UPS (India → UK/EU)
  upsNormalIndia: /(warehouse scan|facility scan|package received|origin scan|departure scan|arrived at ups facility|departed ups facility|in transit|export scan|import scan|cleared customs|customs clearance complete|out for delivery)/i,
  
  // NORMAL OPERATIONS - DHL (China → UK/EU)
  dhlNormalChina: /(shipment information received|collected|arrived at dhl facility|departed from dhl facility|processed at|forwarded to|arrived at destination|with delivery courier|en route to delivery|shipment on hold for delivery|delivery courier)/i,
  
  // NORMAL OPERATIONS - FedEx (China → UK/EU)  
  fedexNormalChina: /(shipment information sent|picked up|arrived at fedex location|departed fedex location|in transit|customs status updated|international shipment release|on fedex vehicle|out for delivery)/i,
  
  // CUSTOMS ISSUES - UPS India
  upsCustomsIndia: /(held by customs|customs delay|customs clearance delay|awaiting customs clearance|held for customs inspection|import duties required|customs documentation required|held pending customs)/i,
  upsCustomsResolvedIndia: /(customs clearance complete|released by customs|import scan complete|customs cleared|duties paid)/i,
  
  // CUSTOMS ISSUES - DHL China  
  dhlCustomsChina: /(clearance processing|customs clearance|held for customs clearance|clearance event|customs status updated - held|awaiting customs clearance|import customs clearance|customs delay|document required|duty payment required|kyc|know your customer)/i,
  dhlCustomsResolvedChina: /(clearance processing complete|clearance complete|customs clearance complete|released by customs|import customs clearance complete|customs status updated - cleared)/i,
  
  // CUSTOMS ISSUES - FedEx China
  fedexCustomsChina: /(customs status updated|held by customs|clearance delay|international shipment - customs delay|awaiting clearance|customs clearance in progress|broker notified|duty\/tax required)/i,
  fedexCustomsResolvedChina: /(international shipment release|customs clearance complete|released by customs|cleared customs)/i,
  
  // DELIVERY ISSUES - All carriers
  deliveryFailed: /(delivery attempted|delivery exception|recipient unavailable|address incorrect|consignee unavailable|no one available|incorrect address|access denied|refused|undeliverable|return to sender|held for pickup|delivery not attempted|customer not available|premises closed)/i,
  
  // INTERNATIONAL TRANSIT ISSUES
  transitIssues: /(flight delay|aircraft delay|weather delay|operational delay|mechanical delay|service disruption|network disruption|shipment delay|transportation delay)/i,
  
  // HUB SPECIFIC ISSUES - Common UK/EU entry points
  hubIssues: /(held at|processing delay at|delayed at|exception at).*(heathrow|gatwick|stansted|east midlands|cologne|leipzig|paris|amsterdam|madrid)/i,
  
  // DAMAGE/LOSS/INVESTIGATION
  damageOrLoss: /(damaged|lost|missing|investigation|claim|package contents|integrity|security|theft|misrouted|cannot locate)/i,
  
  // UK/EU SPECIFIC DELIVERY ISSUES
  ukEuDelivery: /(royal mail|parcelforce|dpd|yodel|hermes|evri|local courier|final mile|domestic delivery partner).*(delay|exception|failed|attempted)/i,
  
  // BREXIT/EU CUSTOMS SPECIFIC
  brexitEu: /(brexit|eu customs|european union|vat|tariff|commodity code|eori|export declaration|import declaration|c88|sad|single administrative document)/i
};

function detectCarrier(updateText) {
  if (!updateText) return 'unknown';
  
  const text = updateText.toLowerCase();
  
  if (text.includes('ups') || text.includes('united parcel')) {
    return 'UPS';
  } else if (text.includes('dhl')) {
    return 'DHL';
  } else if (text.includes('fedex') || text.includes('federal express')) {
    return 'FedEx';
  }
  
  return 'unknown';
}

function detectIssueBasic(updateText) {
  if (!updateText) return null;
  
  console.log("🔍 Enhanced India/China→UK/EU pattern analysis:", updateText);
  
  const text = updateText.toLowerCase();
  const carrier = detectCarrier(text);
  
  // 1. Check for delivered/successful states first (no alert)
  if (ISSUE_PATTERNS.delivered.test(text)) {
    console.log("✅ Delivery complete - no alert needed");
    return null;
  }
  
  // 2. Check for normal operations by carrier (no alert)
  if ((carrier === 'UPS' && ISSUE_PATTERNS.upsNormalIndia.test(text)) ||
      (carrier === 'DHL' && ISSUE_PATTERNS.dhlNormalChina.test(text)) ||
      (carrier === 'FedEx' && ISSUE_PATTERNS.fedexNormalChina.test(text))) {
    console.log(`✅ Normal ${carrier} processing - no alert needed`);
    return null;
  }
  
  // 3. Check for resolved customs by carrier (no alert)
  if ((carrier === 'UPS' && ISSUE_PATTERNS.upsCustomsResolvedIndia.test(text)) ||
      (carrier === 'DHL' && ISSUE_PATTERNS.dhlCustomsResolvedChina.test(text)) ||
      (carrier === 'FedEx' && ISSUE_PATTERNS.fedexCustomsResolvedChina.test(text))) {
    console.log(`✅ ${carrier} customs cleared - no alert needed`);
    return null;
  }
  
  // 4. Check for active customs issues by carrier (alert needed)
  if ((carrier === 'UPS' && ISSUE_PATTERNS.upsCustomsIndia.test(text)) ||
      (carrier === 'DHL' && ISSUE_PATTERNS.dhlCustomsChina.test(text)) ||
      (carrier === 'FedEx' && ISSUE_PATTERNS.fedexCustomsChina.test(text))) {
    console.log(`🚨 ${carrier} CUSTOMS ISSUE detected!`);
    return {
      type: "held in customs",
      severity: "high",
      reason: `${carrier} customs clearance issue detected`,
      carrier: carrier
    };
  }
  
  // 5. Check for delivery failures (alert needed)
  if (ISSUE_PATTERNS.deliveryFailed.test(text)) {
    console.log("🚨 DELIVERY FAILURE detected!");
    return {
      type: "experiencing delivery failure",
      severity: "high",
      reason: "Failed delivery attempt",
      carrier: carrier
    };
  }
  
  // 6. Check for UK/EU specific delivery issues
  if (ISSUE_PATTERNS.ukEuDelivery.test(text)) {
    console.log("🚨 UK/EU DELIVERY ISSUE detected!");
    return {
      type: "experiencing final mile delivery issue",
      severity: "high", 
      reason: "UK/EU domestic delivery partner issue",
      carrier: carrier
    };
  }
  
  // 7. Check for hub-specific issues
  if (ISSUE_PATTERNS.hubIssues.test(text)) {
    console.log("🚨 HUB PROCESSING ISSUE detected!");
    return {
      type: "experiencing processing delay at hub",
      severity: "medium",
      reason: "Delay at major processing hub",
      carrier: carrier
    };
  }
  
  // 8. Check for transit/flight delays
  if (ISSUE_PATTERNS.transitIssues.test(text)) {
    console.log("🚨 TRANSIT DELAY detected!");
    return {
      type: "experiencing transit delay", 
      severity: "medium",
      reason: "International transit delay",
      carrier: carrier
    };
  }
  
  // 9. Check for damage/loss (alert needed)  
  if (ISSUE_PATTERNS.damageOrLoss.test(text)) {
    console.log("🚨 DAMAGE/LOSS detected!");
    return {
      type: "experiencing damage or loss issue",
      severity: "high", 
      reason: "Potential damage or loss detected",
      carrier: carrier
    };
  }
  
  // 10. Check for Brexit/EU customs complexity
  if (ISSUE_PATTERNS.brexitEu.test(text)) {
    console.log("🚨 BREXIT/EU CUSTOMS ISSUE detected!");
    return {
      type: "experiencing EU customs complexity",
      severity: "medium",
      reason: "Brexit/EU customs documentation issue",
      carrier: carrier
    };
  }
  
  console.log("✅ No issues detected in enhanced analysis");
  return null;
}

async function analyzeWithGemini(updateText, itemDetails, columnMap, isStaleUpdate = false) {
  if (!genAI) {
    console.log("⚠️ Gemini not configured - falling back to pattern matching");
    return detectIssueBasic(updateText);
  }
  
  try {
    console.log("🤖 Analyzing with Gemini AI...");
    
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
    
    // Create context from Monday columns
    const contextData = {
      itemName: itemDetails.name,
      updateText: updateText,
      columns: {}
    };
    
    // Include relevant columns for context
    const relevantColumns = ['region', 'qc_hub', 'post_production', 'customer_dispatch_status', 'latest_location'];
    for (const col of relevantColumns) {
      if (columnMap[col]) {
        contextData.columns[col] = columnMap[col];
      }
    }
    
    const prompt = `
You are analyzing shipping updates for packages moving on these specific routes:
- UPS: India → UK/European Union  
- DHL: China → UK/European Union
- FedEx: China → UK/European Union

CONTEXT:
- Item: ${contextData.itemName}
- Latest Update: "${updateText}"
- Current Data: ${JSON.stringify(contextData.columns, null, 2)}
- Is Stale Update: ${isStaleUpdate ? 'YES - Same update for extended period' : 'NO'}

ROUTE-SPECIFIC ANALYSIS RULES:

UPS INDIA → UK/EU (NO ALERT):
- "Warehouse scan", "Origin scan", "Departure scan", "Export scan"
- "Arrived at UPS facility", "Departed UPS facility", "In transit"
- "Import scan", "Customs clearance complete", "Released by customs"
- "Out for delivery", "Delivered", "Left with"

UPS INDIA → UK/EU (ALERT):
- "Held by customs", "Customs delay", "Import duties required"
- "Held for customs inspection", "Documentation required"
- "Delivery attempted", "Recipient unavailable", "Address incorrect"

DHL CHINA → UK/EU (NO ALERT):
- "Shipment information received", "Collected", "Processed at"
- "Arrived at DHL facility", "Departed from DHL facility" 
- "Clearance processing complete", "Customs clearance complete"
- "With delivery courier", "Out for delivery", "Delivered"

DHL CHINA → UK/EU (ALERT):
- "Clearance processing" (without complete), "Held for customs"
- "Document required", "Duty payment required", "KYC required"
- "Delivery attempted", "Customer not available", "Premises closed"

FEDEX CHINA → UK/EU (NO ALERT):
- "Shipment information sent", "Picked up", "In transit"
- "Arrived at FedEx location", "Departed FedEx location"
- "International shipment release", "Customs clearance complete"
- "On FedEx vehicle", "Delivered", "Signed for by"

FEDEX CHINA → UK/EU (ALERT):
- "Customs status updated" (if held), "Clearance delay"
- "Duty/tax required", "Broker notified", "Document required"
- "Delivery exception", "Customer not available"

COMMON ISSUES (ALL CARRIERS):
- Transit delays: "Flight delay", "Weather delay", "Service disruption"
- Hub issues: Problems at Heathrow, Stansted, Cologne, Leipzig, etc.
- Final mile: Royal Mail, DPD, Yodel delivery partner issues
- Brexit/EU: VAT, EORI, customs documentation complexity
- Damage: "Damaged", "Lost", "Investigation", "Claim"

STALE TRACKING (ALERT):
- Same update text for 36+ hours = tracking issue

RESPONSE FORMAT (JSON only):
{
  "hasIssue": boolean,
  "issueType": "customs_held" | "delivery_failed" | "transit_delay" | "hub_delay" | "final_mile_issue" | "damage_loss" | "eu_customs_complex" | "tracking_stale" | null,
  "severity": "high" | "medium" | "low", 
  "reason": "brief explanation with route context",
  "currentLocation": "extracted location or null",
  "isResolved": boolean,
  "carrier": "UPS" | "DHL" | "FedEx" | "unknown",
  "route": "India-UK" | "India-EU" | "China-UK" | "China-EU" | "unknown"
}

Analyze this update and respond with JSON only:`;

    const result = await model.generateContent(prompt);
    const response = result.response.text().trim();
    
    console.log("🤖 Gemini raw response:", response);
    
    // Parse JSON response
    let analysis;
    try {
      // Extract JSON from response (in case there's extra text)
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        analysis = JSON.parse(jsonMatch[0]);
      } else {
        analysis = JSON.parse(response);
      }
    } catch (parseError) {
      console.log("⚠️ Failed to parse Gemini response as JSON, falling back to basic detection");
      return detectIssueBasic(updateText);
    }
    
    console.log("✅ Gemini analysis:", analysis);
    
    // Convert to our expected format
    if (!analysis.hasIssue || analysis.isResolved) {
      return null;
    }
    
    return {
      type: analysis.issueType === 'customs_held' ? 'held in customs' : 
            analysis.issueType === 'delivery_failed' ? 'experiencing delivery failure' :
            analysis.issueType === 'transit_delay' ? 'experiencing transit delay' :
            analysis.issueType === 'hub_delay' ? 'experiencing processing delay at hub' :
            analysis.issueType === 'final_mile_issue' ? 'experiencing final mile delivery issue' :
            analysis.issueType === 'damage_loss' ? 'experiencing damage or loss issue' :
            analysis.issueType === 'eu_customs_complex' ? 'experiencing EU customs complexity' :
            analysis.issueType === 'tracking_stale' ? 'showing stale tracking information' :
            'experiencing a delay',
      severity: analysis.severity,
      reason: analysis.reason,
      extractedLocation: analysis.currentLocation,
      carrier: analysis.carrier || 'unknown',
      route: analysis.route || 'unknown'
    };
    
  } catch (error) {
    console.error("❌ Gemini analysis failed:", error.message);
    console.log("⚠️ Falling back to basic pattern detection");
    return detectIssueBasic(updateText);
  }
}

async function getItemDetails(itemId) {
  try {
    console.log("📥 Fetching item details for:", itemId);
    
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
      variables: { itemIds: [String(itemId)] },
    });
    
    if (DEBUG) {
      console.log("📥 Monday API Response:");
      console.log(JSON.stringify(response, null, 2));
    }
    
    const item = response?.data?.items?.[0];
    if (!item) {
      console.log("❌ Item not found in API response");
      return null;
    }
    
    console.log("✅ Item found:", item.name);
    
    const columnMap = {};
    
    item.column_values.forEach(col => {
      columnMap[col.id] = col.text || '';
    });
    
    console.log("📋 Found columns with data:");
    for (const [id, text] of Object.entries(columnMap)) {
      if (text) console.log(`   ${id}: ${text}`);
    }
    
    return {
      id: item.id,
      name: item.name,
      columnMap,
      poNumber: item.name.startsWith('PO') ? item.name : item.name
    };
    
  } catch (error) {
    console.error("💥 Monday API Error:", error.message);
    return null;
  }
}

function getCustomerDate(columnMap) {
  let customerDate = null;
  
  console.log("🔍 Searching for customer delivery date...");
  
  // Priority order for customer delivery date detection
  const customerDatePatterns = [
    // Exact matches (highest priority)
    { patterns: ['customer_delivery_date', 'customer_date', 'delivery_date_customer'], label: 'Customer Delivery Date', priority: 1 },
    { patterns: ['due_to_customer', 'due_to_cust', 'customer_due'], label: 'Due to Customer', priority: 2 },
    { patterns: ['final_delivery', 'end_delivery', 'customer_delivery'], label: 'Final Delivery', priority: 3 },
    
    // Partial matches (lower priority) - avoid hub/shipping dates
    { patterns: ['delivery_date'], label: 'Delivery Date', priority: 4, exclude: ['hub', 'ship', 'dispatch'] },
    { patterns: ['due_date'], label: 'Due Date', priority: 5, exclude: ['hub', 'ship', 'dispatch'] }
  ];
  
  for (const datePattern of customerDatePatterns) {
    // Check exact matches first
    for (const pattern of datePattern.patterns) {
      if (columnMap[pattern]) {
        console.log(`✅ Found customer date in ${datePattern.label} (exact): ${columnMap[pattern]}`);
        return columnMap[pattern];
      }
    }
    
    // Check partial matches in column IDs
    for (const [colId, colText] of Object.entries(columnMap)) {
      if (colText && colText.length > 5) { // Only consider columns with actual dates
        const lowerColId = colId.toLowerCase();
        
        for (const pattern of datePattern.patterns) {
          if (lowerColId.includes(pattern.toLowerCase())) {
            
            // Check if we should exclude this column (avoid hub/shipping dates)
            if (datePattern.exclude) {
              const shouldExclude = datePattern.exclude.some(excludePattern => 
                lowerColId.includes(excludePattern.toLowerCase())
              );
              if (shouldExclude) {
                console.log(`⏭️ Skipping ${colId} (contains excluded pattern)`);
                continue;
              }
            }
            
            console.log(`✅ Found customer date in ${datePattern.label} (${colId}): ${colText}`);
            return colText;
          }
        }
      }
    }
  }
  
  // Final fallback: look for any date column that clearly indicates customer delivery
  for (const [colId, colText] of Object.entries(columnMap)) {
    const lowerColId = colId.toLowerCase();
    
    // Look for customer-specific date columns
    if (colText && colText.length > 5 && 
        (lowerColId.includes('customer') || lowerColId.includes('final')) && 
        (lowerColId.includes('date') || lowerColId.includes('due'))) {
      
      // Avoid hub, dispatch, shipping dates
      if (!lowerColId.includes('hub') && !lowerColId.includes('dispatch') && !lowerColId.includes('ship')) {
        console.log(`✅ Found customer date in fallback search (${colId}): ${colText}`);
        return colText;
      }
    }
  }
  
  console.log("❌ No customer delivery date found");
  return null;
}

function createStaleUpdateSlackMessage(staleIssue, itemDetails, updateText, customerDate, location) {
  const poNumber = itemDetails.poNumber;
  
  let mainMessage = `${poNumber} ${staleIssue.type} from ${location}. No tracking updates for ${staleIssue.hoursStale} hours.`;
  
  const detailsBlock = `📦 *Item:* ${poNumber}\n📝 *Stale Update:* ${updateText}\n📍 *Location:* ${location}\n📅 *Customer Delivery Date:* ${customerDate || 'Not specified'}\n🔍 *Issue Type:* ${staleIssue.type}\n⚡ *Severity:* ${staleIssue.severity}\n⏰ *Stale Duration:* ${staleIssue.hoursStale} hours\n🤖 *Analysis:* ${staleIssue.reason}`;
  
  return {
    text: mainMessage,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `⏰ *${mainMessage}*`
        }
      },
      {
        type: "section", 
        text: {
          type: "mrkdwn",
          text: detailsBlock
        }
      }
    ]
  };
}

function createSlackMessage(issue, itemDetails, updateText, customerDate, location) {
  const poNumber = itemDetails.poNumber;
  const carrierEmoji = issue.carrier === 'UPS' ? '📦' : issue.carrier === 'DHL' ? '🚚' : issue.carrier === 'FedEx' ? '✈️' : '📫';
  const routeInfo = issue.route ? ` (${issue.route})` : '';
  
  let mainMessage = `${poNumber} is ${issue.type} from ${location}. Please review.`;
  
  const detailsBlock = `${carrierEmoji} *Item:* ${poNumber}\n📝 *Latest Update:* ${updateText}\n📍 *Current Location:* ${location}\n📅 *Customer Delivery Date:* ${customerDate || 'Not specified'}\n🔍 *Issue Type:* ${issue.type}\n⚡ *Severity:* ${issue.severity}\n🚛 *Carrier:* ${issue.carrier?.toUpperCase() || 'Unknown'}${routeInfo}\n🤖 *Analysis:* ${issue.reason}`;
  
  return {
    text: mainMessage,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `🚨 *${mainMessage}*`
        }
      },
      {
        type: "section", 
        text: {
          type: "mrkdwn",
          text: detailsBlock
        }
      }
    ]
  };
}

app.post("/monday-webhook", async (req, res) => {
  console.log("=".repeat(50));
  console.log("🚀 WEBHOOK RECEIVED AT:", new Date().toISOString());
  console.log("=".repeat(50));

  try {
    if (req.body?.challenge) {
      console.log("📋 Challenge response sent");
      return res.json({ challenge: req.body.challenge });
    }

    const event = req.body?.event;
    if (!event) {
      console.log("❌ No event data");
      return res.status(200).end();
    }

    console.log("📦 Event summary:");
    console.log("   Item:", event.pulseName);
    console.log("   Column:", event.columnTitle);
    console.log("   New value:", event.value?.value || "empty");
    console.log("   Previous:", event.previousValue?.value || "empty");

    const changedColumn = event.columnId;
    console.log("🔍 Changed column:", changedColumn);
    console.log("🎯 Target column ID:", LATEST_UPDATE_COLUMN_ID);
    
    if (LATEST_UPDATE_COLUMN_ID && changedColumn !== LATEST_UPDATE_COLUMN_ID) {
      console.log("❌ EARLY RETURN: Different column changed");
      return res.status(200).end();
    }
    console.log("✅ Column check passed");

    const updateText = event.value?.value;
    const itemName = event.pulseName;
    const itemId = event.pulseId;

    if (ALWAYS_ALERT) {
      console.log("🔔 ALWAYS_ALERT=true → sending test alert");
      
      const itemDetails = await getItemDetails(itemId);
      if (itemDetails) {
        const testMessage = `🧪 TEST: ${itemDetails.poNumber} updated to "${updateText}"`;
        
        try {
          const result = await slack.chat.postMessage({
            channel: SLACK_CHANNEL_ID,
            text: testMessage
          });
          console.log("✅ Test Slack message sent, ts:", result.ts);
        } catch (slackError) {
          console.error("❌ Slack error:", slackError.message);
        }
      }
      return res.status(200).end();
    }

    console.log("📥 Getting item details for analysis...");
    const itemDetails = await getItemDetails(itemId);
    
    if (!itemDetails) {
      console.log("❌ Could not get item details - skipping analysis");
      return res.status(200).end();
    }

    // Check for stale updates first
    const staleIssue = checkForStaleUpdate(itemId, updateText);
    if (staleIssue && !isDuplicateAlert(itemId, updateText, staleIssue.type)) {
      console.log("🚨 Stale update detected - sending alert");
      
      const location = getLocationFromColumns(itemDetails.columnMap);
      const customerDate = getCustomerDate(itemDetails.columnMap);
      
      const slackMessage = createStaleUpdateSlackMessage(staleIssue, itemDetails, updateText, customerDate, location);
      
      try {
        const result = await slack.chat.postMessage({
          channel: SLACK_CHANNEL_ID,
          ...slackMessage
        });
        console.log("✅ Stale update alert sent, ts:", result.ts);
      } catch (slackError) {
        console.error("❌ Slack error:", slackError.message);
      }
      
      return res.status(200).end();
    }

    // Use AI analysis for regular issues
    const issue = await analyzeWithGemini(updateText, itemDetails, itemDetails.columnMap, !!staleIssue);
    
    if (!issue) {
      console.log("✅ No issues detected by AI - no alert sent");
      return res.status(200).end();
    }

    if (isDuplicateAlert(itemId, updateText, issue.type)) {
      return res.status(200).end();
    }

    // Determine location - PRIORITY: Monday Latest Location column > AI > update text
    let location = 'Unknown Location';
    
    // First priority: Monday's Latest Location column (authoritative)
    const mondayLocation = getLocationFromColumns(itemDetails.columnMap);
    if (mondayLocation !== 'Unknown Location') {
      location = mondayLocation;
      console.log(`🎯 Using Monday Latest Location: ${location}`);
    } else if (issue.extractedLocation) {
      location = issue.extractedLocation;
      console.log(`🎯 Using AI extracted location: ${location}`);
    } else {
      const updateLocation = extractLocationFromUpdate(updateText);
      if (updateLocation) {
        location = updateLocation;
        console.log(`🎯 Using update text location: ${location}`);
      }
    }

    // Get customer delivery date
    const customerDate = getCustomerDate(itemDetails.columnMap);
    
    console.log("📅 Found customer date:", customerDate);
    console.log("📍 Final detected location:", location);

    const slackMessage = createSlackMessage(issue, itemDetails, updateText, customerDate, location);
    
    console.log("📤 Sending AI-analyzed alert to Slack...");
    console.log("💬 Message:", slackMessage.text);
    
    try {
      const result = await slack.chat.postMessage({
        channel: SLACK_CHANNEL_ID,
        ...slackMessage
      });
      
      console.log("✅ AI alert sent successfully, ts:", result.ts);
      
    } catch (slackError) {
      console.error("❌ Slack error:", slackError.message);
    }

    res.status(200).end();
    
  } catch (err) {
    console.error("💥 WEBHOOK ERROR:", err.message);
    console.error("Stack trace:", err.stack);
    res.status(200).end();
  }
});

app.get('/test', (req, res) => {
  console.log('🧪 TEST ENDPOINT HIT!');
  res.send('Hello from your enhanced logistics watcher! Time: ' + new Date().toISOString());
});

app.listen(PORT, () => {
  console.log(`✅ Enhanced Watcher listening on port ${PORT}`);
  console.log(`🧪 Test endpoint: http://localhost:${PORT}/test`);
});