import os
import logging
import time
from dotenv import load_dotenv
import http.client
import requests
from telegram import Update, InlineKeyboardMarkup, InlineKeyboardButton
from telegram.ext import Application, CommandHandler, MessageHandler, filters, ContextTypes, CallbackQueryHandler
from telegram.error import NetworkError, TelegramError
from pymongo import MongoClient
import re
import io
from urllib.parse import urlparse
import json
import threading
import signal
import sys

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

# Heartbeat settings
HEARTBEAT_INTERVAL = 300  # 5 minutes

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

# Heartbeat function to keep the bot alive
async def heartbeat(context: ContextTypes.DEFAULT_TYPE):
    logger.info("💓 Heartbeat check...")
    
    # Check DB connection
    if MONGO_URI and not check_db_connection():
        logger.warning("⚠️ MongoDB connection lost, attempting to reconnect...")
        try:
            global client, users_collection, stats_collection, db_connected
            client = MongoClient(MONGO_URI, serverSelectionTimeoutMS=5000)
            db = client.telegramBot
            users_collection = db.users
            stats_collection = db.stats
            db_connected = check_db_connection()
            if db_connected:
                logger.info("📂 Reconnected to MongoDB")
        except Exception as e:
            logger.error(f"Failed to reconnect to MongoDB: {e}")
    
    # Update heartbeat status
    if db_connected:
        try:
            stats_collection.update_one(
                {"stat": "heartbeat"},
                {"$set": {"last_beat": time.time()}},
                upsert=True
            )
        except Exception as e:
            logger.error(f"Error updating heartbeat: {e}")
    
    # Queue the next heartbeat
    context.job_queue.run_once(heartbeat, HEARTBEAT_INTERVAL)

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

# New command for system maintenance
async def maintenance_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    user_id = update.effective_user.id
    
    if not is_admin(user_id):
        await update.message.reply_text("⛔ You are not authorized to use this command")
        return
    
    args = context.args
    
    if not args or args[0] not in ["status", "restart", "check_db"]:
        await update.message.reply_text(
            "⚠️ Invalid maintenance command.\n\nAvailable options:\n" +
            "/maintenance status - Show system status\n" +
            "/maintenance restart - Restart the bot\n" +
            "/maintenance check_db - Test database connection"
        )
        return
    
    command = args[0]
    
    if command == "status":
        uptime = time.time() - start_time
        days, remainder = divmod(uptime, 86400)
        hours, remainder = divmod(remainder, 3600)
        minutes, seconds = divmod(remainder, 60)
        
        status_text = f"🤖 *Bot System Status*\n\n" + \
                      f"Uptime: {int(days)}d {int(hours)}h {int(minutes)}m {int(seconds)}s\n" + \
                      f"Database: {'✅ Connected' if db_connected else '❌ Disconnected'}\n" + \
                      f"Webhook mode: {'Yes' if WEBHOOK_URL else 'No (polling)'}\n" + \
                      f"Admins configured: {len(ADMIN_IDS)}\n"
        
        await update.message.reply_text(status_text, parse_mode="Markdown")
    
    elif command == "restart":
        await update.message.reply_text("🔄 Restarting bot...")
        # Log the restart
        await send_to_dump_channel(context, f"🔄 Bot restart initiated by admin: {update.effective_user.username} ({user_id})")
        
        # We'll use os.execv to restart the script
        logger.info("Restarting bot...")
        os.execv(sys.executable, [sys.executable] + sys.argv)
    
    elif command == "check_db":
        if check_db_connection():
            await update.message.reply_text("✅ Database connection successful")
        else:
            await update.message.reply_text("❌ Database connection failed")

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
            except Exception as e:
                logger.warning(f"Could not delete processing message: {e}")
            await update.message.reply_text("❌ Failed to fetch video. Please check the link or try again later.")
            await log_activity("video_fetch", success=False)
            return

        download_url = result["data"].get("downloadLink")
        file_size = int(result["data"].get("size", 0)) or 0
        file_name = result["data"].get("filename", "terabox_video")

        logger.info(f"Download URL found from {result['source']} API")

        if not download_url:
            try:
                await context.bot.delete_message(chat_id=update.effective_chat.id, message_id=processing_msg.message_id)
            except Exception as e:
                logger.warning(f"Could not delete processing message: {e}")
            await update.message.reply_text("❌ No download link found.")
            await log_activity("video_fetch", success=False)
            return

        # Check if file is too large for Telegram
        file_size_mb = round(file_size / (1024 * 1024), 2)
        if file_size > 50000000:  # 50MB limit for Telegram
            try:
                await context.bot.delete_message(chat_id=update.effective_chat.id, message_id=processing_msg.message_id)
            except Exception as e:
                logger.warning(f"Could not delete processing message: {e}")
            await send_to_dump_channel(context, f"⚠️ Large file requested: {file_size_mb}MB\nUser: @{username} ({user_id})")
            await update.message.reply_text(
                f"🚨 File is too large for Telegram ({file_size_mb}MB)!\n\n" +
                f"📥 Download directly: {download_url}"
            )
            await log_activity("large_file", success=True)
            return

        # Update processing message
        try:
            await context.bot.edit_message_text(
                chat_id=update.effective_chat.id,
                message_id=processing_msg.message_id,
                text=f"✅ Video found! ({file_size_mb}MB)\n🔄 Downloading..."
            )
        except Exception as e:
            logger.warning(f"Could not update processing message: {e}")

        # Download and send the video with retries
        max_download_retries = 3
        for attempt in range(max_download_retries):
            try:
                response = requests.get(download_url, stream=True, timeout=60)
                if response.status_code == 200:
                    # First send to user
                    video_content = response.content
                    video_message = await context.bot.send_video(
                        chat_id=update.effective_chat.id,
                        video=io.BytesIO(video_content),  # Use BytesIO for more reliable handling
                        filename=file_name,
                        caption=f"📁 {file_name}\n🔗 Downloaded with @{context.bot.username}",
                        disable_notification=True
                    )
                    
                    # Then send a copy to dump channel using the file_id from the sent message
                    dump_success = await send_to_dump_channel(
                        context, 
                        video_message.video.file_id,  # Use file_id instead of bytes for sending to dump channel 
                        is_text=False,
                        caption=f"📁 {file_name}\nRequested by: @{username} ({user_id})",
                        file_type="video"
                    )
                    
                    if dump_success:
                        logger.info(f"Successfully forwarded video to dump channel")
                    else:
                        logger.warning("Failed to forward video to dump channel")
                        
                    await send_to_dump_channel(context, f"✅ Download successful: {file_size_mb}MB\nUser: @{username} ({user_id})")
                    await log_activity("video_download", success=True)
                    break  # Success, exit retry loop
                else:
                    raise Exception(f"Failed to download with status code: {response.status_code}")
            except Exception as download_error:
                logger.error(f"Download error (attempt {attempt+1}/{max_download_retries}): {download_error}")
                if attempt == max_download_retries - 1:  # Last attempt failed
                    await update.message.reply_text(
                        f"⚠️ Download failed, but you can try directly:\n{download_url}"
                    )
                    await send_to_dump_channel(context, f"❌ Download failed for user: @{username} ({user_id})")
                    await log_activity("video_download", success=False)
                else:
                    # Wait before retrying
                    await asyncio.sleep(2)
        
        # Delete processing message
        try:
            await context.bot.delete_message(chat_id=update.effective_chat.id, message_id=processing_msg.message_id)
        except Exception as e:
            logger.warning(f"Could not delete processing message: {e}")
            
    except Exception as error:
