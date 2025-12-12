const express = require('express');
const router = express.Router();
const { processIncomingMessage } = require('../controllers/messageController');

// -------------------- WhatsApp Webhook --------------------
router.post('/webhook', async (req, res) => {
  try {
    const body = req.body;

    if (body.object === 'whatsapp_business_account') {
      for (const entry of body.entry) {
        for (const change of entry.changes) {
          if (change.field === 'messages' && change.value.messages) {
            const message = change.value.messages[0];
            await processIncomingMessage(message, body);
          }
        }
      }
      res.status(200).send('EVENT_RECEIVED');
    } else {
      res.sendStatus(404);
    }
  } catch (error) {
    console.error('❌ Webhook processing error:', error);
    res.sendStatus(500);
  }
});

// -------------------- n8n Messages Endpoint --------------------
router.post('/api/n8n-messages', async (req, res) => {
  try {
    const { message, from, to, timestamp, messageId } = req.body;

    const metaFormat = {
      object: 'whatsapp_business_account',
      entry: [{
        id: 'n8n-entry',
        changes: [{
          value: {
            messaging_product: 'whatsapp',
            metadata: {
              display_phone_number: to || from,
              phone_number_id: process.env.PHONE_NUMBER_ID || 'n8n-phone-id'
            },
            contacts: [{ profile: { name: 'User' }, wa_id: from }],
            messages: [{
              from,
              id: messageId || `n8n-${Date.now()}`,
              timestamp: timestamp || Math.floor(Date.now() / 1000),
              type: 'text',
              text: { body: message }
            }]
          },
          field: 'messages'
        }]
      }]
    };

    await processIncomingMessage(metaFormat.entry[0].changes[0].value.messages[0], metaFormat);

    res.status(200).json({ success: true, message: 'Message processed successfully' });
  } catch (error) {
    console.error('❌ Error processing n8n message:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
