const db = require('../db'); // PostgreSQL pool & helpers
const { io, forwardToN8N } = require('../server');

// -------------------- Incoming WhatsApp Message --------------------
async function processIncomingMessage(message, metaPayload = null) {
  try {
    const phone = message.from;
    const timestamp = new Date(message.timestamp * 1000);

    let content = '[Unsupported Message]';
    let mediaUrl = null;

    // Media + Text handling
    if (message.type === 'image' && message.image) {
      mediaUrl = message.image?.link;
      content = `[Image] ${mediaUrl}`;
    } else if (message.type === 'audio' && message.audio) {
      mediaUrl = message.audio?.link;
      content = `[Audio] ${mediaUrl}`;
    } else if (message.type === 'video' && message.video) {
      mediaUrl = message.video?.link;
      content = `[Video] ${mediaUrl}`;
    } else if (message.type === 'document' && message.document) {
      mediaUrl = message.document?.link;
      content = `[Document] ${mediaUrl}`;
    } else if (message.type === 'sticker' && message.sticker) {
      mediaUrl = message.sticker?.link;
      content = `[Sticker] ${mediaUrl}`;
    } else if (message.text?.body) {
      content = message.text.body;
    }

    // Ensure contact exists
    const contact = await db.findOrCreateContact(phone);

    // Ensure chat exists
    const chat = await db.findOrCreateChat(contact.id, phone);

    // Save message
    const savedMessage = await db.addMessage(chat.id, contact.id, {
      type: 'received',
      content,
      mediaUrl,
      whatsappMessageId: message.id,
      timestamp,
      status: 'delivered'
    });

    // Forward to n8n
    const n8nResult = await forwardToN8N({
      phone,
      content,
      mediaUrl,
      timestamp,
      contactName: contact.name,
      messageId: message.id,
      type: 'received',
      contactId: contact.id,
      chatId: chat.id,
      metaPayload
    }, 'whatsapp_incoming');

    // Emit to dashboard via Socket.IO
    io.emit('new_message', {
      from: phone,
      message: content,
      mediaUrl,
      timestamp,
      contactName: contact.name,
      messageId: savedMessage.id,
      source: 'whatsapp',
      n8nForwarded: n8nResult.success
    });

    console.log(`✅ Incoming message processed: ${content}`);

  } catch (error) {
    console.error('❌ processIncomingMessage error:', error);
  }
}

// -------------------- Outgoing Message --------------------
async function processOutgoingMessage(data) {
  try {
    const to = data.to;
    const content = data.message || "[Media]";
    const media_url = data.mediaUrl || null;
    const media_type = media_url ? "media" : null;
    const whatsapp_message_id = data.wa_id || null;

    // Ensure Contact Exists
    const contact = await db.findOrCreateContact(to);

    // Ensure Chat Exists
    const chat = await db.findOrCreateChat(contact.id, to);

    // Save Outgoing Message
    const savedMessage = await db.addMessage(chat.id, contact.id, {
      type: 'sent',
      content,
      mediaUrl: media_url,
      mediaType: media_type,
      whatsappMessageId: whatsapp_message_id,
      status: 'sent',
      timestamp: new Date()
    });

    // Update Chat Last Message
    await db.updateChatLastMessage(chat.id, content);

    // Forward to n8n
    await forwardToN8N({
      phone: to,
      content,
      mediaUrl: media_url,
      timestamp: new Date(),
      contactName: contact.name,
      messageId: whatsapp_message_id,
      type: 'sent',
      contactId: contact.id,
      chatId: chat.id
    }, 'dashboard_outgoing');

    // Emit via Socket.IO
    io.emit('new_message', {
      from: 'me',
      to,
      message: content,
      mediaUrl: media_url,
      timestamp: new Date(),
      messageId: whatsapp_message_id,
      source: 'dashboard',
      n8nForwarded: true
    });

    console.log("📤 Outgoing message saved and forwarded:", content);
    return true;
  } catch (err) {
    console.error("❌ processOutgoingMessage error:", err);
    return false;
  }
}

module.exports = {
  processIncomingMessage,
  processOutgoingMessage
};
