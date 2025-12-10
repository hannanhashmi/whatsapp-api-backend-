// server.js - Complete WhatsApp Backend (PostgreSQL + n8n + Socket.IO)

require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const http = require('http');
const socketIo = require('socket.io');
const axios = require('axios');
const { Pool } = require('pg');

const app = express();
const server = http.createServer(app);

// ==================== CONFIG ====================
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL || "https://xibado3.app.n8n.cloud/webhook/whatsapp-hook";
const PORT = process.env.PORT || 10000;

// ==================== MIDDLEWARE ====================
app.use(cors({ origin: "*", credentials: true }));
app.use(bodyParser.json());           // parse JSON bodies
app.use(bodyParser.urlencoded({ extended: true }));

// ============= PostgreSQL Pool (optional) =============
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || null,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

// ==================== DB INITIALIZATION ====================
async function initializeDatabase() {
  if (!pool) return console.log('⚠️ No database configured (DATABASE_URL missing). Skipping DB init.');
  try {
    console.log('📊 Initializing PostgreSQL database...');
    await pool.query(`
      CREATE TABLE IF NOT EXISTS contacts (
        id SERIAL PRIMARY KEY,
        phone_number VARCHAR(50) UNIQUE NOT NULL,
        name VARCHAR(255),
        email VARCHAR(255),
        tags TEXT[] DEFAULT '{}',
        notes TEXT,
        assigned_to VARCHAR(50),
        status VARCHAR(20) DEFAULT 'new',
        last_message_at TIMESTAMP,
        message_count INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS chats (
        id SERIAL PRIMARY KEY,
        contact_id INTEGER REFERENCES contacts(id) ON DELETE CASCADE,
        phone_number VARCHAR(50) NOT NULL,
        unread_count INTEGER DEFAULT 0,
        last_message TEXT,
        last_message_at TIMESTAMP,
        is_active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(phone_number)
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id SERIAL PRIMARY KEY,
        chat_id INTEGER REFERENCES chats(id) ON DELETE CASCADE,
        contact_id INTEGER REFERENCES contacts(id) ON DELETE CASCADE,
        message_type VARCHAR(10) NOT NULL CHECK (message_type IN ('received', 'sent')),
        content TEXT NOT NULL,
        whatsapp_message_id VARCHAR(200),
        status VARCHAR(20) DEFAULT 'sent' CHECK (status IN ('sent','delivered','read','failed')),
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_contacts_phone ON contacts(phone_number);
      CREATE INDEX IF NOT EXISTS idx_chats_phone ON chats(phone_number);
      CREATE INDEX IF NOT EXISTS idx_messages_chat_id ON messages(chat_id);
    `);

    console.log('✅ Database tables created/verified successfully');
  } catch (err) {
    console.error('❌ Database initialization error:', err);
    throw err;
  }
}

// ==================== DB HELPERS ====================
const dbHelpers = {
  async findOrCreateContact(phoneNumber, name = null) {
    if (!pool) return { id: null, phone_number: phoneNumber, name: name || `+${phoneNumber}` };
    try {
      const find = await pool.query('SELECT * FROM contacts WHERE phone_number = $1', [phoneNumber]);
      if (find.rows.length) {
        const row = find.rows[0];
        await pool.query(
          `UPDATE contacts SET last_message_at = CURRENT_TIMESTAMP, message_count = message_count + 1, updated_at = CURRENT_TIMESTAMP WHERE phone_number = $1`,
          [phoneNumber]
        );
        return row;
      }
      const create = await pool.query(
        `INSERT INTO contacts (phone_number, name, last_message_at, message_count) VALUES ($1, $2, CURRENT_TIMESTAMP, 1) RETURNING *`,
        [phoneNumber, name || `+${phoneNumber}`]
      );
      return create.rows[0];
    } catch (err) {
      console.error('Contact find/create error:', err);
      throw err;
    }
  },

  async findOrCreateChat(contactId, phoneNumber) {
    if (!pool) return { id: null, phone_number: phoneNumber, contact_id: contactId };
    try {
      const find = await pool.query('SELECT * FROM chats WHERE phone_number = $1', [phoneNumber]);
      if (find.rows.length) return find.rows[0];
      const create = await pool.query(
        `INSERT INTO chats (contact_id, phone_number, unread_count, last_message_at) VALUES ($1, $2, 0, CURRENT_TIMESTAMP) RETURNING *`,
        [contactId, phoneNumber]
      );
      return create.rows[0];
    } catch (err) {
      console.error('Chat find/create error:', err);
      throw err;
    }
  },

  async addMessage(chatId, contactId, messageData) {
    if (!pool) {
      // If no DB, return a mock saved object
      return {
        id: `mock-${Date.now()}`,
        chat_id: chatId,
        contact_id: contactId,
        message_type: messageData.type,
        content: messageData.content,
        whatsapp_message_id: messageData.whatsappMessageId,
        status: messageData.status || 'delivered',
        timestamp: messageData.timestamp || new Date()
      };
    }
    try {
      const res = await pool.query(
        `INSERT INTO messages (chat_id, contact_id, message_type, content, whatsapp_message_id, status, timestamp)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
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

      await pool.query(
        `UPDATE chats SET last_message = $1, last_message_at = $2, unread_count = unread_count + $3, updated_at = CURRENT_TIMESTAMP WHERE id = $4`,
        [
          (messageData.content || '').substring(0, 200),
          messageData.timestamp || new Date(),
          messageData.type === 'received' ? 1 : 0,
          chatId
        ]
      );

      return res.rows[0];
    } catch (err) {
      console.error('Add message error:', err);
      throw err;
    }
  },

  async getAllChats(limit = 100) {
    if (!pool) return [];
    const q = await pool.query(`
      SELECT
        c.*,
        ct.name AS contact_name,
        ct.status AS contact_status,
        ct.email AS contact_email,
        (SELECT COUNT(*) FROM messages m WHERE m.chat_id = c.id) as total_messages
      FROM chats c
      LEFT JOIN contacts ct ON c.contact_id = ct.id
      WHERE c.is_active = TRUE
      ORDER BY c.last_message_at DESC NULLS LAST
      LIMIT $1
    `, [limit]);
    return q.rows;
  },

  async getChatMessages(phoneNumber, limit = 200) {
    if (!pool) return [];
    const q = await pool.query(`
      SELECT m.*, ct.name as contact_name
      FROM messages m
      LEFT JOIN contacts ct ON m.contact_id = ct.id
      WHERE m.chat_id = (SELECT id FROM chats WHERE phone_number = $1)
      ORDER BY m.timestamp ASC
      LIMIT $2
    `, [phoneNumber, limit]);
    return q.rows;
  },

  async markChatAsRead(phoneNumber) {
    if (!pool) return;
    await pool.query(`UPDATE chats SET unread_count = 0, updated_at = CURRENT_TIMESTAMP WHERE phone_number = $1`, [phoneNumber]);
  },

  async getAllContacts(limit = 100) {
    if (!pool) return [];
    const r = await pool.query(`SELECT * FROM contacts ORDER BY last_message_at DESC NULLS LAST, created_at DESC LIMIT $1`, [limit]);
    return r.rows;
  },

  async updateContact(id, updates) {
    if (!pool) return null;
    const fields = [], values = [];
    let idx = 1;
    for (const k of Object.keys(updates)) {
      if (updates[k] !== undefined) {
        fields.push(`${k} = $${idx}`);
        values.push(updates[k]);
        idx++;
      }
    }
    if (!fields.length) return null;
    fields.push('updated_at = CURRENT_TIMESTAMP');
    values.push(id);
    const q = `
      UPDATE contacts SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *
    `;
    const res = await pool.query(q, values);
    return res.rows[0];
  }
};

// ==================== In-memory chats (fallback) ====================
let chats = {};
const MAX_CHATS = 200;
const MAX_MESSAGES_PER_CHAT = 200;

function cleanupOldData() {
  const keys = Object.keys(chats);
  if (keys.length > MAX_CHATS) {
    const sorted = keys.sort((a, b) => new Date(chats[b].lastMessage) - new Date(chats[a].lastMessage));
    sorted.slice(MAX_CHATS).forEach(k => delete chats[k]);
  }
  Object.values(chats).forEach(c => {
    if (c.messages.length > MAX_MESSAGES_PER_CHAT) c.messages = c.messages.slice(-MAX_MESSAGES_PER_CHAT);
  });
}

// ==================== Socket.IO ====================
const io = socketIo(server, {
  cors: { origin: "*", methods: ["GET","POST"], credentials: true },
  transports: ['websocket','polling']
});

io.on('connection', (socket) => {
  console.log('🔌 New client connected:', socket.id);
  socket.emit('connection_established', { message: 'Connected to WhatsApp Backend', timestamp: new Date().toISOString() });
  socket.on('disconnect', () => console.log('Socket disconnected:', socket.id));
});

// ==================== Core Message Processor ====================
/**
 * processIncomingMessage(message, metaPayload)
 * message - an object representing a WhatsApp message (as from Meta)
 * metaPayload - full webhook payload (optional)
 */
async function processIncomingMessage(message, metaPayload = null) {
  try {
    const phone = message.from || message.from || message.from;
    const content = message.text?.body || message.body?.text || '[Media/File Message]';
    const timestamp = message.timestamp ? new Date(message.timestamp * 1000) : new Date();

    console.log(`💬 Processing incoming message from ${phone}: ${String(content).slice(0,60)}...`);

    const contact = await dbHelpers.findOrCreateContact(phone);
    const chat = await dbHelpers.findOrCreateChat(contact.id, phone);

    const savedMessage = await dbHelpers.addMessage(chat.id, contact.id, {
      type: 'received',
      content: content,
      whatsappMessageId: message.id || null,
      timestamp: timestamp,
      status: 'delivered'
    });

    // Store in memory fallback
    if (!chats[phone]) chats[phone] = { number: phone, name: contact.name || `+${phone}`, messages: [], unread: 0, lastMessage: timestamp };
    chats[phone].messages.push({ id: message.id || savedMessage.id, text: content, timestamp, type: 'received', from: phone });
    chats[phone].lastMessage = timestamp;
    chats[phone].unread++;

    // Forward to n8n
    const n8nResult = await forwardToN8N({
      phone,
      content,
      timestamp,
      contactName: contact.name,
      messageId: message.id || savedMessage.id,
      type: 'received',
      contactId: contact.id,
      chatId: chat.id,
      metaPayload
    }, 'whatsapp_incoming');

    // Notify clients
    io.emit('new_message', {
      from: phone,
      message: content,
      timestamp,
      contactName: contact.name,
      messageId: savedMessage.id,
      n8nForwarded: n8nResult.success
    });

    console.log(`💾 Saved incoming message for ${phone} (n8nForwarded: ${n8nResult.success})`);
    return savedMessage;
  } catch (err) {
    console.error('Error in processIncomingMessage:', err);
    throw err;
  }
}

// processWebhook: accept a Meta-like webhook payload and feed to internal processor
async function processWebhook(metaPayload) {
  try {
    if (!metaPayload || !metaPayload.entry) return { success: false, error: 'Invalid payload' };
    for (const entry of metaPayload.entry) {
      for (const change of entry.changes || []) {
        if (change.field === 'messages' && change.value?.messages) {
          for (const msg of change.value.messages) {
            await processIncomingMessage(msg, metaPayload);
          }
        }
      }
    }
    return { success: true };
  } catch (err) {
    console.error('processWebhook error:', err);
    return { success: false, error: err.message };
  }
}

// ==================== n8n Forwarding ====================
async function forwardToN8N(messageData, source) {
  try {
    const n8nPayload = {
      from: messageData.phone,
      message: messageData.content,
      timestamp: messageData.timestamp || new Date().toISOString(),
      contactName: messageData.contactName || `+${messageData.phone}`,
      messageId: messageData.messageId || `msg-${Date.now()}`,
      source,
      direction: messageData.type === 'received' ? 'incoming' : 'outgoing',
      contactId: messageData.contactId,
      chatId: messageData.chatId,
      platform: 'whatsapp',
      serverTime: new Date().toISOString()
    };
    if (messageData.metaPayload) n8nPayload.metaData = messageData.metaPayload;

    const resp = await axios.post(N8N_WEBHOOK_URL, n8nPayload, {
      headers: { 'Content-Type': 'application/json', 'X-Source': 'whatsapp-backend' },
      timeout: 8000
    });
    return { success: true, response: resp.data, status: resp.status };
  } catch (err) {
    console.error('❌ Failed to forward to n8n:', err.message || err);
    return { success: false, error: err.message || String(err) };
  }
}

// ==================== API KEY / n8n AUTH MIDDLEWARE ====================
const verifyN8nApiKey = (req, res, next) => {
  const publicPaths = ['/', '/ping', '/health', '/webhook', '/api/chats', '/api/send'];
  if (publicPaths.includes(req.path)) return next();

  if (req.path.startsWith('/api/n8n')) {
    const apiKey = req.headers['authorization']?.replace('Bearer ', '');
    const secretKey = req.headers['x-n8n-secret'];
    const validApiKey = apiKey && process.env.N8N_API_KEY && apiKey === process.env.N8N_API_KEY;
    const validSecret = secretKey && process.env.N8N_SECRET && secretKey === process.env.N8N_SECRET;
    if (validApiKey || validSecret) return next();
    console.log('❌ Invalid n8n API key attempt:', req.headers['authorization'], req.headers['x-n8n-secret']);
    return res.status(401).json({ success: false, error: 'Invalid API credentials' });
  }
  next();
};

app.use(verifyN8nApiKey);

// ==================== WEBHOOK (Meta) ENDPOINTS ====================
// GET for verification (Facebook/Meta)
app.get('/webhook', (req, res) => {
  const verify_token = process.env.VERIFY_TOKEN;
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode && token) {
    if (mode === 'subscribe' && token === verify_token) {
      console.log('✅ Webhook verified successfully');
      return res.status(200).send(challenge);
    } else {
      console.log('❌ Webhook verification failed');
      return res.sendStatus(403);
    }
  }
  return res.sendStatus(400);
});

// POST from Meta (WhatsApp)
app.post('/webhook', async (req, res) => {
  try {
    const body = req.body;
    if (body.object === 'whatsapp_business_account') {
      for (const entry of body.entry || []) {
        for (const change of entry.changes || []) {
          if (change.field === 'messages' && change.value?.messages) {
            for (const message of change.value.messages) {
              // process each message
              await processIncomingMessage(message, body);
            }
          }
        }
      }
      return res.status(200).send('EVENT_RECEIVED');
    }
    return res.sendStatus(404);
  } catch (err) {
    console.error('Webhook processing error:', err);
    return res.status(500).send('ERROR');
  }
});

// ==================== n8n -> BACKEND ENDPOINTS ====================
// Accepts simple n8n payload and converts to Meta-style and processes
app.post(['/api/n8n/messages', '/api/n8n-messages'], async (req, res) => {
  try {
    console.log('📩 Received message from n8n (raw):', req.body);

    const { message, from, to, timestamp, messageId, contactName, direction } = req.body;

    // If n8n is sending "to" & "message" in plain format
    if (message && (to || from)) {
      const phone = to || from;
      // create meta-like payload
      const metaFormat = {
        object: 'whatsapp_business_account',
        entry: [{
          id: 'n8n-entry',
          changes: [{
            value: {
              messaging_product: 'whatsapp',
              metadata: {
                display_phone_number: phone,
                phone_number_id: process.env.PHONE_NUMBER_ID || 'n8n-phone-id'
              },
              contacts: [{
                profile: { name: contactName || 'User' },
                wa_id: phone
              }],
              messages: [{
                from: phone,
                id: messageId || `n8n-${Date.now()}`,
                timestamp: timestamp ? Math.floor(new Date(timestamp).getTime() / 1000) : Math.floor(Date.now() / 1000),
                type: 'text',
                text: { body: message }
              }]
            },
            field: 'messages'
          }]
        }]
      };

      // Process internally
      const result = await processWebhook(metaFormat);
      if (result.success) {
        return res.status(200).json({ success: true, message: 'Message processed successfully' });
      } else {
        return res.status(500).json({ success: false, error: result.error || 'processing_failed' });
      }
    }

    // Otherwise, expecting a meta-like payload from n8n already
    if (req.body.object === 'whatsapp_business_account') {
      const r = await processWebhook(req.body);
      if (r.success) return res.json({ success: true });
      return res.status(500).json({ success: false, error: r.error || 'processing_failed' });
    }

    return res.status(400).json({ success: false, error: 'Invalid payload' });
  } catch (err) {
    console.error('Error processing n8n message:', err);
    return res.status(500).json({ success: false, error: err.message || 'server_error' });
  }
});

// ==================== DASHBOARD ENDPOINTS ====================
// Send message from dashboard via Meta Graph API
app.post('/api/send', async (req, res) => {
  try {
    const { to, message } = req.body;
    if (!to || !message) return res.status(400).json({ success: false, error: 'Missing to or message' });

    console.log(`📤 Dashboard sending message to ${to}...`);
    const response = await axios.post(
      `https://graph.facebook.com/v18.0/${process.env.PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to,
        type: "text",
        text: { preview_url: false, body: message }
      },
      {
        headers: { Authorization: `Bearer ${process.env.ACCESS_TOKEN}`, 'Content-Type': 'application/json' }
      }
    );

    const whatsappMessageId = response.data?.messages?.[0]?.id || null;

    // Save to DB
    const contact = await dbHelpers.findOrCreateContact(to);
    const chat = await dbHelpers.findOrCreateChat(contact.id, to);
    const saved = await dbHelpers.addMessage(chat.id, contact.id, {
      type: 'sent',
      content: message,
      whatsappMessageId,
      timestamp: new Date(),
      status: 'sent'
    });

    // memory store
    if (!chats[to]) chats[to] = { number: to, name: contact.name || `+${to}`, messages: [], unread: 0, lastMessage: new Date() };
    chats[to].messages.push({ id: whatsappMessageId || saved.id, text: message, timestamp: new Date(), type: 'sent', from: 'me' });
    chats[to].lastMessage = new Date();

    // forward to n8n
    await forwardToN8N({
      phone: to, content: message, timestamp: new Date(), contactName: contact.name, messageId: whatsappMessageId, type: 'sent', contactId: contact.id, chatId: chat.id
    }, 'dashboard_outgoing');

    io.emit('message_sent', { to, message, messageId: saved.id, whatsappMessageId, timestamp: new Date() });

    return res.json({ success: true, data: response.data, databaseId: saved.id });
  } catch (err) {
    console.error('Send message error:', err.response?.data || err.message || err);
    return res.status(500).json({ success: false, error: err.response?.data || err.message || 'send_error' });
  }
});

// Get chats
app.get('/api/chats', async (req, res) => {
  try {
    cleanupOldData();
    const dbChats = await dbHelpers.getAllChats();
    if (dbChats.length > 0) {
      const formatted = dbChats.map(c => ({
        id: c.id, number: c.phone_number, name: c.contact_name || `+${c.phone_number}`,
        unread: c.unread_count || 0, lastMessage: c.last_message, lastMessageAt: c.last_message_at, contactInfo: { name: c.contact_name, email: c.contact_email, status: c.contact_status }
      }));
      return res.json({ success: true, total: formatted.length, chats: formatted });
    }
    // fallback to memory
    return res.json({ success: true, total: Object.keys(chats).length, chats: Object.values(chats) });
  } catch (err) {
    console.error('Error getting chats:', err);
    return res.status(500).json({ success: false, error: err.message || 'fetch_error' });
  }
});

// Get messages for a chat
app.get('/api/chats/:number/messages', async (req, res) => {
  const number = req.params.number;
  try {
    await dbHelpers.markChatAsRead(number);
    const messages = await dbHelpers.getChatMessages(number);
    if (messages.length > 0) {
      return res.json(messages.map(m => ({ id: m.id, text: m.content, timestamp: m.timestamp, type: m.message_type, from: m.message_type === 'received' ? number : 'me', status: m.status })));
    }
    // fallback
    if (chats[number]) {
      chats[number].unread = 0;
      return res.json(chats[number].messages);
    }
    return res.json([]);
  } catch (err) {
    console.error('Error getting messages for chat:', err);
    if (chats[number]) { chats[number].unread = 0; return res.json(chats[number].messages); }
    return res.status(500).json([]);
  }
});

// Update contact
app.put('/api/contact/:id', async (req, res) => {
  try {
    const updated = await dbHelpers.updateContact(req.params.id, req.body);
    return res.json({ success: true, contact: updated });
  } catch (err) {
    console.error('Update contact error:', err);
    return res.status(500).json({ success: false, error: err.message || 'update_error' });
  }
});

// Ping & Health
app.get('/ping', (req, res) => {
  res.json({ status: 'pong', timestamp: new Date().toISOString(), service: 'WhatsApp Backend', uptime: process.uptime(), chats_count: Object.keys(chats).length, n8nWebhook: N8N_WEBHOOK_URL });
});

app.get('/health', async (req, res) => {
  try {
    if (pool) await pool.query('SELECT 1');
    let n8nStatus = 'not_tested';
    try {
      // check base of n8n webhook domain
      const base = N8N_WEBHOOK_URL.replace(/\/webhook\/.*$/, '/');
      await axios.get(base, { timeout: 3000 });
      n8nStatus = 'reachable';
    } catch {
      n8nStatus = 'webhook_only';
    }
    return res.json({ status: 'healthy', timestamp: new Date().toISOString(), database: pool ? 'connected' : 'not_configured', n8n: n8nStatus });
  } catch (err) {
    console.error('Health check failed:', err);
    return res.status(500).json({ status: 'degraded', error: err.message });
  }
});

// Root
app.get('/', (req, res) => {
  res.json({
    service: 'WhatsApp Business API Backend',
    status: 'running',
    version: '2.1.0',
    endpoints: { webhook: '/webhook', chats: '/api/chats', send: '/api/send', n8n: '/api/n8n/messages' }
  });
});

// Auto cleanup
setInterval(cleanupOldData, 30 * 60 * 1000);

// ==================== START SERVER ====================
async function startServer() {
  try {
    await initializeDatabase();
    if (pool) await pool.query('SELECT 1').catch(e => console.warn('DB ping failed:', e.message));
    server.listen(PORT, '0.0.0.0', () => {
      console.log(`🚀 Server started at http://0.0.0.0:${PORT}`);
      console.log(`🔗 n8n Webhook: ${N8N_WEBHOOK_URL}`);
    });
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}
startServer();
