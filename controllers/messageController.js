const db = require("../config/db");
const { io } = require("../server");

/* --------------------------------------
   1) Detect Message Type + Extract Text
--------------------------------------- */
function extractMessageContent(msg) {
  let content = "[Media/File Message]";
  let mediaUrl = null;

  if (msg.type === "text" && msg.text?.body) {
    content = msg.text.body;
  }
  else if (msg.type === "image" && msg.image?.link) {
    mediaUrl = msg.image.link;
    content = `[Image] ${mediaUrl}`;
  }
  else if (msg.type === "audio" && msg.audio?.link) {
    mediaUrl = msg.audio.link;
    content = `[Audio] ${mediaUrl}`;
  }
  else if (msg.type === "video" && msg.video?.link) {
    mediaUrl = msg.video.link;
    content = `[Video] ${mediaUrl}`;
  }
  else if (msg.type === "document" && msg.document?.link) {
    mediaUrl = msg.document.link;
    content = `[Document] ${mediaUrl}`;
  }
  else if (msg.type === "sticker" && msg.sticker?.link) {
    mediaUrl = msg.sticker.link;
    content = `[Sticker] ${mediaUrl}`;
  }

  return { content, mediaUrl };
}

/* --------------------------------------
   2) Incoming Message Handler
--------------------------------------- */
async function processIncomingMessage(msg) {
  try {
    console.log("📥 Incoming Message:", msg);

    const phone = msg.from;
    const timestamp = new Date(msg.timestamp * 1000);

    // Extract content
    const { content, mediaUrl } = extractMessageContent(msg);

    // 1️⃣ Ensure Contact Exists
    const contact = await db.findOrCreateContact(phone);

    // 2️⃣ Ensure Chat Exists
    const chat = await db.findOrCreateChat(contact.id, phone);

    // 3️⃣ Save Incoming Message
    const saved = await db.addMessage(chat.id, contact.id, {
      type: "received",
      content: content,
      media_url: mediaUrl,
      media_type: mediaUrl ? msg.type : null,
      whatsappMessageId: msg.id,
      timestamp: timestamp,
      status: "delivered"
    });

    console.log("💾 Saved Incoming Message:", saved.id);

    // 4️⃣ SOCKET.IO → Send to Dashboard
    io.emit("new_message", {
      from: phone,
      message: content,
      mediaUrl,
      type: "received",
      timestamp,
      contactName: contact.name,
      messageId: saved.id,
      source: "whatsapp"
    });

    console.log("📡 Dashboard Updated via Socket.io");
    return true;

  } catch (err) {
    console.error("❌ processIncomingMessage ERROR:", err);
    return false;
  }
}


/* --------------------------------------
   3) Outgoing Message Handler (from n8n)
--------------------------------------- */
async function processOutgoingMessage(data) {
  try {
    console.log("📤 Saving Outgoing Message:", data);

    const to = data.to;
    const content = data.message || "[Media]";
    const media_url = data.mediaUrl || null;
    const media_type = media_url ? "media" : null;

    // 1️⃣ Ensure Contact Exists
    const contact = await db.findOrCreateContact(to);

    // 2️⃣ Ensure Chat Exists
    const chat = await db.findOrCreateChat(contact.id, to);

    // 3️⃣ Save Outgoing Message
    const saved = await db.query(
      `INSERT INTO messages 
        (chat_id, contact_id, message_type, content, media_url, media_type, whatsapp_message_id, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING id`,
      [
        chat.id,
        contact.id,
        "sent",
        content,
        media_url,
        media_type,
        data.messageId || null,
        "sent"
      ]
    );

    // 4️⃣ Update Chat Last Message
    await db.query(
      `UPDATE chats SET last_message=$1, last_message_at=NOW() WHERE id=$2`,
      [content, chat.id]
    );

    // 5️⃣ Socket Emit (Dashboard)
    io.emit("new_message", {
      from: to,
      message: content,
      type: "sent",
      mediaUrl: media_url,
      timestamp: new Date(),
      messageId: saved.rows[0].id,
      source: "n8n"
    });

    console.log("📡 Dashboard Updated From Outgoing Message");
    return true;

  } catch (err) {
    console.error("❌ processOutgoingMessage ERROR:", err);
    return false;
  }
}

module.exports = {
  processIncomingMessage,
  processOutgoingMessage
};
