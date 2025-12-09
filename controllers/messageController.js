// Existing function को update करें
const processWebhook = async (data) => {
  try {
    // Check if it's from n8n (different format)
    if (data.source === 'n8n' || data.direction === 'outgoing') {
      // n8n format से process करें
      const messageData = {
        from: data.to, // Important: n8n में to है recipient
        to: data.from,
        message: data.message || data.text,
        timestamp: data.timestamp || new Date(),
        messageId: data.messageId || `n8n-${Date.now()}`,
        direction: 'outgoing',
        source: 'n8n'
      };
      
      // Save to database
      const newMessage = new Message({
        from: messageData.from,
        to: messageData.to,
        message: messageData.message,
        timestamp: new Date(messageData.timestamp),
        messageId: messageData.messageId,
        direction: 'outgoing',
        source: 'n8n'
      });
      
      await newMessage.save();
      return;
    }
    
    // Existing Meta webhook processing
    // ... आपका existing code ...
    
  } catch (error) {
    console.error('Error in processWebhook:', error);
  }
};
