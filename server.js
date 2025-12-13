// Required imports
const { Pool } = require('pg');
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios'); // ✅ axios already included
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const app = express();
const server = http.createServer(app);

// PostgreSQL Connection Pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

// ==================== MIDDLEWARE ====================

// CORS Configuration
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// N8N Webhook URL - आपका URL
const N8N_WEBHOOK_URL = "https://xibado3.app.n8n.cloud/webhook/whatsapp";

// API Key Middleware for n8n
const verifyN8nApiKey = (req, res, next) => {
  // Skip for public endpoints
  const publicPaths = ['/', '/ping', '/health', '/webhook', '/api/chats', '/api/send'];
  if (publicPaths.includes(req.path)) {
    return next();
  }
  
  // For n8n endpoints
  if (req.path.startsWith('/api/n8n')) {
    const apiKey = req.headers['authorization']?.replace('Bearer ', '');
    const secretKey = req.headers['x-n8n-secret'];
    
    const validApiKey = apiKey === process.env.N8N_API_KEY;
    const validSecret = secretKey === process.env.N8N_SECRET;
    
    if (validApiKey || validSecret) {
      return next();
    }
    
    console.log('❌ Invalid n8n API key attempt');
    return res.status(401).json({ 
      success: false, 
      error: 'Invalid API credentials' 
    });
  }
  
  next();
};

app.use(verifyN8nApiKey);

// ==================== MEDIA DOWNLOAD HELPERS ====================

// Get file extension from mime type
function getFileExtension(mimeType, filename = '') {
  const mimeToExt = {
    'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
    'audio/ogg': 'ogg', 'audio/opus': 'opus', 'audio/mpeg': 'mp3',
    'audio/aac': 'aac', 'video/mp4': 'mp4', 'application/pdf': 'pdf',
    'text/plain': 'txt', 'application/msword': 'doc',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
    'application/vnd.ms-excel': 'xls'
  };
  
  // First try to get extension from filename
  if (filename) {
    const ext = filename.split('.').pop();
    if (ext && ext.length <= 5) return ext.toLowerCase();
  }
  
  // Fallback to mime type mapping
  return mimeToExt[mimeType] || 'bin';
}

// Download media file from WhatsApp API
// Download media file from WhatsApp API - CORRECT VERSION
async function downloadWhatsAppMedia(mediaId) {
  try {
    console.log(`🔗 Getting media URL for ID: ${mediaId}`);
    
    // WhatsApp Business API URL format
    const response = await axios.get(
      `https://graph.facebook.com/v18.0/${mediaId}`,  // यह सही है
      {
        headers: {
          'Authorization': `Bearer ${process.env.WHATSAPP_TOKEN || process.env.ACCESS_TOKEN}`,
          'Content-Type': 'application/json'
        },
        timeout: 10000
      }
    );
    
    // Response में ये structure आता है:
    // {
    //   "url": "https://lookaside.fbsbx.com/whatsapp_business/...",
    //   "mime_type": "image/jpeg",
    //   "sha256": "...",
    //   "file_size": 123456,
    //   "id": "..."
    // }
    
    if (response.data && response.data.url) {
      console.log(`✅ Got media URL: ${response.data.url.substring(0, 50)}...`);
      return response.data.url;
    } else {
      console.log('⚠️ Media URL not found in response:', response.data);
      return null;
    }
    
  } catch (error) {
    console.error('❌ Failed to get media URL:', {
      status: error.response?.status,
      data: error.response?.data,
      message: error.message,
      mediaId: mediaId
    });
    return null;
  }
}
// Save media to local server
async function saveMediaToServer(downloadUrl, fileType, fileName, mediaId) {
  try {
    if (!downloadUrl) {
      console.error('❌ No download URL provided');
      return null;
    }
    
    console.log(`📥 Downloading media from: ${downloadUrl.substring(0, 60)}...`);
    
    // Download the file
    const response = await axios.get(downloadUrl, {
      responseType: 'arraybuffer',
      headers: {
        'Authorization': `Bearer ${process.env.ACCESS_TOKEN}`
      },
      timeout: 30000 // 30 second timeout for large files
    });
    
    // Create uploads directory if not exists
    const uploadDir = path.join(__dirname, 'uploads', 'media');
    
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
      console.log(`📁 Created directory: ${uploadDir}`);
    }
    
    // Generate filename
    const timestamp = Date.now();
    const contentType = response.headers['content-type'] || 'application/octet-stream';
    const ext = getFileExtension(contentType, fileName);
    const safeMediaId = mediaId.replace(/[^a-zA-Z0-9]/g, '_');
    const savedFileName = `${timestamp}_${safeMediaId}.${ext}`;
    const filePath = path.join(uploadDir, savedFileName);
    
    // Save file
    fs.writeFileSync(filePath, Buffer.from(response.data));
    
    // Create accessible URL
    const fileUrl = `/api/media/${savedFileName}`;
    
    console.log(`💾 Media saved: ${filePath} (${response.data.length} bytes)`);
    
    return {
      filePath: filePath,
      url: fileUrl,
      fileName: savedFileName,
      size: response.data.length,
      contentType: contentType
    };
    
  } catch (error) {
    console.error('❌ Failed to save media:', error.message);
    return null;
  }
}

// Initialize Database Tables
async function initializeDatabase() {
  try {
    console.log('📊 Initializing PostgreSQL database...');
    
    // Create contacts table
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

    // Create chats table
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

    // Create messages table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id SERIAL PRIMARY KEY,
        chat_id INTEGER REFERENCES chats(id) ON DELETE CASCADE,
        contact_id INTEGER REFERENCES contacts(id) ON DELETE CASCADE,
        message_type VARCHAR(10) NOT NULL CHECK (message_type IN ('received', 'sent')),
        content TEXT NOT NULL,
        whatsapp_message_id VARCHAR(100),
        status VARCHAR(20) DEFAULT 'sent' CHECK (status IN ('sent', 'delivered', 'read', 'failed')),
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create indexes
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_contacts_phone ON contacts(phone_number);
      CREATE INDEX IF NOT EXISTS idx_chats_phone ON chats(phone_number);
      CREATE INDEX IF NOT EXISTS idx_chats_last_message ON chats(last_message_at DESC);
      CREATE INDEX IF NOT EXISTS idx_messages_chat_id ON messages(chat_id);
      CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp DESC);
    `);

    console.log('✅ Database tables created/verified successfully');
  } catch (error) {
    console.error('❌ Database initialization error:', error);
    throw error;
  }
}

// Database Helper Functions
const dbHelpers = {
  // Contact Functions
  async findOrCreateContact(phoneNumber, name = null) {
    try {
      // Try to find existing contact
      const findResult = await pool.query(
        'SELECT * FROM contacts WHERE phone_number = $1',
        [phoneNumber]
      );
      
      if (findResult.rows.length > 0) {
        // Update existing contact
        await pool.query(
          `UPDATE contacts 
           SET last_message_at = CURRENT_TIMESTAMP,
               message_count = message_count + 1,
               updated_at = CURRENT_TIMESTAMP
           WHERE phone_number = $1`,
          [phoneNumber]
        );
        return findResult.rows[0];
      }
      
      // Create new contact
      const createResult = await pool.query(
        `INSERT INTO contacts 
         (phone_number, name, last_message_at, message_count) 
         VALUES ($1, $2, CURRENT_TIMESTAMP, 1)
         RETURNING *`,
        [phoneNumber, name || `+${phoneNumber}`]
      );
      
      return createResult.rows[0];
    } catch (error) {
      console.error('Contact find/create error:', error);
      throw error;
    }
  },

  // Chat Functions
  async findOrCreateChat(contactId, phoneNumber) {
    try {
      const findResult = await pool.query(
        'SELECT * FROM chats WHERE phone_number = $1',
        [phoneNumber]
      );
      
      if (findResult.rows.length > 0) {
        return findResult.rows[0];
      }
      
      // Create new chat
      const createResult = await pool.query(
        `INSERT INTO chats 
         (contact_id, phone_number, unread_count, last_message_at) 
         VALUES ($1, $2, 0, CURRENT_TIMESTAMP)
         RETURNING *`,
        [contactId, phoneNumber]
      );
      
      return createResult.rows[0];
    } catch (error) {
      console.error('Chat find/create error:', error);
      throw error;
    }
  },

  // Message Functions
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

  // Get all chats
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

  // Get chat messages
  async getChatMessages(phoneNumber, limit = 200) {
    const result = await pool.query(
      `SELECT 
         m.*,
         ct.name as contact_name
       FROM messages m
       LEFT JOIN contacts ct ON m.contact_id = ct.id
       WHERE m.chat_id = (SELECT id FROM chats WHERE phone_number = $1)
       ORDER BY m.timestamp ASC
       LIMIT $2`,
      [phoneNumber, limit]
    );
    return result.rows;
  },

  // Mark chat as read
  async markChatAsRead(phoneNumber) {
    await pool.query(
      `UPDATE chats 
       SET unread_count = 0,
           updated_at = CURRENT_TIMESTAMP
       WHERE phone_number = $1`,
      [phoneNumber]
    );
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

// Socket.IO Configuration
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
    credentials: true
  },
  transports: ['websocket', 'polling']
});

// Store chats in memory (for backward compatibility)
let chats = {};
const MAX_CHATS = 100;
const MAX_MESSAGES_PER_CHAT = 200;

// Cleanup function (for memory chats)
function cleanupOldData() {
  const chatNumbers = Object.keys(chats);
  if (chatNumbers.length > MAX_CHATS) {
    const sorted = chatNumbers.sort((a, b) => 
      new Date(chats[b].lastMessage) - new Date(chats[a].lastMessage)
    );
    sorted.slice(MAX_CHATS).forEach(num => delete chats[num]);
  }
  
  Object.values(chats).forEach(chat => {
    if (chat.messages.length > MAX_MESSAGES_PER_CHAT) {
      chat.messages = chat.messages.slice(-MAX_MESSAGES_PER_CHAT);
    }
  });
}

// ==================== N8N INTEGRATION FUNCTION ====================

// Function to forward message to n8n
async function forwardToN8N(messageData, source) {
  try {
    console.log(`🔄 Forwarding to n8n (${source}): ${N8N_WEBHOOK_URL}`);
    
    // n8n को आसान format में भेजें
    const n8nPayload = {
      // Basic message info
      from: messageData.phone,
      message: messageData.content,
      timestamp: messageData.timestamp || new Date().toISOString(),
      contactName: messageData.contactName || `+${messageData.phone}`,
      messageId: messageData.messageId || `msg-${Date.now()}`,
      
      // Source information
      source: source, // 'whatsapp_incoming' or 'dashboard_outgoing'
      direction: messageData.type === 'received' ? 'incoming' : 'outgoing',
      
      // Database IDs (if available)
      contactId: messageData.contactId,
      chatId: messageData.chatId,
      
      // Additional metadata
      platform: 'whatsapp',
      serverTime: new Date().toISOString()
    };
    
    // Add full Meta payload for WhatsApp messages
    if (source === 'whatsapp_incoming' && messageData.metaPayload) {
      n8nPayload.metaData = messageData.metaPayload;
    }
    
    const response = await axios.post(N8N_WEBHOOK_URL, n8nPayload, {
      headers: { 
        'Content-Type': 'application/json',
        'X-Source': 'whatsapp-backend',
        'X-Forwarded-Time': new Date().toISOString()
      },
      timeout: 8000 // 8 second timeout
    });
    
    console.log(`✅ Successfully forwarded to n8n. Status: ${response.status}`);
    return { success: true, response: response.data };
    
  } catch (error) {
    console.error(`❌ Failed to forward to n8n (${source}):`, error.message);
    
    // Don't crash the main flow if n8n fails
    return { 
      success: false, 
      error: error.message,
      timestamp: new Date().toISOString()
    };
  }
}

// ==================== WEBHOOK ENDPOINTS ====================

// Webhook verification
app.get('/webhook', (req, res) => {
  const verify_token = process.env.VERIFY_TOKEN;
  
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token) {
    if (mode === 'subscribe' && token === verify_token) {
      console.log('✅ Webhook verified successfully');
      res.status(200).send(challenge);
    } else {
      console.log('❌ Webhook verification failed');
      res.sendStatus(403);
    }
  } else {
    res.sendStatus(400);
  }
});

// Receive messages from WhatsApp
app.post('/webhook', async (req, res) => {
  console.log('📩 Received webhook from WhatsApp');
  
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
});

// Helper function to format file sizes
function formatBytes(bytes, decimals = 2) {
  if (!bytes || bytes === 0) return '0 Bytes';
  
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

// Helper function to get document type from mime type
function getDocumentType(mimeType) {
  const mimeMap = {
    'application/pdf': 'PDF Document',
    'application/msword': 'Word Document',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'Word Document',
    'application/vnd.ms-excel': 'Excel Spreadsheet',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'Excel Spreadsheet',
    'application/vnd.ms-powerpoint': 'PowerPoint Presentation',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'PowerPoint Presentation',
    'text/plain': 'Text File',
    'text/html': 'HTML File',
    'text/csv': 'CSV File',
    'application/zip': 'ZIP Archive',
    'application/x-rar-compressed': 'RAR Archive',
    'application/json': 'JSON File',
    'application/xml': 'XML File'
  };
  
  return mimeMap[mimeType] || 'Document';
}

// Process incoming WhatsApp message - UPDATED WITH MEDIA DOWNLOAD
async function processIncomingMessage(message, metaPayload = null) {
  const phone = message.from;
  const timestamp = new Date(message.timestamp * 1000);
  
  console.log(`💬 Processing WhatsApp message from ${phone}, type: ${message.type}`);
  
  try {
    // **Step 1: Differentiate ALL message types**
    let content = '';
    let mediaInfo = null;
    let messageTypeDetail = message.type;
    
    // Text Message
    if (message.type === 'text') {
      content = message.text?.body || '[Text Message]';
    } 
    // Audio/Voice Message
    else if (message.type === 'audio' || message.type === 'voice') {
      const audio = message.audio || message.voice;
      if (audio) {
        content = `🎵 Audio Message (${audio.mime_type || 'audio/ogg'}, ${formatBytes(audio.file_size)})`;
        mediaInfo = {
          type: 'audio',
          mime_type: audio.mime_type || 'audio/ogg',
          file_size: audio.file_size,
          id: audio.id,
          duration: audio.duration || 'unknown',
          sha256: audio.sha256,
          voice_message: (message.type === 'voice')
        };
        
        // ✅ MEDIA DOWNLOAD FOR AUDIO
        if (audio.id) {
          console.log(`🎵 Attempting to download audio: ${audio.id}`);
          
          try {
            // 1. Get download URL
            const downloadUrl = await downloadWhatsAppMedia(audio.id);
            
            if (downloadUrl) {
              // 2. Save to server
              const savedFile = await saveMediaToServer(
                downloadUrl,
                'audio',
                `whatsapp_audio_${audio.id}`,
                audio.id
              );
              
              if (savedFile) {
                // 3. Update mediaInfo with local file info
                mediaInfo.downloaded = true;
                mediaInfo.localUrl = savedFile.url;
                mediaInfo.localPath = savedFile.filePath;
                mediaInfo.actualFileSize = savedFile.size;
                mediaInfo.contentType = savedFile.contentType;
                
                // Update content to show actual size
                content = `🎵 Audio Message (${formatBytes(savedFile.size)})`;
                
                console.log(`✅ Audio saved locally: ${savedFile.filePath}`);
              }
            }
          } catch (downloadError) {
            console.error('❌ Audio download failed:', downloadError.message);
          }
        }
      } else {
        content = '🎵 Audio Message';
      }
    }
    // Image Message
    else if (message.type === 'image') {
      const image = message.image;
      if (image) {
        const captionText = image.caption ? ` - ${image.caption}` : '';
        content = `🖼️ Image${captionText} (${image.mime_type || 'image/jpeg'}, ${formatBytes(image.file_size)})`;
        mediaInfo = {
          type: 'image',
          mime_type: image.mime_type || 'image/jpeg',
          file_size: image.file_size,
          id: image.id,
          caption: image.caption || '',
          sha256: image.sha256,
          width: image.width,
          height: image.height
        };
        
        // ✅ MEDIA DOWNLOAD FOR IMAGE
        if (image.id) {
          console.log(`📸 Attempting to download image: ${image.id}`);
          
          try {
            // 1. Get download URL
            const downloadUrl = await downloadWhatsAppMedia(image.id);
            
            if (downloadUrl) {
              // 2. Save to server
              const savedFile = await saveMediaToServer(
                downloadUrl,
                'image',
                `whatsapp_image_${image.id}`,
                image.id
              );
              
              if (savedFile) {
                // 3. Update mediaInfo with local file info
                mediaInfo.downloaded = true;
                mediaInfo.localUrl = savedFile.url;
                mediaInfo.localPath = savedFile.filePath;
                mediaInfo.actualFileSize = savedFile.size;
                mediaInfo.contentType = savedFile.contentType;
                
                // Update content to show actual size
                content = `🖼️ Image${captionText} (${formatBytes(savedFile.size)})`;
                
                console.log(`✅ Image saved locally: ${savedFile.filePath}`);
              }
            }
          } catch (downloadError) {
            console.error('❌ Image download failed:', downloadError.message);
          }
        }
      } else {
        content = '🖼️ Image';
      }
    }
    // Document Message (PDF, Excel, Word, HTML, etc.)
    else if (message.type === 'document') {
      const document = message.document;
      if (document) {
        const filename = document.filename || getDocumentType(document.mime_type);
        const captionText = document.caption ? ` - ${document.caption}` : '';
        content = `📄 ${filename}${captionText} (${document.mime_type}, ${formatBytes(document.file_size)})`;
        mediaInfo = {
          type: 'document',
          mime_type: document.mime_type,
          file_size: document.file_size,
          id: document.id,
          filename: document.filename || '',
          caption: document.caption || '',
          sha256: document.sha256,
          document_type: getFileExtension(document.mime_type, document.filename)
        };
      } else {
        content = '📄 Document';
      }
    }
    // Video Message
    else if (message.type === 'video') {
      const video = message.video;
      if (video) {
        const captionText = video.caption ? ` - ${video.caption}` : '';
        content = `🎬 Video${captionText} (${video.mime_type || 'video/mp4'}, ${formatBytes(video.file_size)})`;
        mediaInfo = {
          type: 'video',
          mime_type: video.mime_type || 'video/mp4',
          file_size: video.file_size,
          id: video.id,
          caption: video.caption || '',
          duration: video.duration || 'unknown',
          sha256: video.sha256
        };
      } else {
        content = '🎬 Video';
      }
    }
    // Sticker
    else if (message.type === 'sticker') {
      content = '😀 Sticker';
      mediaInfo = {
        type: 'sticker'
      };
    }
    // Location
    else if (message.type === 'location') {
      const location = message.location;
      if (location) {
        content = `📍 Location: ${location.name || 'Shared Location'} (${location.latitude}, ${location.longitude})`;
        mediaInfo = {
          type: 'location',
          latitude: location.latitude,
          longitude: location.longitude,
          name: location.name || '',
          address: location.address || ''
        };
      } else {
        content = '📍 Location';
      }
    }
    // Contact
    else if (message.type === 'contacts') {
      content = '👤 Contact Shared';
      mediaInfo = {
        type: 'contact',
        contacts: message.contacts || []
      };
    }
    // Interactive Messages (Buttons, Lists)
    else if (message.type === 'interactive') {
      const interactive = message.interactive;
      if (interactive) {
        if (interactive.type === 'button_reply') {
          content = `🔘 Button: ${interactive.button_reply?.title || 'Button Clicked'}`;
        } else if (interactive.type === 'list_reply') {
          content = `📋 List Selection: ${interactive.list_reply?.title || 'List Item Selected'}`;
        } else {
          content = '🔄 Interactive Message';
        }
        mediaInfo = {
          type: 'interactive',
          interactive_type: interactive.type,
          data: interactive
        };
      } else {
        content = '🔄 Interactive';
      }
    }
    // Reaction
    else if (message.type === 'reaction') {
      const reaction = message.reaction;
      if (reaction) {
        content = `${reaction.emoji} Reaction to message ${reaction.message_id}`;
        mediaInfo = {
          type: 'reaction',
          emoji: reaction.emoji,
          message_id: reaction.message_id
        };
      } else {
        content = '👍 Reaction';
      }
    }
    // Unknown/Other message types
    else {
      content = `[${message.type.toUpperCase()} Message]`;
      mediaInfo = {
        type: message.type,
        raw_data: message
      };
    }
    
    // **Step 2: Save to PostgreSQL database**
    const contact = await dbHelpers.findOrCreateContact(phone);
    const chat = await dbHelpers.findOrCreateChat(contact.id, phone);
    
    // Prepare message data with media info
    const messageData = {
      type: 'received',
      content: content,
      whatsappMessageId: message.id,
      timestamp: timestamp,
      status: 'delivered',
      messageTypeDetail: messageTypeDetail
    };
    
    // If media exists, store additional info
    if (mediaInfo) {
      messageData.mediaInfo = mediaInfo;
    }
    
    const savedMessage = await dbHelpers.addMessage(chat.id, contact.id, messageData);

    // **Step 3: Forward to n8n with complete media info**
    const n8nForwardResult = await forwardToN8N({
      phone: phone,
      content: content,
      timestamp: timestamp,
      contactName: contact.name,
      messageId: message.id,
      type: 'received',
      contactId: contact.id,
      chatId: chat.id,
      messageType: messageTypeDetail, // Add message type
      mediaInfo: mediaInfo, // Include media details
      metaPayload: metaPayload // Pass full Meta payload
    }, 'whatsapp_incoming');
    
    // Log n8n forwarding result
    if (n8nForwardResult.success) {
      console.log(`✅ ${messageTypeDetail.toUpperCase()} message forwarded to n8n successfully`);
    } else {
      console.log(`⚠️ ${messageTypeDetail.toUpperCase()} message saved but n8n forwarding failed`);
    }
    
    // **Step 4: Store in memory for backward compatibility**
    if (!chats[phone]) {
      chats[phone] = {
        number: phone,
        name: contact.name || `+${phone}`,
        messages: [],
        unread: 0,
        lastMessage: timestamp
      };
    }
    
    chats[phone].messages.push({
      id: message.id,
      text: content,
      timestamp: timestamp,
      type: 'received',
      from: phone,
      messageType: messageTypeDetail, // Store message type
      mediaInfo: mediaInfo // Store media info
    });
    
    chats[phone].lastMessage = timestamp;
    chats[phone].unread++;
    
    // **Step 5: Notify connected clients via Socket.IO**
    io.emit('new_message', {
      from: phone,
      message: content,
      timestamp: timestamp,
      contactName: contact.name,
      messageId: savedMessage.id,
      messageType: messageTypeDetail, // Add message type
      mediaInfo: mediaInfo, // Include media details
      source: 'whatsapp',
      n8nForwarded: n8nForwardResult.success
    });
    
    console.log(`💾 Saved ${messageTypeDetail} message to database and forwarded to n8n: ${phone}`);
    
  } catch (error) {
    console.error('Error processing incoming WhatsApp message:', error);
  }
}

// ==================== MEDIA SERVING ENDPOINT ====================

// Serve media files endpoint
app.get('/api/media/:filename', (req, res) => {
  try {
    const filePath = path.join(__dirname, 'uploads', 'media', req.params.filename);
    
    console.log(`📤 Serving media file: ${req.params.filename}`);
    
    if (fs.existsSync(filePath)) {
      // Determine content type
      const ext = path.extname(filePath).toLowerCase();
      const mimeTypes = {
        '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
        '.gif': 'image/gif', '.webp': 'image/webp',
        '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.opus': 'audio/opus',
        '.mp4': 'video/mp4', '.pdf': 'application/pdf',
        '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      };
      
      const contentType = mimeTypes[ext] || 'application/octet-stream';
      res.setHeader('Content-Type', contentType);
      
      // For audio/video, allow range requests for streaming
      if (ext === '.mp3' || ext === '.ogg' || ext === '.opus' || ext === '.mp4') {
        res.setHeader('Accept-Ranges', 'bytes');
      }
      
      // Set cache headers
      res.setHeader('Cache-Control', 'public, max-age=86400'); // Cache for 1 day
      
      const fileStream = fs.createReadStream(filePath);
      fileStream.pipe(res);
      
      fileStream.on('error', (err) => {
        console.error('File stream error:', err);
        res.status(500).send('Error serving file');
      });
    } else {
      console.log(`❌ File not found: ${filePath}`);
      res.status(404).json({
        error: 'File not found',
        filename: req.params.filename,
        path: filePath
      });
    }
  } catch (error) {
    console.error('Error serving media:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
});

// ==================== N8N INTEGRATION ENDPOINTS ====================

// Endpoint to receive messages from n8n (OUTGOING MESSAGES)
app.post('/api/n8n/messages', async (req, res) => {
  try {
    console.log('📩 Received message from n8n:', req.body);
    
    const { 
      to,          // Recipient phone number
      message,     // Message content
      timestamp = new Date().toISOString(),
      messageId,
      contactName,
      direction = 'outgoing',
      source = 'n8n'
    } = req.body;
    
    // Validate required fields
    if (!to || !message) {
      return res.status(400).json({ 
        success: false, 
        error: 'Missing required fields: to and message' 
      });
    }
    
    console.log(`📤 Processing n8n message to ${to}: ${message.substring(0, 50)}...`);
    
    // Save to database as outgoing message
    const contact = await dbHelpers.findOr
