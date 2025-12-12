const express = require("express");
const router = express.Router();
const { processIncomingMessage, processOutgoingMessage } = require("../controllers/messageController");

/* ---------------------------
   MAIN META WEBHOOK HANDLER
---------------------------- */
router.post("/webhook", async (req, res) => {
  try {
    console.log("📩 Incoming Meta Webhook:", JSON.stringify(req.body, null, 2));

    if (!req.body.entry || !req.body.entry[0].changes) {
      console.log("❌ Invalid Meta Payload");
      return res.sendStatus(200);
    }

    const change = req.body.entry[0].changes[0];
    const value = change.value;

    if (!value.messages || !value.messages[0]) {
      console.log("⚠ No message detected");
      return res.sendStatus(200);
    }

    const msg = value.messages[0];
    const from = msg.from;

    // Build standard object format for processing
    const messageData = {
      id: msg.id,
      from: from,
      timestamp: msg.timestamp,
      type: msg.type,
      text: msg.text,
      image: msg.image,
      audio: msg.audio,
      video: msg.video,
      document: msg.document,
      sticker: msg.sticker
    };

    // CALL MAIN PROCESSOR
    await processIncomingMessage(messageData);

    return res.sendStatus(200);
  } catch (err) {
    console.error("❌ Webhook Processing Error:", err);
    return res.sendStatus(500);
  }
});


/* ---------------------------
   n8n OUTGOING MESSAGE HANDLER
---------------------------- */
router.post("/n8n-messages", async (req, res) => {
  try {
    console.log("📤 Received Outgoing Message from n8n:", req.body);

    const saved = await processOutgoingMessage(req.body);

    return res.status(200).json({
      success: saved,
      message: saved ? "Message saved" : "Failed saving"
    });

  } catch (err) {
    console.error("❌ Error saving outgoing:", err);
    return res.status(500).json({ success: false });
  }
});

module.exports = router;
