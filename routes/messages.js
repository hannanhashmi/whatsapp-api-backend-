// n8n से messages receive करने के लिए नया endpoint
router.post('/n8n-webhook', async (req, res) => {
  try {
    const { body } = req;
    
    // n8n format से Meta format में convert करें
    const metaFormat = {
      entry: [{
        changes: [{
          value: {
            messages: [{
              from: body.recipient,
              text: { body: body.message }
            }],
            contacts: [{
              wa_id: body.recipient
            }]
          }
        }]
      }]
    };
    
    // Existing message processing logic का use करें
    await processMessage(metaFormat);
    
    res.status(200).json({ success: true });
  } catch (error) {
    console.error('n8n webhook error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});
