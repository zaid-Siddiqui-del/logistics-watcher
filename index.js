// Updated board configuration with the new duplicate tracking column
const BOARDS = {
  MAIN: "162479257",
  CHINA: "9371034380", 
  INDIA: "9371038978"
};

// Board-specific column IDs for customer tracking (original links)
const TRACKING_COLUMN_IDS = {
  [BOARDS.MAIN]: "text_mkvcdqrw",
  [BOARDS.CHINA]: "text_mkvcdqrw", 
  [BOARDS.INDIA]: "text_mkvcce8m"
};

// Board-specific column IDs for duplicate tracking (tracking numbers only)
const DUP_TRACKING_COLUMN_IDS = {
  [BOARDS.CHINA]: "text_mkvyqp0a", // Only China board has this column
  // Other boards don't have duplicate tracking columns yet
};

// Function to get the duplicate tracking column ID for a board (if it exists)
function getDuplicateTrackingColumnId(boardId) {
  return DUP_TRACKING_COLUMN_IDS[String(boardId)] || null;
}

// Function to get the correct tracking column ID for a board
function getTrackingColumnId(boardId) {
  return TRACKING_COLUMN_IDS[String(boardId)] || "text_mkvcdqrw"; // fallback to main/china column ID
}

// Updated function to update the duplicate tracking column with just the tracking number
async function updateDuplicateTrackingColumn(itemId, trackingNumber, boardId = MONDAY_BOARD_ID) {
  try {
    const duplicateColumnId = getDuplicateTrackingColumnId(boardId);
    
    if (!duplicateColumnId) {
      console.log(`⚠️ No duplicate tracking column configured for ${getBoardName(boardId)} - skipping duplicate update`);
      return;
    }
    
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
    
    console.log(`🔄 Updating duplicate tracking column for item ${itemId} with tracking: ${trackingNumber}`);
    console.log(`📋 Board: ${getBoardName(boardId)} (${boardId})`);
    console.log(`📝 Duplicate Column ID: ${duplicateColumnId}`);
    
    const response = await monday.api(mutation, {
      variables: {
        itemId: String(itemId),
        boardId: String(boardId),
        columnId: duplicateColumnId,
        value: trackingNumber
      }
    });
    
    console.log(`📊 Monday.com API response for duplicate tracking:`, JSON.stringify(response, null, 2));
    
    if (response.errors) {
      console.error(`❌ Monday.com API errors for duplicate tracking:`, response.errors);
    } else {
      console.log(`✅ Updated duplicate tracking for item ${itemId} on ${getBoardName(boardId)}: ${trackingNumber}`);
    }
    
  } catch (error) {
    console.error(`❌ Failed to update duplicate tracking for item ${itemId}:`, error);
    console.error(`❌ Error details:`, error.message);
    console.error(`❌ Stack trace:`, error.stack);
  }
}

// Updated webhook handler - replace the existing tracking extraction logic
app.post("/monday-webhook", async (req, res) => {
  try {
    if (req.body?.challenge) return res.json({ challenge: req.body.challenge });
    
    const event = req.body?.event;
    if (!event) return res.status(200).end();
    
    const updateText = event.value?.value;
    const itemId = event.pulseId;
    const columnId = event.columnId;
    
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

    // Check if this update is from a Customer Tracking column
    const trackingColumnId = getTrackingColumnId(event.boardId);
    const isTrackingColumn = columnId === trackingColumnId;
    
    // Extract tracking numbers from URLs (only from Customer Tracking columns)
    if (isTrackingColumn) {
      const trackingNumber = extractTrackingNumber(updateText);
      if (trackingNumber && trackingNumber !== updateText.trim()) {
        console.log(`🔍 Extracted tracking number: ${trackingNumber} from URL in Customer Tracking column`);
        console.log(`📍 Original URL will remain in Customer Tracking column: ${trackingColumnId}`);
        console.log(`📍 Tracking number will be added to Duplicate Tracking column`);
        
        // Check if this board has a duplicate tracking column
        const duplicateColumnId = getDuplicateTrackingColumnId(event.boardId);
        if (duplicateColumnId) {
          console.log(`📍 Updating duplicate tracking column: ${duplicateColumnId}`);
          // Update the duplicate tracking column with just the tracking number
          await updateDuplicateTrackingColumn(itemId, trackingNumber, event.boardId);
        } else {
          console.log(`⚠️ Board ${getBoardName(event.boardId)} doesn't have duplicate tracking column configured`);
        }
        
        return res.status(200).end();
      }
    }

    // Continue with the rest of your existing webhook logic...
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

// Add a new test endpoint for the duplicate tracking functionality
app.get("/test-dup-update/:itemId/:trackingNumber", async (req, res) => {
  try {
    const { itemId, trackingNumber } = req.params;
    
    console.log(`🧪 Test duplicate tracking update: Item ${itemId}, Tracking: ${trackingNumber}`);
    
    await updateDuplicateTrackingColumn(itemId, trackingNumber);
    
    res.json({
      success: true,
      message: `Attempted to update duplicate tracking for item ${itemId} with tracking ${trackingNumber}`,
      itemId,
      trackingNumber,
      columnId: getDuplicateTrackingColumnId(MONDAY_BOARD_ID),
      boardSupported: !!getDuplicateTrackingColumnId(MONDAY_BOARD_ID)
    });
    
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});
