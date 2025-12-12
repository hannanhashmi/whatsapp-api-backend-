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

module.exports = {
  pool,
  initializeDatabase,
  query: (text, params) => pool.query(text, params)
};

