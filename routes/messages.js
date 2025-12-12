// routes/messages.js
const express = require('express');
const router = express.Router();
const { processWebhook } = require('../server'); // Adjust path as per your project
const { io } = require('../server'); // Socket.IO instance

// ==================== n8n Messages Endpoint ====================
// Receive messages from n8n (Issue 3 & 4 fixes included)
router.post('/api/n8n-messages', async (req, res) => {
  try {
    console.log('📩 Received message from n8n:', req.body);

    const {
      message,
      from,
      to,
      timestamp,
      messageId,
      direction = 'outgoing',
      contactName = 'User'
    } = req.body;

    if (!message || (!from && !to)) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: message and from/to'
      });
    }

    // Convert to Meta webhook format
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
            contacts: [{
              profile: {
                name: contactName
              },
              wa_id: from
            }],
            messages: [{
              from: from,
              id: messageId || `n8n-${Date.now()}`,
              timestamp: timestamp || Math.floor(Date.now() / 1000),
              type: 'text',
              text: {
                body: message
              }
            }]
          },
          field: 'messages'
        }]
      }]
    };

    // Call your existing processWebhook function
    const processedMessage = await processWebhook(metaFormat);

    // ==================== SOCKET.IO EMIT (ISSUE 4 FIX) ====================
    // Send event to dashboard/clients
    io.emit('new_message', {
      from: from,
      to: to,
      message: message,
      messageId: messageId || `n8n-${Date.now()}`,
      timestamp: new Date(timestamp * 1000) || new Date(),
      source: 'n8n',
      direction: direction,
      contactName: contactName,
      n8nForwarded: true
    });

    // Respond success
    res.status(200).json({
      success: true,
      message: 'Message processed and broadcasted successfully'
    });

  } catch (error) {
    console.error('❌ Error processing n8n message:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = router;
