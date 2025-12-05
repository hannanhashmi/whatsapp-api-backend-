const { pool, initializeDatabase } = require('./database');


const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
require('dotenv').config();

const app = express();
const server = http.createServer(app);




// Socket.IO with CORS
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
    credentials: true
  },
  transports: ['websocket', 'polling']
});

// CORS configuration
app.use(cors({
  origin: "*", // Sab allow karega, baad mein change kar sakte hain
  credentials: true
}));

app.use(bodyParser.json());

// Store chats in memory
let chats = {};
const MAX_CHATS = 100;
const MAX_MESSAGES_PER_CHAT = 200;

// Cleanup function
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
app.post('/webhook', (req, res) => {
  console.log('📩 Received webhook from WhatsApp');
  
  const body = req.body;
  
  if (body.object === 'whatsapp_business_account') {
    body.entry?.forEach(entry => {
      entry.changes?.forEach(change => {
        if (change.field === 'messages' && change.value.messages) {
          const message = change.value.messages[0];
          const from = message.from;
          const text = message.text?.body || '[Media/File Message]';
          const timestamp = message.timestamp * 1000;
          
          // Initialize chat if new
          if (!chats[from]) {
            chats[from] = {
              number: from,
              name: `+${from}`,
              messages: [],
              unread: 0,
              lastMessage: new Date(timestamp)
            };
          }
          
          // Add message to chat
          chats[from].messages.push({
            id: message.id,
            text: text,
            timestamp: new Date(timestamp),
            type: 'received',
            from: from
          });
          
          // Update chat metadata
          chats[from].lastMessage = new Date(timestamp);
          chats[from].unread++;
          
          // Notify connected clients via Socket.IO
          io.emit('new_message', {
            from: from,
            message: text,
            timestamp: new Date(timestamp)
          });
          
          console.log(`💬 New message from ${from}: ${text.substring(0, 50)}...`);
        }
      });
    });
    
    res.status(200).send('EVENT_RECEIVED');
  } else {
    res.sendStatus(404);
  }
});

// API: Get all chats
app.get('/api/chats', (req, res) => {
  cleanupOldData();
  res.json(Object.values(chats));
});

// API: Get messages of specific chat
app.get('/api/chats/:number/messages', (req, res) => {
  const number = req.params.number;
  if (chats[number]) {
    chats[number].unread = 0; // Mark as read
    res.json(chats[number].messages);
  } else {
    res.json([]);
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
    
    // Store in local memory
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

// Ping endpoint for keeping service alive
app.get('/ping', (req, res) => {
  res.json({
    status: 'pong',
    timestamp: new Date().toISOString(),
    service: 'WhatsApp Backend API',
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    chats_count: Object.keys(chats).length
  });
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy',
    timestamp: new Date().toISOString(),
    service: 'WhatsApp Business API',
    version: '1.0.0',
    environment: process.env.NODE_ENV || 'development'
  });
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    service: 'WhatsApp Business API Backend',
    status: 'running',
    version: '1.0.0',
    endpoints: {
      webhook: '/webhook (GET/POST)',
      chats: '/api/chats (GET)',
      send: '/api/send (POST)',
      health: '/health (GET)',
      ping: '/ping (GET)'
    },
    documentation: 'Connect frontend to this API'
  });
});

// Socket.IO connection handler
io.on('connection', (socket) => {
  console.log('🔌 New client connected:', socket.id);
  
  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

// Initialize database
initializeDatabase().then(() => {
  console.log('📊 Database ready');
});

// Auto cleanup every 30 minutes
setInterval(cleanupOldData, 30 * 60 * 1000);

const PORT = process.env.PORT || 10000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 WhatsApp Backend Server started`);
  console.log(`📍 Port: ${PORT}`);
  console.log(`🌐 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`📞 Endpoint: http://localhost:${PORT}`);
  console.log(`🔧 Ready to receive webhooks from WhatsApp`);
});
