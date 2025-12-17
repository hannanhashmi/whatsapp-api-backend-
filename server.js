// Required imports
const { Pool } = require('pg');
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios'); // ✅ axios already included
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
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
app.use(cors({
  origin: "*",
  credentials: true
}));

app.use(bodyParser.json());

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
      // Insert message
      const messageResult = await pool.query(
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
      await pool.query(
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
          await processIncomingMessage(message);
        }
      }
    }
    
    res.status(200).send('EVENT_RECEIVED');
  } else {
    res.sendStatus(404);
  }
});



async function processIncomingMessage(message) {
  const phone = message.from;
  const content = message.text?.body || '[Media/File Message]';
  const timestamp = new Date(message.timestamp * 1000);
  
  console.log(`💬 Processing message from ${phone}: ${content.substring(0, 50)}...`);
  
  try {
    // Save to PostgreSQL database
    const contact = await dbHelpers.findOrCreateContact(phone);
    const chat = await dbHelpers.findOrCreateChat(contact.id, phone);
    
    const savedMessage = await dbHelpers.addMessage(chat.id, contact.id, {
      type: 'received',
      content: content,
      whatsappMessageId: message.id,
      timestamp: timestamp,
      status: 'delivered'
    });

    // 🔁 CRITICAL: Forward to n8n webhook (FIXED)
    try {
      if (process.env.N8N_WEBHOOK_URL) {
        console.log(`🔄 Forwarding to n8n: ${process.env.N8N_WEBHOOK_URL}`);
        
        await axios.post(process.env.N8N_WEBHOOK_URL, {
          // n8n के लिए format
          object: 'whatsapp_business_account',
          entry: [{
            id: 'backend-forward',
            changes: [{
              value: {
                messaging_product: 'whatsapp',
                metadata: {
                  display_phone_number: process.env.PHONE_NUMBER_ID,
                  phone_number_id: process.env.PHONE_NUMBER_ID
                },
                contacts: [{
                  profile: { name: contact.name },
                  wa_id: phone
                }],
                messages: [{
                  from: phone,
                  id: message.id,
                  timestamp: message.timestamp,
                  type: 'text',
                  text: { body: content }
                }]
              },
              field: 'messages'
            }]
          }]
        }, {
          headers: { 
            'Content-Type': 'application/json',
            'X-Backend-Source': 'whatsapp-backend'
          },
          timeout: 5000
        });
        
        console.log("✅ Successfully forwarded to n8n");
      } else {
        console.log("⚠️ N8N_WEBHOOK_URL not configured");
      }
    } catch (error) {
      console.error("❌ Failed forwarding to n8n:", error.message);
      // Continue even if n8n forwarding fails
    }
    
    // 🔁 Forward message to n8n webhook (using axios instead of fetch)
    try {
      if (process.env.N8N_WEBHOOK_URL) {
        await axios.post(process.env.N8N_WEBHOOK_URL, {
          from: phone,
          message: content,
          timestamp: timestamp,
          contactName: contact.name,
          source: 'whatsapp_webhook',
          direction: 'incoming'
        }, {
          headers: { 'Content-Type': 'application/json' }
        });
        console.log("🔁 Message forwarded to N8N successfully");
      }
    } catch (error) {
      console.error("❌ Failed forwarding to N8N:", error.message);
    }
    
    // Also store in memory for backward compatibility
    if (!chats[phone]) {
      chats[phone] = {
        number: phone,
        name: `+${phone}`,
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
      from: phone
    });
    
    chats[phone].lastMessage = timestamp;
    chats[phone].unread++;
    
    // Notify connected clients via Socket.IO
    io.emit('new_message', {
      from: phone,
      message: content,
      timestamp: timestamp,
      contactName: contact.name,
      messageId: savedMessage.id,
      source: 'whatsapp'
    });
    
    console.log(`💾 Saved message to database: ${phone}`);
    
  } catch (error) {
    console.error('Error processing incoming message:', error);
  }
}

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
    const contact = await dbHelpers.findOrCreateContact(to, contactName);
    const chat = await dbHelpers.findOrCreateChat(contact.id, to);
    
    const savedMessage = await dbHelpers.addMessage(chat.id, contact.id, {
      type: 'sent',
      content: message,
      whatsappMessageId: messageId || `n8n-${Date.now()}`,
      timestamp: new Date(timestamp),
      status: 'sent'
    });
    
    // Also store in memory for backward compatibility
    if (!chats[to]) {
      chats[to] = {
        number: to,
        name: contactName || `+${to}`,
        messages: [],
        unread: 0,
        lastMessage: new Date()
      };
    }
    
    chats[to].messages.push({
      id: messageId || `n8n-${Date.now()}`,
      text: message,
      timestamp: new Date(timestamp),
      type: 'sent',
      from: 'me'
    });
    
    chats[to].lastMessage = new Date();
    
    // Notify connected clients via Socket.IO
    io.emit('new_message', {
      from: to,
      message: message,
      timestamp: new Date(timestamp),
      contactName: contact.name,
      messageId: savedMessage.id,
      source: 'n8n',
      direction: 'outgoing'
    });
    
    console.log(`✅ n8n message saved to database for ${to}`);
    
    res.status(200).json({ 
      success: true, 
      messageId: savedMessage.id,
      databaseId: savedMessage.id,
      timestamp: new Date().toISOString(),
      message: 'Message saved to database successfully'
    });
    
  } catch (error) {
    console.error('❌ Error processing n8n message:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Simulate incoming message from n8n (for testing)
app.post('/api/n8n/simulate-incoming', async (req, res) => {
  try {
    const { from, message } = req.body;
    
    if (!from || !message) {
      return res.status(400).json({ 
        success: false, 
        error: 'Missing from or message' 
      });
    }
    
    // Create fake WhatsApp message
    const fakeMessage = {
      from: from,
      text: { body: message },
      id: `sim-${Date.now()}`,
      timestamp: Math.floor(Date.now() / 1000)
    };
    
    // Process as incoming message
    await processIncomingMessage(fakeMessage);
    
    res.status(200).json({ 
      success: true, 
      message: 'Simulated incoming message processed' 
    });
    
  } catch (error) {
    console.error('Error simulating message:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Get n8n integration status
app.get('/api/n8n/status', (req, res) => {
  res.json({
    n8nIntegration: true,
    webhookUrl: process.env.N8N_WEBHOOK_URL || 'Not set',
    apiKeyConfigured: !!process.env.N8N_API_KEY,
    endpoints: {
      receiveMessages: 'POST /api/n8n/messages',
      simulateIncoming: 'POST /api/n8n/simulate-incoming',
      status: 'GET /api/n8n/status'
    },
    timestamp: new Date().toISOString()
  });
});

// ==================== API ENDPOINTS ====================

// API: Get all chats (from database)
app.get('/api/chats', async (req, res) => {
  try {
    cleanupOldData();
    
    // Try to get from database first
    const dbChats = await dbHelpers.getAllChats();
    
    if (dbChats.length > 0) {
      // Convert to frontend format
      const formattedChats = dbChats.map(chat => ({
        id: chat.id,
        number: chat.phone_number,
        name: chat.contact_name || `+${chat.phone_number}`,
        messages: [], // Messages loaded separately
        unread: chat.unread_count || 0,
        lastMessage: chat.last_message,
        lastMessageAt: chat.last_message_at,
        contactInfo: {
          name: chat.contact_name,
          status: chat.contact_status,
          email: chat.contact_email
        }
      }));
      
      res.json(formattedChats);
    } else {
      // Fallback to memory chats
      res.json(Object.values(chats));
    }
    
  } catch (error) {
    console.error('Error getting chats:', error);
    // Fallback to memory chats on error
    res.json(Object.values(chats));
  }
});

// API: Get messages of specific chat (from database)
app.get('/api/chats/:number/messages', async (req, res) => {
  const number = req.params.number;
  
  try {
    // Try to get from database
    await dbHelpers.markChatAsRead(number);
    const messages = await dbHelpers.getChatMessages(number);
    
    if (messages.length > 0) {
      res.json(messages.map(msg => ({
        id: msg.id,
        text: msg.content,
        timestamp: msg.timestamp,
        type: msg.message_type,
        from: msg.message_type === 'received' ? number : 'me',
        status: msg.status
      })));
    } else {
      // Fallback to memory
      if (chats[number]) {
        chats[number].unread = 0;
        res.json(chats[number].messages);
      } else {
        res.json([]);
      }
    }
    
  } catch (error) {
    console.error('Error getting messages:', error);
    // Fallback to memory
    if (chats[number]) {
      chats[number].unread = 0;
      res.json(chats[number].messages);
    } else {
      res.json([]);
    }
  }
});

// API: Send message
app.post('/api/send', async (req, res) => {
  try {
    const { to, message } = req.body;
    
    if (!to || !message) {
      return res.status(400).json({
        success: false,
        error: 'Missing to or message field'
      });
    }
    
    // Send via WhatsApp API
    const response = await axios.post(
      `https://graph.facebook.com/v18.0/${process.env.PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: to,
        type: "text",
        text: {
          preview_url: false,
          body: message
        }
      },
      {
        headers: {
          'Authorization': `Bearer ${process.env.ACCESS_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }
    );
    
    try {
      // Save to PostgreSQL database
      const contact = await dbHelpers.findOrCreateContact(to);
      const chat = await dbHelpers.findOrCreateChat(contact.id, to);
      
      await dbHelpers.addMessage(chat.id, contact.id, {
        type: 'sent',
        content: message,
        whatsappMessageId: response.data.messages[0].id,
        timestamp: new Date(),
        status: 'sent'
      });
      
      console.log(`💾 Saved sent message to database: ${to}`);
      
    } catch (dbError) {
      console.error('Error saving sent message to database:', dbError);
      // Continue even if DB save fails
    }
    
    // Also store in memory for backward compatibility
    if (!chats[to]) {
      chats[to] = {
        number: to,
        name: `+${to}`,
        messages: [],
        unread: 0,
        lastMessage: new Date()
      };
    }
    
    chats[to].messages.push({
      id: response.data.messages[0].id,
      text: message,
      timestamp: new Date(),
      type: 'sent',
      from: 'me'
    });
    
    chats[to].lastMessage = new Date();
    
    // Notify via Socket.IO
    io.emit('message_sent', {
      to: to,
      message: message
    });
    
    res.json({ 
      success: true, 
      data: response.data,
      message: 'Message sent successfully'
    });
    
  } catch (error) {
    console.error('❌ Send message error:', error.response?.data || error.message);
    res.status(500).json({ 
      success: false, 
      error: error.response?.data || error.message 
    });
  }
});

// ==================== DATABASE API ENDPOINTS ====================

// Get all chats from database (direct endpoint)
app.get('/api/db/chats', async (req, res) => {
  try {
    const chats = await dbHelpers.getAllChats();
    res.json(chats);
  } catch (error) {
    console.error('Error fetching chats:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get chat messages from database (direct endpoint)
app.get('/api/db/chats/:phone/messages', async (req, res) => {
  try {
    const phone = req.params.phone;
    
    // Mark as read
    await dbHelpers.markChatAsRead(phone);
    
    // Get messages
    const messages = await dbHelpers.getChatMessages(phone);
    
    // Get contact info
    const contactResult = await pool.query(
      'SELECT * FROM contacts WHERE phone_number = $1',
      [phone]
    );
    
    res.json({
      messages: messages,
      contact: contactResult.rows[0] || null,
      unreadCount: 0
    });
    
  } catch (error) {
    console.error('Error fetching messages:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get all contacts from database
app.get('/api/db/contacts', async (req, res) => {
  try {
    const contacts = await dbHelpers.getAllContacts();
    res.json(contacts);
  } catch (error) {
    console.error('Error fetching contacts:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update contact
app.put('/api/db/contacts/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const updates = req.body;
    
    const updated = await dbHelpers.updateContact(id, updates);
    
    if (updated) {
      res.json({ success: true, contact: updated });
    } else {
      res.status(404).json({ error: 'Contact not found' });
    }
  } catch (error) {
    console.error('Error updating contact:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ==================== UTILITY ENDPOINTS ====================

// Ping endpoint for keeping service alive
app.get('/ping', (req, res) => {
  res.json({
    status: 'pong',
    timestamp: new Date().toISOString(),
    service: 'WhatsApp Backend API',
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    chats_count: Object.keys(chats).length,
    database: 'PostgreSQL connected',
    n8nIntegration: !!process.env.N8N_WEBHOOK_URL
  });
});

// Health check endpoint
app.get('/health', async (req, res) => {
  try {
    // Test database connection
    await pool.query('SELECT 1');
    
    res.json({ 
      status: 'healthy',
      timestamp: new Date().toISOString(),
      service: 'WhatsApp Business API',
      version: '2.0.0',
      environment: process.env.NODE_ENV || 'development',
      database: 'connected',
      n8nIntegration: {
        enabled: !!process.env.N8N_WEBHOOK_URL,
        webhookUrl: process.env.N8N_WEBHOOK_URL || 'Not configured',
        apiKey: process.env.N8N_API_KEY ? 'Configured' : 'Not configured'
      }
    });
  } catch (error) {
    res.json({
      status: 'degraded',
      timestamp: new Date().toISOString(),
      service: 'WhatsApp Business API',
      version: '2.0.0',
      environment: process.env.NODE_ENV || 'development',
      database: 'disconnected',
      warning: 'Database connection failed'
    });
  }
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    service: 'WhatsApp Business API Backend',
    status: 'running',
    version: '2.0.0',
    database: 'PostgreSQL',
    features: [
      'Webhook handling',
      'Message storage in database',
      'Real-time updates',
      'Contact management',
      'Chat persistence',
      'n8n Integration'
    ],
    endpoints: {
      webhook: '/webhook (GET/POST)',
      chats: '/api/chats (GET)',
      'chats-db': '/api/db/chats (GET)',
      send: '/api/send (POST)',
      contacts: '/api/db/contacts (GET)',
      'n8n-messages': '/api/n8n/messages (POST)',
      'n8n-status': '/api/n8n/status (GET)',
      health: '/health (GET)',
      ping: '/ping (GET)'
    }
  });
});

// Socket.IO connection handler
io.on('connection', (socket) => {
  console.log('🔌 New client connected:', socket.id);
  
  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

// Auto cleanup every 30 minutes (for memory chats)
setInterval(cleanupOldData, 30 * 60 * 1000);

// Start Server
async function startServer() {
  try {
    // Initialize database
    await initializeDatabase();
    console.log('📊 Database initialization complete');
    
    // Test database connection
    await pool.query('SELECT 1');
    console.log('✅ PostgreSQL connection established');
    
    const PORT = process.env.PORT || 10000;
    server.listen(PORT, '0.0.0.0', () => {
      console.log(`🚀 WhatsApp Backend Server started`);
      console.log(`📍 Port: ${PORT}`);
      console.log(`🌐 Environment: ${process.env.NODE_ENV || 'development'}`);
      console.log(`💾 Database: PostgreSQL connected`);
      console.log(`🔄 n8n Integration: ${process.env.N8N_WEBHOOK_URL ? 'Enabled' : 'Disabled'}`);
      console.log(`📞 Endpoint: http://localhost:${PORT}`);
      console.log(`🔧 Ready to receive webhooks from WhatsApp`);
      console.log(`🔗 n8n Endpoint: POST http://localhost:${PORT}/api/n8n/messages`);
    });
    
  } catch (error) {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  }
}

// Start the server
startServer();
