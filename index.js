require("dotenv").config();
const { Telegraf } = require("telegraf");
const axios = require("axios");
const { MongoClient } = require("mongodb");
const https = require("https");

// Bot configuration
const bot = new Telegraf(process.env.BOT_TOKEN);
const PRIMARY_API_URL = "https://alphaapis.org/terabox/v3/dl?id=";
const FALLBACK_API_URL = "https://muddy-flower-20ec.arjunavai273.workers.dev/?id=";
const CHANNEL_USERNAME = process.env.CHANNEL_USERNAME || "@awt_bots";
const DUMP_CHANNEL_ID = process.env.DUMP_CHANNEL_ID; // Add to .env file
const MONGO_URI = process.env.MONGO_URI;
const PORT = process.env.PORT || 3000;

// Create HTTP agent for faster persistent connections
const agent = new https.Agent({ keepAlive: true, maxSockets: 10 });

// MongoDB connection
const client = new MongoClient(MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true });
let usersCollection;

// Connect to MongoDB
async function connectToDatabase() {
    try {
        await client.connect();
        usersCollection = client.db("telegramBot").collection("users");
        console.log("📂 Connected to MongoDB");
    } catch (error) {
        console.error("MongoDB connection error:", error);
    }
}

// Check if user is member of the channel
async function isUserMember(userId) {
    try {
        const chatMember = await bot.telegram.getChatMember(CHANNEL_USERNAME, userId);
        return ["member", "administrator", "creator"].includes(chatMember.status);
    } catch (error) {
        console.error("Error checking membership:", error.message);
        return false;
    }
}

// Save user to database
async function saveUser(userId, username) {
    try {
        await usersCollection.updateOne(
            { userId }, 
            { $set: { userId, username, lastActive: new Date() } }, 
            { upsert: true }
        );
    } catch (error) {
        console.error("Error saving user:", error);
    }
}

// Extract TeraBox ID from link
function extractTeraboxId(text) {
    const match = text.match(/\/s\/([a-zA-Z0-9_-]+)/);
    return match ? match[1] : text.trim();
}

// Send message to dump channel
async function sendToDumpChannel(message) {
    if (!DUMP_CHANNEL_ID) return;
    try {
        await bot.telegram.sendMessage(DUMP_CHANNEL_ID, message);
    } catch (error) {
        console.error("Error sending to dump channel:", error.message);
    }
}

// Fetch video from primary or fallback API
async function fetchVideo(videoId) {
    try {
        // Try primary API first
        const response = await axios.get(`${PRIMARY_API_URL}${videoId}`, { 
            httpsAgent: agent,
            timeout: 15000 // 15 seconds timeout
        });
        
        if (response.data && response.data.success === true) {
            return { success: true, data: response.data.data, source: "primary" };
        }
        
        throw new Error("Primary API failed");
    } catch (primaryError) {
        console.log("Primary API failed, trying fallback...");
        
        try {
            // Try fallback API
            const fallbackResponse = await axios.get(`${FALLBACK_API_URL}${videoId}`, { 
                httpsAgent: agent,
                timeout: 15000
            });
            
            if (fallbackResponse.data && fallbackResponse.data.success === true) {
                return { success: true, data: fallbackResponse.data.data, source: "fallback" };
            }
            
            return { success: false, error: "Both APIs failed to fetch the video" };
        } catch (fallbackError) {
            console.error("Fallback API error:", fallbackError.message);
            return { success: false, error: "Both APIs failed to fetch the video" };
        }
    }
}

// Bot commands
bot.start((ctx) => {
    ctx.reply("Welcome to TeraBox Downloader Bot! 🎬\n\nSend me a TeraBox link or Video ID, and I'll download it for you.");
});

bot.help((ctx) => {
    ctx.reply(
        "🔍 *How to use this bot:*\n\n" +
        "1. Join our channel: " + CHANNEL_USERNAME + "\n" +
        "2. Send a TeraBox link (e.g., https://terabox.com/s/abc123)\n" +
        "3. Wait for the bot to process and download your video\n\n" +
        "If you have any issues, please try again later.",
        { parse_mode: "Markdown" }
    );
});

// Handle text messages
bot.on("text", async (ctx) => {
    const userId = ctx.from.id;
    const username = ctx.from.username || "Unknown";
    
    // Check if user is member of the channel
    if (!(await isUserMember(userId))) {
        return ctx.reply(`❌ You must join ${CHANNEL_USERNAME} to use this bot.`, {
            reply_markup: {
                inline_keyboard: [
                    [{ text: "Join Channel", url: `https://t.me/${CHANNEL_USERNAME.replace("@", "")}` }]
                ]
            }
        });
    }
    
    // Save user data
    await saveUser(userId, username);

    const text = ctx.message.text.trim();
    const videoId = extractTeraboxId(text);

    if (!videoId) {
        return ctx.reply("❌ Invalid TeraBox link. Please send a correct link or ID.");
    }

    console.log("User:", username, "ID:", userId, "Requested video:", videoId);
    await sendToDumpChannel(`🔍 New request:\nUser: @${username} (${userId})\nVideo ID: ${videoId}`);
    
    const processingMsg = await ctx.reply("⏳ Fetching video link...");

    try {
        // Fetch video details
        const result = await fetchVideo(videoId);
        
        if (!result.success) {
            await ctx.telegram.deleteMessage(ctx.chat.id, processingMsg.message_id);
            return ctx.reply("❌ Failed to fetch video. Please check the link or try again later.");
        }

        const downloadUrl = result.data.downloadLink;
        const fileSize = parseInt(result.data.size, 10) || 0;
        const fileName = result.data.filename || "terabox_video";

        console.log("Download URL found from", result.source, "API");

        if (!downloadUrl) {
            await ctx.telegram.deleteMessage(ctx.chat.id, processingMsg.message_id);
            return ctx.reply("❌ No download link found.");
        }

        // Check if file is too large for Telegram
        const fileSizeMB = (fileSize / (1024 * 1024)).toFixed(2);
        if (fileSize > 50000000) {
            await ctx.telegram.deleteMessage(ctx.chat.id, processingMsg.message_id);
            await sendToDumpChannel(`⚠️ Large file requested: ${fileSizeMB}MB\nUser: @${username} (${userId})`);
            return ctx.reply(
                `🚨 File is too large for Telegram (${fileSizeMB}MB)!\n\n` +
                `📥 Download directly: ${downloadUrl}`
            );
        }

        await ctx.reply(`✅ Video found! (${fileSizeMB}MB)\n🔄 Downloading...`);

        // Stream video directly to Telegram without saving to disk
        try {
            const videoStream = await axios({
                method: "GET",
                url: downloadUrl,
                responseType: "stream",
                timeout: 30000, // 30 seconds timeout
                httpsAgent: agent
            });

            await ctx.replyWithVideo(
                { source: videoStream.data, filename: fileName }, 
                { 
                    caption: `📁 ${fileName}\n🔗 Downloaded with @${bot.botInfo.username}`,
                    disable_notification: true 
                }
            );

            await sendToDumpChannel(`✅ Download successful: ${fileSizeMB}MB\nUser: @${username} (${userId})`);
        } catch (downloadError) {
            console.error("Download error:", downloadError.message);
            await ctx.reply(
                `⚠️ Download failed, but you can try directly:\n${downloadUrl}`
            );
            await sendToDumpChannel(`❌ Download failed for user: @${username} (${userId})`);
        }

        await ctx.telegram.deleteMessage(ctx.chat.id, processingMsg.message_id);
    } catch (error) {
        console.error("Error processing request:", error.message);
        await ctx.telegram.deleteMessage(ctx.chat.id, processingMsg.message_id);
        ctx.reply("❌ Something went wrong. Try again later.");
    }
});

// Setup for Koyeb compatibility
const startBot = async () => {
    await connectToDatabase();
    
    // Start the bot in webhook mode for Koyeb
    if (process.env.NODE_ENV === 'production') {
        const WEBHOOK_URL = process.env.WEBHOOK_URL;
        
        // Set webhook
        await bot.telegram.setWebhook(WEBHOOK_URL);
        console.log(`🌐 Bot webhook set to ${WEBHOOK_URL}`);
        
        // Start webhook
        bot.startWebhook('/', null, PORT);
    } else {
        // Start in polling mode for development
        bot.launch();
    }
    
    console.log("🚀 TeraBox Video Bot is running...");
};

// Handle shutdown gracefully
process.once('SIGINT', () => {
    bot.stop('SIGINT');
    client.close();
});

process.once('SIGTERM', () => {
    bot.stop('SIGTERM');
    client.close();
});

// Start the bot
startBot();
