import os
import logging
from dotenv import load_dotenv
from telegram import Update, InlineKeyboardMarkup, InlineKeyboardButton
from telegram.ext import Application, CommandHandler, MessageHandler, filters, ContextTypes
import aiohttp
import pymongo
from pymongo.errors import ConnectionFailure
import asyncio
from urllib.parse import urlparse, parse_qs
import re

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

# MongoDB client
client = None
users_collection = None
db_connected = False

# Connect to MongoDB
async def connect_to_database():
    global client, users_collection, db_connected
    
    if not MONGO_URI:
        logger.warning("⚠️ No MONGO_URI provided. Database functionality will be disabled.")
        return
    
    try:
        client = pymongo.MongoClient(MONGO_URI, serverSelectionTimeoutMS=5000)
        # Test the connection
        client.admin.command('ping')
        users_collection = client["telegramBot"]["users"]
        db_connected = True
        logger.info("📂 Connected to MongoDB")
    except ConnectionFailure as e:
        logger.error(f"MongoDB connection error: {e}")
        logger.warning("⚠️ Running without database connection")

# Check if user is member of the channel
async def is_user_member(context, user_id):
    try:
        chat_member = await context.bot.get_chat_member(CHANNEL_USERNAME, user_id)
        return chat_member.status in ["member", "administrator", "creator"]
    except Exception as e:
        logger.error(f"Error checking membership: {e}")
        return False

# Save user to database
async def save_user(user_id, username):
    if not db_connected:
        return
    
    try:
        users_collection.update_one(
            {"userId": user_id},
            {"$set": {"userId": user_id, "username": username, "lastActive": pymongo.datetime.datetime.utcnow()}},
            upsert=True
        )
    except Exception as e:
        logger.error(f"Error saving user: {e}")

# Extract TeraBox ID from link
def extract_terabox_id(text):
    # Try to extract ID from URL path
    match = re.search(r'/s/([a-zA-Z0-9_-]+)', text)
    if match:
        return match.group(1)
    
    # If not found, try to extract from query parameters
    try:
        parsed_url = urlparse(text)
        query_params = parse_qs(parsed_url.query)
        if 'surl' in query_params:
            return query_params['surl'][0]
    except:
        pass
    
    # If still not found, return the text as is (might be a direct ID)
    return text.strip()

# Send message to dump channel
async def send_to_dump_channel(context, message):
    if not DUMP_CHANNEL_ID:
        return
    
    try:
        await context.bot.send_message(DUMP_CHANNEL_ID, message)
    except Exception as e:
        logger.error(f"Error sending to dump channel: {e}")

# Fetch video from primary or fallback API
async def fetch_video(video_id):
    async with aiohttp.ClientSession() as session:
        # Try primary API first
        try:
            async with session.get(f"{PRIMARY_API_URL}{video_id}", timeout=15) as response:
                if response.status == 200:
                    data = await response.json()
                    if data and data.get("success") == True:
                        return {"success": True, "data": data.get("data"), "source": "primary"}
                
                raise Exception("Primary API failed")
        except Exception as primary_error:
            logger.info("Primary API failed, trying fallback...")
            
            # Try fallback API
            try:
                async with session.get(f"{FALLBACK_API_URL}{video_id}", timeout=15) as fallback_response:
                    if fallback_response.status == 200:
                        fallback_data = await fallback_response.json()
                        if fallback_data and fallback_data.get("success") == True:
                            return {"success": True, "data": fallback_data.get("data"), "source": "fallback"}
                    
                    return {"success": False, "error": "Both APIs failed to fetch the video"}
            except Exception as fallback_error:
                logger.error(f"Fallback API error: {fallback_error}")
                return {"success": False, "error": "Both APIs failed to fetch the video"}

# Command handlers
async def start(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    await update.message.reply_text(
        "Welcome to TeraBox Downloader Bot! 🎬\n\nSend me a TeraBox link or Video ID, and I'll download it for you."
    )

async def help_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    await update.message.reply_text(
        "🔍 *How to use this bot:*\n\n" +
        f"1. Join our channel: {CHANNEL_USERNAME}\n" +
        "2. Send a TeraBox link (e.g., https://terabox.com/s/abc123)\n" +
        "3. Wait for the bot to process and download your video\n\n" +
        "If you have any issues, please try again later.",
        parse_mode="Markdown"
    )

# Handle text messages
async def handle_text(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    user_id = update.effective_user.id
    username = update.effective_user.username or "Unknown"
    
    # Check if user is member of the channel
    if not await is_user_member(context, user_id):
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
        file_size = int(result["data"].get("size", 0))
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
        if file_size > 50000000:  # 50MB limit
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
            async with aiohttp.ClientSession() as session:
                async with session.get(download_url, timeout=30) as response:
                    if response.status == 200:
                        # Read the content into memory
                        video_content = await response.read()
                        
                        # Send the video
                        await context.bot.send_video(
                            chat_id=update.effective_chat.id,
                            video=video_content,
                            filename=file_name,
                            caption=f"📁 {file_name}\n🔗 Downloaded with @{context.bot.username}",
                            disable_notification=True
                        )
                        
                        await send_to_dump_channel(context, f"✅ Download successful: {file_size_mb}MB\nUser: @{username} ({user_id})")
                    else:
                        raise Exception(f"Download failed with status code: {response.status}")
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
    except Exception as e:
        logger.error(f"Error processing request: {e}")
        try:
            await context.bot.delete_message(chat_id=update.effective_chat.id, message_id=processing_msg.message_id)
        except:
            pass
        await update.message.reply_text("❌ Something went wrong. Try again later.")

async def main() -> None:
    # Connect to database
    await connect_to_database()
    
    # Create the Application
    application = Application.builder().token(BOT_TOKEN).build()

    # Add handlers
    application.add_handler(CommandHandler("start", start))
    application.add_handler(CommandHandler("help", help_command))
    application.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_text))

    # Start the Bot
    if os.getenv("NODE_ENV") == "production":
        if not WEBHOOK_URL:
            logger.error("❌ WEBHOOK_URL is not set in production mode!")
            return
        
        logger.info(f"🌐 Starting bot in webhook mode: {WEBHOOK_URL}")
        application.run_webhook(
            listen="0.0.0.0",
            port=PORT,
            url_path=BOT_TOKEN,
            webhook_url=f"{WEBHOOK_URL}/{BOT_TOKEN}"
        )
    else:
        logger.info("🔄 Starting bot in polling mode...")
        await application.initialize()
        await application.start_polling()
        
    logger.info("🚀 TeraBox Video Bot is running...")

if __name__ == "__main__":
    asyncio.run(main())
