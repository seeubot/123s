import os
import logging
from dotenv import load_dotenv
import http.client
import requests
from telegram import Update, InlineKeyboardMarkup, InlineKeyboardButton
from telegram.ext import Application, CommandHandler, MessageHandler, filters, ContextTypes
from pymongo import MongoClient
import re
from urllib.parse import urlparse

# Configure logging
logging.basicConfig(
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s", level=logging.INFO
)
logger = logging.getLogger(__name__)

# Load environment variables
load_dotenv()

# Bot configuration
BOT_TOKEN = os.getenv("BOT_TOKEN")
PRIMARY_API_URL = "https://alphaapis.org/terabox/v3/dl?id="
FALLBACK_API_URL = "https://muddy-flower-20ec.arjunavai273.workers.dev/?id="
CHANNEL_USERNAME = os.getenv("CHANNEL_USERNAME", "@terao2")
DUMP_CHANNEL_ID = os.getenv("DUMP_CHANNEL_ID")
MONGO_URI = os.getenv("MONGO_URI")
PORT = int(os.getenv("PORT", 8443))
WEBHOOK_URL = os.getenv("WEBHOOK_URL")

# MongoDB connection
client = None
users_collection = None
db_connected = False

# Initialize MongoDB client if MONGO_URI is provided
if MONGO_URI:
    try:
        client = MongoClient(MONGO_URI, serverSelectionTimeoutMS=5000)
        users_collection = client.telegramBot.users
        db_connected = True
        logger.info("📂 Connected to MongoDB")
    except Exception as e:
        logger.error(f"MongoDB connection error: {e}")
        logger.warning("⚠️ Running without database connection")
else:
    logger.warning("⚠️ No MONGO_URI provided. Database functionality will be disabled.")

# Function to check if user is member of the channel
async def is_user_member(update: Update, context: ContextTypes.DEFAULT_TYPE) -> bool:
    try:
        user_id = update.effective_user.id
        chat_member = await context.bot.get_chat_member(chat_id=CHANNEL_USERNAME, user_id=user_id)
        return chat_member.status in ["member", "administrator", "creator"]
    except Exception as e:
        logger.error(f"Error checking membership: {e}")
        return False

# Function to save user to database
async def save_user(user_id, username):
    if not db_connected:
        return
    
    try:
        users_collection.update_one(
            {"userId": user_id},
            {"$set": {"userId": user_id, "username": username, "lastActive": "NOW()"}},
            upsert=True
        )
    except Exception as e:
        logger.error(f"Error saving user: {e}")

# Function to extract TeraBox ID from link
def extract_terabox_id(text):
    match = re.search(r"/s/([a-zA-Z0-9_-]+)", text)
    return match.group(1) if match else text.strip()

# Function to send message to dump channel
async def send_to_dump_channel(context: ContextTypes.DEFAULT_TYPE, message):
    if not DUMP_CHANNEL_ID:
        return
    
    try:
        await context.bot.send_message(chat_id=DUMP_CHANNEL_ID, text=message)
    except Exception as e:
        logger.error(f"Error sending to dump channel: {e}")

# Function to fetch video from primary or fallback API
async def fetch_video(video_id):
    try:
        # Try primary API first
        response = requests.get(f"{PRIMARY_API_URL}{video_id}", timeout=15)
        response_data = response.json()
        
        if response_data and response_data.get('success') == True:
            return {"success": True, "data": response_data.get('data'), "source": "primary"}
        
        raise Exception("Primary API failed")
    except Exception as primary_error:
        logger.info("Primary API failed, trying fallback...")
        
        try:
            # Try fallback API
            fallback_response = requests.get(f"{FALLBACK_API_URL}{video_id}", timeout=15)
            fallback_data = fallback_response.json()
            
            if fallback_data and fallback_data.get('success') == True:
                return {"success": True, "data": fallback_data.get('data'), "source": "fallback"}
            
            return {"success": False, "error": "Both APIs failed to fetch the video"}
        except Exception as fallback_error:
            logger.error(f"Fallback API error: {fallback_error}")
            return {"success": False, "error": "Both APIs failed to fetch the video"}

# Command handlers
async def start(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    await update.message.reply_text("Welcome to TeraBox Downloader Bot! 🎬\n\nSend me a TeraBox link or Video ID, and I'll download it for you.")

async def help_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    await update.message.reply_text(
        "🔍 *How to use this bot:*\n\n" +
        "1. Join our channel: " + CHANNEL_USERNAME + "\n" +
        "2. Send a TeraBox link (e.g., https://terabox.com/s/abc123)\n" +
        "3. Wait for the bot to process and download your video\n\n" +
        "If you have any issues, please try again later.",
        parse_mode="Markdown"
    )

# Handle text messages
async def handle_message(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    user_id = update.effective_user.id
    username = update.effective_user.username or "Unknown"
    
    # Check if user is member of the channel
    if not await is_user_member(update, context):
        keyboard = [[InlineKeyboardButton("Join Channel", url=f"https://t.me/{CHANNEL_USERNAME.replace('@', '')}")]]
        reply_markup = InlineKeyboardMarkup(keyboard)
        await update.message.reply_text(
            f"❌ You must join {CHANNEL_USERNAME} to use this bot.",
            reply_markup=reply_markup
        )
        return
    
    # Save user data
    await save_user(user_id, username)

    text = update.message.text.strip()
    video_id = extract_terabox_id(text)

    if not video_id:
        await update.message.reply_text("❌ Invalid TeraBox link. Please send a correct link or ID.")
        return

    logger.info(f"User: {username}, ID: {user_id}, Requested video: {video_id}")
    await send_to_dump_channel(context, f"🔍 New request:\nUser: @{username} ({user_id})\nVideo ID: {video_id}")
    
    processing_msg = await update.message.reply_text("⏳ Fetching video link...")

    try:
        # Fetch video details
        result = await fetch_video(video_id)
        
        if not result["success"]:
            try:
                await context.bot.delete_message(chat_id=update.effective_chat.id, message_id=processing_msg.message_id)
            except:
                pass
            await update.message.reply_text("❌ Failed to fetch video. Please check the link or try again later.")
            return

        download_url = result["data"].get("downloadLink")
        file_size = int(result["data"].get("size", 0)) or 0
        file_name = result["data"].get("filename", "terabox_video")

        logger.info(f"Download URL found from {result['source']} API")

        if not download_url:
            try:
                await context.bot.delete_message(chat_id=update.effective_chat.id, message_id=processing_msg.message_id)
            except:
                pass
            await update.message.reply_text("❌ No download link found.")
            return

        # Check if file is too large for Telegram
        file_size_mb = round(file_size / (1024 * 1024), 2)
        if file_size > 50000000:  # 50MB limit for Telegram
            try:
                await context.bot.delete_message(chat_id=update.effective_chat.id, message_id=processing_msg.message_id)
            except:
                pass
            await send_to_dump_channel(context, f"⚠️ Large file requested: {file_size_mb}MB\nUser: @{username} ({user_id})")
            await update.message.reply_text(
                f"🚨 File is too large for Telegram ({file_size_mb}MB)!\n\n" +
                f"📥 Download directly: {download_url}"
            )
            return

        await update.message.reply_text(f"✅ Video found! ({file_size_mb}MB)\n🔄 Downloading...")

        # Download and send the video
        try:
            response = requests.get(download_url, stream=True, timeout=30)
            if response.status_code == 200:
                await context.bot.send_video(
                    chat_id=update.effective_chat.id,
                    video=response.content,
                    filename=file_name,
                    caption=f"📁 {file_name}\n🔗 Downloaded with @{context.bot.username}",
                    disable_notification=True
                )
                await send_to_dump_channel(context, f"✅ Download successful: {file_size_mb}MB\nUser: @{username} ({user_id})")
            else:
                raise Exception(f"Failed to download with status code: {response.status_code}")

        except Exception as download_error:
            logger.error(f"Download error: {download_error}")
            await update.message.reply_text(
                f"⚠️ Download failed, but you can try directly:\n{download_url}"
            )
            await send_to_dump_channel(context, f"❌ Download failed for user: @{username} ({user_id})")
        
        try:
            await context.bot.delete_message(chat_id=update.effective_chat.id, message_id=processing_msg.message_id)
        except:
            pass
            
    except Exception as error:
        logger.error(f"Error processing request: {error}")
        try:
            await context.bot.delete_message(chat_id=update.effective_chat.id, message_id=processing_msg.message_id)
        except:
            pass
        await update.message.reply_text("❌ Something went wrong. Try again later.")

def main():
    # Create the Application
    application = Application.builder().token(BOT_TOKEN).build()

    # Add handlers
    application.add_handler(CommandHandler("start", start))
    application.add_handler(CommandHandler("help", help_command))
    application.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_message))

    # Run the bot using webhook in production, or polling in development
    if os.getenv("NODE_ENV") == 'production' and WEBHOOK_URL:
        application.run_webhook(
            listen="0.0.0.0",
            port=PORT,
            url_path=BOT_TOKEN,
            webhook_url=f"{WEBHOOK_URL}/{BOT_TOKEN}"
        )
        logger.info(f"🌐 Bot webhook set to {WEBHOOK_URL}")
        logger.info(f"🚀 Webhook server running on port {PORT}")
    else:
        # Start in polling mode for development
        logger.info("🔄 Starting bot in polling mode...")
        application.run_polling()

    logger.info("🚀 TeraBox Video Bot is running...")

if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        logger.error(f"Failed to start bot: {e}")
        if db_connected and client:
            client.close()
