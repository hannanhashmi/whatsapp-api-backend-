const { Pool } = require('pg');
require('dotenv').config();

// PostgreSQL connection pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

// Test database connection
pool.on('connect', () => {
  console.log('🔗 Connected to PostgreSQL database');
});

pool.on('error', (err) => {
  console.error('❌ PostgreSQL pool error:', err);
});

// Create tables if not exists
async function initializeDatabase() {
  try {
    // Contacts table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS contacts (
        id SERIAL PRIMARY KEY,
        phone_number VARCHAR(20) UNIQUE NOT NULL,
        name VARCHAR(100),
        email VARCHAR(100),
        tags TEXT[] DEFAULT '{}',
        notes TEXT,
        assigned_to VARCHAR(50),
        status VARCHAR(20) DEFAULT 'new',
        last_message_at TIMESTAMP,
        message_count INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Chats table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS chats (
        id SERIAL PRIMARY KEY,
        contact_id INTEGER REFERENCES contacts(id) ON DELETE CASCADE,
        phone_number VARCHAR(20) NOT NULL,
        unread_count INTEGER DEFAULT 0,
        last_message TEXT,
        last_message_at TIMESTAMP,
        is_active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(phone_number)
      )
    `);

    // Messages table with media support
    await pool.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id SERIAL PRIMARY KEY,
        chat_id INTEGER REFERENCES chats(id) ON DELETE CASCADE,
        contact_id INTEGER REFERENCES contacts(id) ON DELETE CASCADE,
        message_type VARCHAR(10) NOT NULL CHECK (message_type IN ('received', 'sent')),
        content TEXT,
        media_url TEXT,
        media_type VARCHAR(50),
        media_caption TEXT,
        media_info JSONB,
        message_type_detail VARCHAR(50),
        whatsapp_message_id VARCHAR(100),
        status VARCHAR(20) DEFAULT 'sent' CHECK (status IN ('sent', 'delivered', 'read', 'failed')),
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Media files table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS media_files (
        id SERIAL PRIMARY KEY,
        whatsapp_message_id VARCHAR(255),
        file_type VARCHAR(50),
        mime_type VARCHAR(100),
        file_path TEXT,
        file_name VARCHAR(255),
        original_name VARCHAR(255),
        file_size BIGINT,
        url TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Indexes
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_contacts_phone ON contacts(phone_number);
      CREATE INDEX IF NOT EXISTS idx_chats_phone ON chats(phone_number);
      CREATE INDEX IF NOT EXISTS idx_chats_last_message ON chats(last_message_at DESC);
      CREATE INDEX IF NOT EXISTS idx_messages_chat_id ON messages(chat_id);
      CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_messages_media_type ON messages(media_type);
      CREATE INDEX IF NOT EXISTS idx_media_files_message_id ON media_files(whatsapp_message_id);
    `);

    console.log('✅ Database tables created/verified (Media support added)');
  } catch (error) {
    console.error('❌ Database initialization error:', error);
  }
}

// Media Processing Functions
const MediaDB = {
  // Save media file to server/database
  async saveMediaFile(mediaData) {
    try {
      const { 
        type, 
        mimeType, 
        data, 
        fileName,
        whatsappMessageId 
      } = mediaData;
      
      // Generate unique filename
      const fileExtension = this.getFileExtension(mimeType);
      const uniqueFileName = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}.${fileExtension}`;
      
      // Save file path
      const filePath = `uploads/media/${type}s/${uniqueFileName}`;
      
      // Save to database
      const result = await pool.query(
        `INSERT INTO media_files 
         (whatsapp_message_id, file_type, mime_type, file_path, file_name, original_name)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [whatsappMessageId, type, mimeType, filePath, uniqueFileName, fileName || `media_${Date.now()}`]
      );
      
      return {
        ...result.rows[0],
        url: `/api/media/${result.rows[0].id}`
      };
    } catch (error) {
      console.error('Save media error:', error);
      throw error;
    }
  },

  // Get file extension from mime type
  getFileExtension(mimeType) {
    const mimeToExt = {
      'image/jpeg': 'jpg',
      'image/png': 'png',
      'image/gif': 'gif',
      'image/webp': 'webp',
      'audio/ogg': 'ogg',
      'audio/mpeg': 'mp3',
      'audio/aac': 'aac',
      'audio/mp4': 'm4a',
      'audio/opus': 'opus',
      'video/mp4': 'mp4',
      'video/3gpp': '3gp',
      'application/pdf': 'pdf',
      'text/plain': 'txt',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
      'application/msword': 'doc'
    };
    
    return mimeToExt[mimeType] || 'bin';
  },

  // Process WhatsApp media message
  async processWhatsAppMedia(mediaData) {
    const mediaInfo = {
      type: mediaData.type,
      mimeType: mediaData.mime_type,
      fileSize: mediaData.file_size,
      caption: mediaData.caption
    };

    // If we have file data, save it
    if (mediaData.data || mediaData.url) {
      const savedMedia = await this.saveMediaFile({
        type: mediaData.type,
        mimeType: mediaData.mime_type,
        data: mediaData.data,
        fileName: mediaData.file_name || `media_${Date.now()}`,
        whatsappMessageId: mediaData.whatsapp_message_id
      });
      
      mediaInfo.fileId = savedMedia.id;
      mediaInfo.url = savedMedia.url;
      mediaInfo.filePath = savedMedia.file_path;
    } else if (mediaData.url) {
      // If it's already a URL
      mediaInfo.url = mediaData.url;
    }

    return mediaInfo;
  },

  // Get media by message ID
  async getMediaByMessageId(whatsappMessageId) {
    const result = await pool.query(
      'SELECT * FROM media_files WHERE whatsapp_message_id = $1',
      [whatsappMessageId]
    );
    return result.rows[0];
  },

  // Delete media file
  async deleteMediaFile(id) {
    await pool.query('DELETE FROM media_files WHERE id = $1', [id]);
  }
};

// Contact functions
const ContactDB = {
  // Find or create contact
  async findOrCreateContact(phoneNumber, name = null) {
    try {
      // Try to find existing contact
      const result = await pool.query(
        'SELECT * FROM contacts WHERE phone_number = $1',
        [phoneNumber]
      );
      
      if (result.rows.length > 0) {
        // Update last message time and increment count
        await pool.query(
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
      const newContact = await pool.query(
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
    const result = await pool.query(
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

    const result = await pool.query(queryStr, values);
    return result.rows[0];
  }
};

// Chat functions
const ChatDB = {
  // Find or create chat
  async findOrCreateChat(contactId, phoneNumber) {
    try {
      const result = await pool.query(
        'SELECT * FROM chats WHERE phone_number = $1',
        [phoneNumber]
      );
      
      if (result.rows.length > 0) {
        return result.rows[0];
      }
      
      // Create new chat
      const newChat = await pool.query(
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

  // Add message to chat with media support
  async addMessage(chatId, contactId, messageData) {
    try {
      // Prepare content for last_message field
      let lastMessageContent = null;
      
      if (messageData.content) {
        lastMessageContent = messageData.content.substring(0, 200);
      } else if (messageData.mediaInfo) {
        // Show media indicator in last message preview
        switch(messageData.mediaInfo.type) {
          case 'image':
            lastMessageContent = '🖼️ Image';
            break;
          case 'audio':
            lastMessageContent = '🎵 Audio Message';
            break;
          case 'video':
            lastMessageContent = '🎬 Video';
            break;
          case 'document':
            lastMessageContent = '📄 Document';
            break;
          default:
            lastMessageContent = '📁 Media';
        }
        
        if (messageData.mediaInfo.caption) {
          lastMessageContent += `: ${messageData.mediaInfo.caption.substring(0, 100)}`;
        }
      }

      // Insert message with media info
      const messageResult = await pool.query(
        `INSERT INTO messages 
         (chat_id, contact_id, message_type, content, whatsapp_message_id, 
          status, timestamp, message_type_detail, media_info, media_type)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING *`,
        [
          chatId,
          contactId,
          messageData.type,
          messageData.content,
          messageData.whatsappMessageId,
          messageData.status || 'delivered',
          messageData.timestamp || new Date(),
          messageData.messageTypeDetail || null,
          messageData.mediaInfo ? JSON.stringify(messageData.mediaInfo) : null,
          messageData.mediaInfo?.type || null
        ]
      );

      // Update chat metadata
      await pool.query(
        `UPDATE chats 
         SET last_message = $1,
             last_message_at = $2,
             unread_count = unread_count + $3,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $4`,
        [
          lastMessageContent,
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
    const result = await pool.query(
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

  // Get chat messages with formatted media
  async getChatMessages(phoneNumber, limit = 200) {
    const result = await pool.query(
      `SELECT 
         m.*,
         c.name as contact_name,
         mf.file_path as media_file_path,
         mf.mime_type as media_mime_type,
         mf.url as media_url
       FROM messages m
       LEFT JOIN contacts c ON m.contact_id = c.id
       LEFT JOIN media_files mf ON m.whatsapp_message_id = mf.whatsapp_message_id
       WHERE m.chat_id = (SELECT id FROM chats WHERE phone_number = $1)
       ORDER BY m.timestamp ASC
       LIMIT $2`,
      [phoneNumber, limit]
    );

    // Format messages for frontend
    const formattedMessages = result.rows.map(msg => {
      const message = {
        id: msg.id,
        chat_id: msg.chat_id,
        contact_id: msg.contact_id,
        message_type: msg.message_type,
        content: msg.content,
        whatsapp_message_id: msg.whatsapp_message_id,
        status: msg.status,
        timestamp: msg.timestamp,
        contact_name: msg.contact_name
      };

      // If it's a media message
      if (msg.media_type || msg.media_info) {
        let mediaInfo = msg.media_info;
        if (typeof mediaInfo === 'string') {
          mediaInfo = JSON.parse(mediaInfo);
        }
        
        message.media = {
          type: msg.media_type || mediaInfo?.type,
          mimeType: msg.media_mime_type || mediaInfo?.mimeType,
          url: msg.media_url || mediaInfo?.url,
          filePath: msg.media_file_path || mediaInfo?.filePath,
          caption: mediaInfo?.caption,
          fileSize: mediaInfo?.fileSize
        };

        // Format display text for media messages
        if (!message.content && message.media) {
          switch(message.media.type) {
            case 'image':
              message.displayText = `🖼️ Image (${message.media.mimeType || 'image'})`;
              break;
            case 'audio':
              message.displayText = `🎵 Audio Message (${message.media.mimeType || 'audio'})`;
              break;
            case 'video':
              message.displayText = `🎬 Video (${message.media.mimeType || 'video'})`;
              break;
            default:
              message.displayText = `📁 ${message.media.type || 'Media'}`;
          }
        }
      }

      return message;
    });

    return formattedMessages;
  },

  // Mark chat as read
  async markAsRead(phoneNumber) {
    await pool.query(
      `UPDATE chats 
       SET unread_count = 0,
           updated_at = CURRENT_TIMESTAMP
       WHERE phone_number = $1`,
      [phoneNumber]
    );
  }
};

module.exports = {
  pool,
  initializeDatabase,
  MediaDB,
  ContactDB,
  ChatDB,
  query: (text, params) => pool.query(text, params)
};
