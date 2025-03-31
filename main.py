import os
import logging
import time
import asyncio
from dotenv import load_dotenv
import requests
from telegram import Update, InlineKeyboardMarkup, InlineKeyboardButton
from telegram.ext import Application, CommandHandler, MessageHandler, filters, ContextTypes, CallbackQueryHandler
from telegram.error import NetworkError, TelegramError
from pymongo import MongoClient
import re
import io
import json

# Configure logging
logging.basicConfig(
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s", 
    level=logging.INFO,
    handlers=[
        logging.FileHandler("bot.log"),
        logging.StreamHandler()
    ]
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
WELCOME_VIDEO_REPO_URL = os.getenv("WELCOME_VIDEO_REPO_URL", "https://github.com/seeubot/Terabox/blame/main/tera.mp4")
ADMIN_IDS = list(map(int, os.getenv("ADMIN_IDS", "1352497419").split(","))) if os.getenv("ADMIN_IDS") else []

# MongoDB connection
client = None
users_collection = None
stats_collection = None
db_connected = False

# Set up a connection checker for MongoDB
def check_db_connection():
    global db_connected
    if not client:
        return False
    
    try:
        # The ismaster command is cheap and does not require auth
        client.admin.command('ismaster')
        if not db_connected:
            logger.info("📂 Reconnected to MongoDB")
            db_connected = True
        return True
    except Exception as e:
        if db_connected:
            logger.error(f"MongoDB connection lost: {e}")
            db_connected = False
        return False

# Initialize MongoDB client if MONGO_URI is provided
if MONGO_URI:
    try:
        client = MongoClient(MONGO_URI, serverSelectionTimeoutMS=5000)
        db = client.telegramBot
        users_collection = db.users
        stats_collection = db.stats
        db_connected = check_db_connection()
        if db_connected:
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
        # If we can't check, assume they are a member to prevent blocking users unnecessarily
        return True

# Function to check if user is an admin
def is_admin(user_id):
    return user_id in ADMIN_IDS

# Function to save user to database with retry
async def save_user(user_id, username, retry=3):
    if not db_connected:
        check_db_connection()
        if not db_connected:
            return
    
    while retry > 0:
        try:
            users_collection.update_one(
                {"userId": user_id},
                {"$set": {"userId": user_id, "username": username, "lastActive": time.time()}},
                upsert=True
            )
            # Update stats
            stats_collection.update_one(
                {"stat": "user_activity"},
                {"$inc": {"count": 1}},
                upsert=True
            )
            return
        except Exception as e:
            retry -= 1
            logger.error(f"Error saving user (retries left: {retry}): {e}")
            time.sleep(1)
            if retry == 0:
                logger.error(f"Failed to save user after retries: {user_id}")

# Function to log activity stats
async def log_activity(activity_type, success=True):
    if not db_connected:
        return
    
    try:
        stats_collection.update_one(
            {"stat": activity_type},
            {"$inc": {"success" if success else "failure": 1, "total": 1}},
            upsert=True
        )
    except Exception as e:
        logger.error(f"Error logging activity: {e}")

# Function to extract TeraBox ID from link
def extract_terabox_id(text):
    # Handle multiple formats of TeraBox links
    match = re.search(r"/s/([a-zA-Z0-9_-]+)", text)
    if match:
        return match.group(1)
    
    # Check if it's a full URL with ID as query parameter
    query_match = re.search(r"id=([a-zA-Z0-9_-]+)", text)
    if query_match:
        return query_match.group(1)
    
    # If no patterns match, return the original text stripped
    return text.strip()

# Enhanced function to send message/file to dump channel with retries
async def send_to_dump_channel(context: ContextTypes.DEFAULT_TYPE, content, is_text=True, caption=None, file_type=None, retries=3):
    if not DUMP_CHANNEL_ID:
        return
    
    retry_count = 0
    while retry_count < retries:
        try:
            if is_text:
                await context.bot.send_message(chat_id=DUMP_CHANNEL_ID, text=content)
                return True
            else:
                if file_type == "photo":
                    await context.bot.send_photo(chat_id=DUMP_CHANNEL_ID, photo=content, caption=caption)
                elif file_type == "video":
                    # Check if content is bytes or file_id
                    if isinstance(content, bytes):
                        await context.bot.send_video(
                            chat_id=DUMP_CHANNEL_ID, 
                            video=io.BytesIO(content), 
                            caption=caption
                        )
                    else:
                        await context.bot.send_video(
                            chat_id=DUMP_CHANNEL_ID, 
                            video=content, 
                            caption=caption
                        )
                elif file_type == "document":
                    await context.bot.send_document(chat_id=DUMP_CHANNEL_ID, document=content, caption=caption)
                elif file_type == "audio":
                    await context.bot.send_audio(chat_id=DUMP_CHANNEL_ID, audio=content, caption=caption)
                return True
        except NetworkError as ne:
            logger.warning(f"Network error sending to dump channel (retry {retry_count+1}/{retries}): {ne}")
            retry_count += 1
            await asyncio.sleep(2)  # Wait before retrying
        except TelegramError as te:
            logger.error(f"Telegram error sending to dump channel: {te}")
            return False
        except Exception as e:
            logger.error(f"Error sending to dump channel: {e}")
            return False
    
    logger.error(f"Failed to send to dump channel after {retries} retries")
    return False

# Function to fetch video from primary or fallback API with retries
async def fetch_video(video_id, max_retries=3):
    primary_retries = max_retries
    while primary_retries > 0:
        try:
            # Try primary API
            response = requests.get(f"{PRIMARY_API_URL}{video_id}", timeout=15)
            response_data = response.json()
            
            if response_data and response_data.get('success') == True:
                return {"success": True, "data": response_data.get('data'), "source": "primary"}
            
            # If API responded but with error, break out to try fallback
            break
        except requests.exceptions.Timeout:
            logger.warning(f"Primary API timeout (retries left: {primary_retries-1})")
            primary_retries -= 1
            if primary_retries > 0:
                time.sleep(2)  # Wait before retry
        except Exception as primary_error:
            logger.warning(f"Primary API error: {primary_error}")
            break
    
    logger.info("Primary API failed or timed out, trying fallback...")
    
    fallback_retries = max_retries
    while fallback_retries > 0:
        try:
            # Try fallback API
            fallback_response = requests.get(f"{FALLBACK_API_URL}{video_id}", timeout=15)
            fallback_data = fallback_response.json()
            
            if fallback_data and fallback_data.get('success') == True:
                return {"success": True, "data": fallback_data.get('data'), "source": "fallback"}
            
            # If API responded but with error, break out
            break
        except requests.exceptions.Timeout:
            logger.warning(f"Fallback API timeout (retries left: {fallback_retries-1})")
            fallback_retries -= 1
            if fallback_retries > 0:
                time.sleep(2)  # Wait before retry
        except Exception as fallback_error:
            logger.error(f"Fallback API error: {fallback_error}")
            break
    
    return {"success": False, "error": "Both APIs failed to fetch the video"}

# Function to fetch welcome video from repo with retry mechanism
async def fetch_welcome_video(retries=3):
    for attempt in range(retries):
        try:
            response = requests.get(WELCOME_VIDEO_REPO_URL, stream=True, timeout=30)
            if response.status_code == 200:
                return response.content
            logger.error(f"Failed to fetch welcome video. Status code: {response.status_code}")
        except Exception as e:
            logger.error(f"Error fetching welcome video (attempt {attempt+1}/{retries}): {e}")
        
        if attempt < retries - 1:
            time.sleep(2)  # Wait before retry
    
    return None

# Function to broadcast message to all users with progress tracking
async def broadcast_message(context: ContextTypes.DEFAULT_TYPE, message_text, send_by=None, batch_size=100, delay=1):
    if not db_connected:
        logger.error("Cannot broadcast: No database connection")
        return {"success": False, "error": "No database connection"}
    
    success_count = 0
    fail_count = 0
    
    total_users = users_collection.count_documents({})
    
    # Process users in batches to avoid memory issues with large user bases
    cursor = users_collection.find({})
    batch = []
    processed = 0
    
    for user in cursor:
        batch.append(user)
        
        if len(batch) >= batch_size:
            # Process the batch
            for user_doc in batch:
                try:
                    user_id = user_doc.get("userId")
                    if user_id:
                        await context.bot.send_message(
                            chat_id=user_id,
                            text=f"{message_text}\n\n{f'Message from: {send_by}' if send_by else ''}"
                        )
                        success_count += 1
                except Exception as e:
                    logger.error(f"Failed to send broadcast to {user_doc.get('userId')}: {e}")
                    fail_count += 1
            
            # Clear batch and add delay to avoid hitting rate limits
            batch = []
            processed += batch_size
            logger.info(f"Broadcast progress: {processed}/{total_users}")
            await asyncio.sleep(delay)
    
    # Process remaining users
    for user_doc in batch:
        try:
            user_id = user_doc.get("userId")
            if user_id:
                await context.bot.send_message(
                    chat_id=user_id,
                    text=f"{message_text}\n\n{f'Message from: {send_by}' if send_by else ''}"
                )
                success_count += 1
        except Exception as e:
            logger.error(f"Failed to send broadcast to {user_doc.get('userId')}: {e}")
            fail_count += 1
    
    await log_activity("broadcast", success=(success_count > 0))
    
    return {
        "success": True,
        "total": total_users,
        "sent": success_count,
        "failed": fail_count
    }

# Command handlers
async def start(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    user_id = update.effective_user.id
    username = update.effective_user.username or "Unknown"
    
    # Save user data
    await save_user(user_id, username)
    
    # Log new user
    await send_to_dump_channel(context, f"🆕 New user joined: @{username} ({user_id})")
    
    # Fetch and send welcome video
    welcome_video = await fetch_welcome_video()
    if welcome_video:
        await update.message.reply_video(
            video=welcome_video,
            caption="Welcome to TeraBox Downloader Bot! 🎬\n\nSend me a TeraBox link or Video ID, and I'll download it for you."
        )
    else:
        await update.message.reply_text("Welcome to TeraBox Downloader Bot! 🎬\n\nSend me a TeraBox link or Video ID, and I'll download it for you.")
    
    await log_activity("start_command")

async def help_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    await update.message.reply_text(
        "🔍 *How to use this bot:*\n\n" +
        "1. Join our channel: " + CHANNEL_USERNAME + "\n" +
        "2. Send a TeraBox link (e.g., https://terabox.com/s/abc123)\n" +
        "3. Wait for the bot to process and download your video\n\n" +
        "If you have any issues, please try again later.",
        parse_mode="Markdown"
    )
    await log_activity("help_command")

# Admin commands
async def stats_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    user_id = update.effective_user.id
    
    if not is_admin(user_id):
        await update.message.reply_text("⛔ You are not authorized to use this command")
        return
    
    if not db_connected and not check_db_connection():
        await update.message.reply_text("⚠️ No database connection available")
        return
    
    total_users = users_collection.count_documents({})
    
    # Get activity stats
    activity_stats = {}
    try:
        cursor = stats_collection.find({})
        for doc in cursor:
            if doc.get("stat") != "heartbeat":
                activity_stats[doc.get("stat")] = doc
    except Exception as e:
        logger.error(f"Error fetching stats: {e}")
    
    stats_text = f"📊 *Bot Statistics*\n\n" + \
                f"Total users: {total_users}\n" + \
                f"Database status: {'✅ Connected' if db_connected else '❌ Disconnected'}\n\n"
    
    if activity_stats:
        stats_text += "*Activity Metrics:*\n"
        for stat_name, stat_data in activity_stats.items():
            stats_text += f"- {stat_name}: {stat_data.get('total', 0)} total"
            if "success" in stat_data:
                success_rate = (stat_data.get('success', 0) / stat_data.get('total', 1)) * 100
                stats_text += f" ({success_rate:.1f}% success rate)\n"
            else:
                stats_text += "\n"
    
    await update.message.reply_text(stats_text, parse_mode="Markdown")

async def broadcast_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    user_id = update.effective_user.id
    
    if not is_admin(user_id):
        await update.message.reply_text("⛔ You are not authorized to use this command")
        return
    
    if not context.args or len(" ".join(context.args)) < 1:
        await update.message.reply_text(
            "⚠️ Please provide a message to broadcast.\n" +
            "Usage: /broadcast <message>"
        )
        return
    
    broadcast_text = " ".join(context.args)
    username = update.effective_user.username or "Admin"
    
    await update.message.reply_text("🔄 Broadcasting message to all users...")
    
    result = await broadcast_message(context, broadcast_text, f"@{username}")
    
    if result["success"]:
        await update.message.reply_text(
            f"✅ Broadcast completed\n" +
            f"Total users: {result['total']}\n" +
            f"Successfully sent: {result['sent']}\n" +
            f"Failed: {result['failed']}"
        )
    else:
        await update.message.reply_text(f"❌ Broadcast failed: {result.get('error', 'Unknown error')}")

# Function to forward files to dump channel
async def forward_to_dump(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    user_id = update.effective_user.id
    
    if not is_admin(user_id):
        await update.message.reply_text("⛔ You are not authorized to use this command")
        return
    
    if not update.message.reply_to_message:
        await update.message.reply_text("⚠️ Please reply to a message containing media that you want to forward to the dump channel")
        return
    
    original_msg = update.message.reply_to_message
    username = update.effective_user.username or "Admin"
    caption = f"Forwarded by @{username}"
    
    if original_msg.photo:
        photo = original_msg.photo[-1].file_id
        success = await send_to_dump_channel(context, photo, is_text=False, caption=caption, file_type="photo")
        await update.message.reply_text("✅ Photo forwarded to dump channel" if success else "❌ Failed to forward photo")
    
    elif original_msg.video:
        video = original_msg.video.file_id
        success = await send_to_dump_channel(context, video, is_text=False, caption=caption, file_type="video")
        await update.message.reply_text("✅ Video forwarded to dump channel" if success else "❌ Failed to forward video")
    
    elif original_msg.document:
        document = original_msg.document.file_id
        success = await send_to_dump_channel(context, document, is_text=False, caption=caption, file_type="document")
        await update.message.reply_text("✅ Document forwarded to dump channel" if success else "❌ Failed to forward document")
    
    elif original_msg.audio:
        audio = original_msg.audio.file_id
        success = await send_to_dump_channel(context, audio, is_text=False, caption=caption, file_type="audio")
        await update.message.reply_text("✅ Audio forwarded to dump channel" if success else "❌ Failed to forward audio")
    
    else:
        await update.message.reply_text("❌ No media found in the replied message")

# Handle all messages
async def handle_message(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    # Check if the message has text
    if not update.message or not update.message.text:
        return
    
    user_id = update.effective_user.id
    username = update.effective_user.username or "Unknown"
    
    # Save user data
    await save_user(user_id, username)
    
    # Check if user is member of the channel
    if not await is_user_member(update, context):
        join_button = InlineKeyboardButton("Join Channel", url=f"https://t.me/{CHANNEL_USERNAME.replace('@', '')}")
        reply_markup = InlineKeyboardMarkup([[join_button]])
        await update.message.reply_text(
            "🔒 You need to join our channel to use this bot.\n" +
            f"Join: {CHANNEL_USERNAME}\n\n" +
            "After joining, send your link again.",
            reply_markup=reply_markup
        )
        return
    
    message_text = update.message.text.strip()
    
    # Log the received message to dump channel
    await send_to_dump_channel(context, f"📥 Received from @{username} ({user_id}):\n{message_text}")
    
    # Extract TeraBox ID
    terabox_id = extract_terabox_id(message_text)
    
    if not terabox_id:
        await update.message.reply_text("⚠️ Invalid link format. Please send a valid TeraBox link.")
        return
    
    # Send processing message
    processing_message = await update.message.reply_text("🔄 Processing your request...")
    
    # Fetch video
    video_result = await fetch_video(terabox_id)
    
    if not video_result["success"]:
        await processing_message.edit_text(
            "❌ Failed to fetch video.\n\n" +
            "Possible reasons:\n" +
            "1. Invalid or expired link\n" +
            "2. The file may be too large\n" +
            "3. Our servers might be busy\n\n" +
            "Please try again later or try a different link."
        )
        await log_activity("video_fetch", success=False)
        return
    
    video_data = video_result["data"]
    
    if not video_data or not video_data.get("dirName") or not video_data.get("list"):
        await processing_message.edit_text("❌ Invalid video data received.")
        await log_activity("video_fetch", success=False)
        return
    
    try:
        # Get file details
        file_list = video_data.get("list", [])
        if not file_list:
            await processing_message.edit_text("❌ No files found in this link.")
            return
        
        # Process each file
        for file_info in file_list:
            file_name = file_info.get("name", "Unknown")
            file_size = file_info.get("size", 0)
            file_size_mb = file_size / (1024 * 1024)  # Convert to MB
            
            # Format size for display
            if file_size_mb > 1024:
                formatted_size = f"{file_size_mb/1024:.1f} GB"
            else:
                formatted_size = f"{file_size_mb:.1f} MB"
            
            # Get download links
            download_url = file_info.get("url", "")
            
            if not download_url:
                await processing_message.edit_text(f"❌ Download URL not found for {file_name}")
                continue
            
            # Create keyboard with download button
            keyboard = [
                [InlineKeyboardButton("⬇️ Download", url=download_url)]
            ]
            reply_markup = InlineKeyboardMarkup(keyboard)
            
            # Send file info and download link
            await processing_message.edit_text(
                f"✅ File Ready\n\n" +
                f"📁 Name: {file_name}\n" +
                f"📊 Size: {formatted_size}\n\n" +
                f"📥 Click the button below to download:",
                reply_markup=reply_markup
            )
            
            # Log successful fetch
            await log_activity("video_fetch", success=True)
            
            # Send success message to dump channel
            await send_to_dump_channel(
                context, 
                f"✅ Success for @{username} ({user_id}):\n" +
                f"File: {file_name}\n" +
                f"Size: {formatted_size}\n" +
                f"API Source: {video_result['source']}"
            )
            
    except Exception as e:
        logger.error(f"Error processing video: {e}")
        await processing_message.edit_text(
            "❌ An error occurred while processing the video.\n" +
            "Please try again later."
        )
        await log_activity("video_fetch", success=False)

async def error_handler(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Log the error and send a telegram message to notify the developer."""
    logger.error(f"Exception while handling an update: {context.error}")
    
    # Log to dump channel if available
    if DUMP_CHANNEL_ID:
        error_message = f"⚠️ ERROR: {context.error}"
        await send_to_dump_channel(context, error_message)

# Main function to run the bot
def main() -> None:
    # Create the Application
    application = Application.builder().token(BOT_TOKEN).build()
    
    # Add command handlers
    application.add_handler(CommandHandler("start", start))
    application.add_handler(CommandHandler("help", help_command))
    application.add_handler(CommandHandler("stats", stats_command))
    application.add_handler(CommandHandler("broadcast", broadcast_command))
    application.add_handler(CommandHandler("forward", forward_to_dump))
    
    # Add message handler
    application.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_message))
    
    # Add error handler
    application.add_error_handler(error_handler)
    
    # Start the Bot
    if WEBHOOK_URL:
        application.run_webhook(
            listen="0.0.0.0",
            port=PORT,
            url_path=BOT_TOKEN,
            webhook_url=f"{WEBHOOK_URL}/{BOT_TOKEN}"
        )
    else:
        application.run_polling()

if __name__ == "__main__":
    main()
