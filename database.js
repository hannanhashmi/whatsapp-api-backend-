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

    // Messages table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id SERIAL PRIMARY KEY,
        chat_id INTEGER REFERENCES chats(id) ON DELETE CASCADE,
        contact_id INTEGER REFERENCES contacts(id) ON DELETE CASCADE,
        message_type VARCHAR(10) NOT NULL CHECK (message_type IN ('received', 'sent')),
        content TEXT NOT NULL,
        media_url TEXT,
        media_type VARCHAR(50),
        media_caption TEXT,
        whatsapp_message_id VARCHAR(100),
        status VARCHAR(20) DEFAULT 'sent' CHECK (status IN ('sent', 'delivered', 'read', 'failed')),
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Indexes
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_contacts_phone ON contacts(phone_number);
      CREATE INDEX IF NOT EXISTS idx_chats_phone ON chats(phone_number);
      CREATE INDEX IF NOT EXISTS idx_chats_last_message ON chats(last_message_at DESC);
      CREATE INDEX IF NOT EXISTS idx_messages_chat_id ON messages(chat_id);
      CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp DESC);
    `);

    console.log('✅ Database tables created/verified (Media fields added)');
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
      
      // Save file path - adjust according to your storage system
      const filePath = `uploads/media/${type}s/${uniqueFileName}`;
      
      // Save to database
      const result = await query(
        `INSERT INTO media_files 
         (whatsapp_message_id, file_type, mime_type, file_path, file_name, original_name)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [whatsappMessageId, type, mimeType, filePath, uniqueFileName, fileName]
      );
      
      // Save file to disk (if using filesystem)
      // await this.saveFileToDisk(filePath, data);
      
      return {
        ...result.rows[0],
        url: `/api/media/${result.rows[0].id}` // Generate accessible URL
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
      'audio/ogg': 'ogg',
      'audio/mpeg': 'mp3',
      'audio/aac': 'aac',
      'video/mp4': 'mp4',
      'application/pdf': 'pdf',
      'text/plain': 'txt'
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
        fileName: mediaData.file_name,
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
  }
};

module.exports = {
  pool,
  initializeDatabase,
  query: (text, params) => pool.query(text, params)
};

