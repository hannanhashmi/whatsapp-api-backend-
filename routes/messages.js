// n8n से messages receive करने के लिए नया endpoint

const express = require('express');
const router = express.Router();
router.post('/api/n8n-messages', async (req, res) => {
  try {
    console.log('Received message from n8n:', req.body);
    
    const { message, from, to, timestamp, messageId, direction = 'outgoing' } = req.body;
    
    // Format को Meta webhook format में convert करें
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
                name: 'User'
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
    
    // आपके existing processWebhook function को call करें
    await processWebhook(metaFormat);
    
    res.status(200).json({ 
      success: true, 
      message: 'Message processed successfully' 
    });
    
  } catch (error) {
    console.error('Error processing n8n message:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});
