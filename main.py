import os
import logging
from dotenv import load_dotenv
import http.client
import requests
from telegram import Update, InlineKeyboardMarkup, InlineKeyboardButton
from telegram.ext import Application, CommandHandler, MessageHandler, filters, ContextTypes, CallbackQueryHandler
from pymongo import MongoClient
import re
from urllib.parse import urlparse
import json

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
WELCOME_VIDEO_REPO_URL = os.getenv("WELCOME_VIDEO_REPO_URL", "https://raw.githubusercontent.com/your-repo/welcome-video.mp4")
ADMIN_IDS = list(map(int, os.getenv("ADMIN_IDS", "").split(","))) if os.getenv("ADMIN_IDS") else []

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

# Function to check if user is an admin
def is_admin(user_id):
    return user_id in ADMIN_IDS

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

# Enhanced function to send message/file to dump channel
async def send_to_dump_channel(context: ContextTypes.DEFAULT_TYPE, content, is_text=True, caption=None, file_type=None):
    if not DUMP_CHANNEL_ID:
        return
    
    try:
        if is_text:
            await context.bot.send_message(chat_id=DUMP_CHANNEL_ID, text=content)
        else:
            if file_type == "photo":
                await context.bot.send_photo(chat_id=DUMP_CHANNEL_ID, photo=content, caption=caption)
            elif file_type == "video":
                await context.bot.send_video(chat_id=DUMP_CHANNEL_ID, video=content, caption=caption)
            elif file_type == "document":
                await context.bot.send_document(chat_id=DUMP_CHANNEL_ID, document=content, caption=caption)
            elif file_type == "audio":
                await context.bot.send_audio(chat_id=DUMP_CHANNEL_ID, audio=content, caption=caption)
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

# New function to fetch welcome video from repo
async def fetch_welcome_video():
    try:
        response = requests.get(WELCOME_VIDEO_REPO_URL, stream=True, timeout=30)
        if response.status_code == 200:
            return response.content
        else:
            logger.error(f"Failed to fetch welcome video. Status code: {response.status_code}")
            return None
    except Exception as e:
        logger.error(f"Error fetching welcome video: {e}")
        return None

# New function to broadcast message to all users
async def broadcast_message(context: ContextTypes.DEFAULT_TYPE, message_text, send_by=None):
    if not db_connected:
        logger.error("Cannot broadcast: No database connection")
        return {"success": False, "error": "No database connection"}
    
    success_count = 0
    fail_count = 0
    
    users = users_collection.find({})
    total_users = users_collection.count_documents({})
    
    for user in users:
        try:
            user_id = user.get("userId")
            if user_id:
                await context.bot.send_message(
                    chat_id=user_id,
                    text=f"{message_text}\n\n{f'Message from: {send_by}' if send_by else ''}"
                )
                success_count += 1
        except Exception as e:
            logger.error(f"Failed to send broadcast to {user.get('userId')}: {e}")
            fail_count += 1
    
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

async def help_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    await update.message.reply_text(
        "🔍 *How to use this bot:*\n\n" +
        "1. Join our channel: " + CHANNEL_USERNAME + "\n" +
        "2. Send a TeraBox link (e.g., https://terabox.com/s/abc123)\n" +
        "3. Wait for the bot to process and download your video\n\n" +
        "If you have any issues, please try again later.",
        parse_mode="Markdown"
    )

# New admin commands
async def stats_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    user_id = update.effective_user.id
    
    if not is_admin(user_id):
        await update.message.reply_text("⛔ You are not authorized to use this command")
        return
    
    if not db_connected:
        await update.message.reply_text("⚠️ No database connection available")
        return
    
    total_users = users_collection.count_documents({})
    
    await update.message.reply_text(
        f"📊 *Bot Statistics*\n\n" +
        f"Total users: {total_users}\n" +
        f"Database status: {'✅ Connected' if db_connected else '❌ Disconnected'}",
        parse_mode="Markdown"
    )

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

# New function to forward files to dump channel
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
        await send_to_dump_channel(context, photo, is_text=False, caption=caption, file_type="photo")
        await update.message.reply_text("✅ Photo forwarded to dump channel")
    
    elif original_msg.video:
        video = original_msg.video.file_id
        await send_to_dump_channel(context, video, is_text=False, caption=caption, file_type="video")
        await update.message.reply_text("✅ Video forwarded to dump channel")
    
    elif original_msg.document:
        document = original_msg.document.file_id
        await send_to_dump_channel(context, document, is_text=False, caption=caption, file_type="document")
        await update.message.reply_text("✅ Document forwarded to dump channel")
    
    elif original_msg.audio:
        audio = original_msg.audio.file_id
        await send_to_dump_channel(context, audio, is_text=False, caption=caption, file_type="audio")
        await update.message.reply_text("✅ Audio forwarded to dump channel")
    
    else:
        await update.message.reply_text("❌ No media found in the replied message")

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
                video_message = await context.bot.send_video(
                    chat_id=update.effective_chat.id,
                    video=response.content,
                    filename=file_name,
                    caption=f"📁 {file_name}\n🔗 Downloaded with @{context.bot.username}",
                    disable_notification=True
                )
                
                # Also send a copy to dump channel
                await send_to_dump_channel(
                    context, 
                    video_message.video.file_id, 
                    is_text=False,
                    caption=f"📁 {file_name}\nRequested by: @{username} ({user_id})",
                    file_type="video"
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
    application.add_handler(CommandHandler("stats", stats_command))
    application.add_handler(CommandHandler("broadcast", broadcast_command))
    application.add_handler(CommandHandler("forward", forward_to_dump))
    application.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_message))

    # Always use polling mode to avoid webhook issues
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
