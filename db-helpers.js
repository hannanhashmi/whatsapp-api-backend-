const { query } = require('./database');

// Contact functions
const ContactDB = {
  // Find or create contact
  async findOrCreateContact(phoneNumber, name = null) {
    try {
      // Try to find existing contact
      const result = await query(
        'SELECT * FROM contacts WHERE phone_number = $1',
        [phoneNumber]
      );
      
      if (result.rows.length > 0) {
        // Update last message time and increment count
        await query(
          `UPDATE contacts 
           SET last_message_at = CURRENT_TIMESTAMP,
               message_count = message_count + 1,
               updated_at = CURRENT_TIMESTAMP
           WHERE phone_number = $1`,
          [phoneNumber]
        );
        return result.rows[0];
      }
      
      // Create new contact
      const newContact = await query(
        `INSERT INTO contacts 
         (phone_number, name, last_message_at, message_count) 
         VALUES ($1, $2, CURRENT_TIMESTAMP, 1)
         RETURNING *`,
        [phoneNumber, name || `+${phoneNumber}`]
      );
      
      return newContact.rows[0];
    } catch (error) {
      console.error('Contact find/create error:', error);
      throw error;
    }
  },

  // Get all contacts
  async getAllContacts(limit = 100) {
    const result = await query(
      `SELECT * FROM contacts 
       ORDER BY last_message_at DESC NULLS LAST, created_at DESC 
       LIMIT $1`,
      [limit]
    );
    return result.rows;
  },

  // Update contact
  async updateContact(id, updates) {
    const fields = [];
    const values = [];
    let paramCount = 1;

    Object.keys(updates).forEach(key => {
      if (updates[key] !== undefined) {
        fields.push(`${key} = $${paramCount}`);
        values.push(updates[key]);
        paramCount++;
      }
    });

    if (fields.length === 0) return null;

    fields.push('updated_at = CURRENT_TIMESTAMP');
    values.push(id);

    const queryStr = `
      UPDATE contacts 
      SET ${fields.join(', ')} 
      WHERE id = $${paramCount} 
      RETURNING *
    `;

    const result = await query(queryStr, values);
    return result.rows[0];
  }
};

// Chat functions
const ChatDB = {
  // Find or create chat
  async findOrCreateChat(contactId, phoneNumber) {
    try {
      const result = await query(
        'SELECT * FROM chats WHERE phone_number = $1',
        [phoneNumber]
      );
      
      if (result.rows.length > 0) {
        return result.rows[0];
      }
      
      // Create new chat
      const newChat = await query(
        `INSERT INTO chats 
         (contact_id, phone_number, unread_count, last_message_at) 
         VALUES ($1, $2, 0, CURRENT_TIMESTAMP)
         RETURNING *`,
        [contactId, phoneNumber]
      );
      
      return newChat.rows[0];
    } catch (error) {
      console.error('Chat find/create error:', error);
      throw error;
    }
  },

  // Add message to chat
  async addMessage(chatId, contactId, messageData) {
    try {
      // Insert message
      const messageResult = await query(
        `INSERT INTO messages 
         (chat_id, contact_id, message_type, content, whatsapp_message_id, status, timestamp)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [
          chatId,
          contactId,
          messageData.type,
          messageData.content,
          messageData.whatsappMessageId,
          messageData.status || 'delivered',
          messageData.timestamp || new Date()
        ]
      );

      // Update chat metadata
      await query(
        `UPDATE chats 
         SET last_message = $1,
             last_message_at = $2,
             unread_count = unread_count + $3,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $4`,
        [
          messageData.content.substring(0, 200),
          messageData.timestamp || new Date(),
          messageData.type === 'received' ? 1 : 0,
          chatId
        ]
      );

      return messageResult.rows[0];
    } catch (error) {
      console.error('Add message error:', error);
      throw error;
    }
  },

  // Get all chats with last message
  async getAllChats(limit = 100) {
    const result = await query(
      `SELECT 
         c.*,
         ct.name as contact_name,
         ct.status as contact_status,
         ct.email as contact_email,
         (SELECT COUNT(*) FROM messages m WHERE m.chat_id = c.id) as total_messages
       FROM chats c
       LEFT JOIN contacts ct ON c.contact_id = ct.id
       WHERE c.is_active = TRUE
       ORDER BY c.last_message_at DESC NULLS LAST
       LIMIT $1`,
      [limit]
    );
    return result.rows;
  },

  // Get chat messages
  async getChatMessages(phoneNumber, limit = 200) {
    const result = await query(
      `SELECT 
         m.*,
         c.name as contact_name
       FROM messages m
       LEFT JOIN contacts c ON m.contact_id = c.id
       WHERE m.chat_id = (SELECT id FROM chats WHERE phone_number = $1)
       ORDER BY m.timestamp ASC
       LIMIT $2`,
      [phoneNumber, limit]
    );
    return result.rows;
  },

  // Mark chat as read
  async markAsRead(phoneNumber) {
    await query(
      `UPDATE chats 
       SET unread_count = 0,
           updated_at = CURRENT_TIMESTAMP
       WHERE phone_number = $1`,
      [phoneNumber]
    );
  }
};

module.exports = {
  ContactDB,
  ChatDB,
  query
};
