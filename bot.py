import os
import logging
import pickle
import datetime
import tempfile
import math
import time
from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup
from telegram.ext import (
    ApplicationBuilder, CommandHandler, MessageHandler, 
    ContextTypes, filters, ConversationHandler, CallbackQueryHandler
)
from PIL import Image
import requests
from io import BytesIO
from moviepy.editor import VideoFileClip  # Alternative to OpenCV for video processing

# Configure logging
logging.basicConfig(
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    level=logging.INFO
)
logger = logging.getLogger(__name__)

# Configuration
TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "6866329408:AAGDH0KcMlGAo9ZX3D4qzBQiuEcO42FoEyQ")
CHANNEL_USERNAME = os.environ.get("MAIN_CHANNEL", "terao2")
MOVIES_CHANNEL = os.environ.get("MOVIES_CHANNEL", "@diskmoviee")
STUFF_CHANNEL = os.environ.get("STUFF_CHANNEL", "@dailydiskwala")

# Webhook settings for Koyeb deployment
WEBHOOK_URL = os.environ.get("WEBHOOK_URL", "")  # Set this in Koyeb environment variables
PORT = int(os.environ.get("PORT", 8080))
USE_WEBHOOK = os.environ.get("USE_WEBHOOK", "True").lower() == "true"

# Admin user ID - only this user can access the bot
ADMIN_USER_ID = int(os.environ.get("ADMIN_USER_ID", "1352497419"))

# Debug and Auto-start settings
DEBUG_MODE = os.environ.get("DEBUG_MODE", "False").lower() == "true"
AUTO_START = os.environ.get("AUTO_START", "True").lower() == "true"

# Max file size setting - 1GB (in bytes)
MAX_FILE_SIZE = 1024 * 1024 * 1024  # 1GB

# Session and history files
SESSION_FILE = "bot_session.pickle"
POSTS_FILE = "post_history.pickle"

# Folder for temporary files
TEMP_FOLDER = "temp"
os.makedirs(TEMP_FOLDER, exist_ok=True)

# Conversation states
WAITING_FOR_URL = 0
WAITING_FOR_CAPTION = 1
WAITING_FOR_CHANNEL_SELECTION = 2
WAITING_FOR_THUMBNAIL_SELECTION = 3
WAITING_FOR_BROADCAST_MESSAGE = 4

# Callback data constants
CALLBACK_MOVIES = "channel_movies"
CALLBACK_STUFF = "channel_stuff"
CALLBACK_THUMBNAIL_START = "thumbnail_"
CALLBACK_THUMBNAIL_CUSTOM = "thumbnail_custom"

# User session and post history data
user_data = {}
post_history = []

def debug_log(message):
    """Log debug messages if debug mode is enabled."""
    if DEBUG_MODE:
        logger.info(f"DEBUG: {message}")

def save_data(data, file_path):
    """Generic function to save data to file."""
    try:
        with open(file_path, 'wb') as f:
            pickle.dump(data, f)
        return True
    except Exception as e:
        logger.error(f"Error saving data to {file_path}: {e}")
        return False

def load_data(file_path, default_value):
    """Generic function to load data from file."""
    try:
        if os.path.exists(file_path):
            with open(file_path, 'rb') as f:
                return pickle.load(f)
        return default_value
    except Exception as e:
        logger.error(f"Error loading data from {file_path}: {e}")
        return default_value

def save_session():
    """Save the user_data to a file for persistence."""
    if DEBUG_MODE:
        debug_log("Saving session data...")
    return save_data(user_data, SESSION_FILE)

def load_session():
    """Load the user_data from a file if it exists."""
    global user_data
    user_data = load_data(SESSION_FILE, {})
    if DEBUG_MODE and user_data:
        debug_log(f"Session data loaded. Active users: {list(user_data.keys())}")

def save_post_history():
    """Save the post history to a file."""
    if DEBUG_MODE:
        debug_log(f"Saving post history with {len(post_history)} entries...")
    return save_data(post_history, POSTS_FILE)

def load_post_history():
    """Load the post history from a file if it exists."""
    global post_history
    post_history = load_data(POSTS_FILE, [])
    if DEBUG_MODE:
        debug_log(f"Post history loaded with {len(post_history)} entries.")

def add_to_post_history(channel, caption, url, thumbnail_path=None):
    """Add a new post to the post history."""
    # Save a copy of the thumbnail if available
    saved_thumbnail = None
    if thumbnail_path and os.path.exists(thumbnail_path):
        try:
            history_thumb_dir = os.path.join(TEMP_FOLDER, "history")
            os.makedirs(history_thumb_dir, exist_ok=True)
            
            timestamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
            saved_thumbnail = os.path.join(history_thumb_dir, f"thumb_{timestamp}.jpg")
            
            import shutil
            shutil.copy2(thumbnail_path, saved_thumbnail)
            debug_log(f"Saved thumbnail copy for history: {saved_thumbnail}")
        except Exception as e:
            logger.error(f"Error saving thumbnail copy: {e}")
            saved_thumbnail = None

    # Create new post entry
    post_entry = {
        "timestamp": datetime.datetime.now().isoformat(),
        "channel": channel,
        "caption": caption,
        "url": url,
        "thumbnail_path": saved_thumbnail
    }
    
    # Add to history and save
    post_history.append(post_entry)
    save_post_history()
    debug_log(f"Added new post to history. Total posts: {len(post_history)}")

async def check_admin(update: Update) -> bool:
    """Check if the user is the admin."""
    user_id = update.effective_user.id
    debug_log(f"User ID {user_id} authorization check against ADMIN_USER_ID {ADMIN_USER_ID}")
    
    if user_id != ADMIN_USER_ID:
        await update.message.reply_text(
            "Sorry, you're not authorized to use this bot. This bot is only for admin use."
        )
        debug_log(f"Authorization denied for user {user_id}")
        return False
    
    debug_log(f"Authorization granted for admin {user_id}")
    return True

async def start(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Send a message when the command /start is issued."""
    # Check if user is admin
    if not await check_admin(update):
        return
    
    debug_log("Start command executed by admin")
    
    await update.message.reply_text(
        f"Hi admin! I'm your channel posting bot. "
        f"Just send me a video or forward a video from another chat and I'll extract multiple thumbnails for you to choose from. "
        f"Afterward, I'll ask for a URL and caption to add to the post, "
        f"and you can choose which channel to post it to.\n\n"
        f"💡 Current settings:\n"
        f"- Debug mode: {'✅ ON' if DEBUG_MODE else '❌ OFF'}\n"
        f"- Auto-start: {'✅ ON' if AUTO_START else '❌ OFF'}\n"
        f"- Webhook mode: {'✅ ON' if USE_WEBHOOK else '❌ OFF'}\n"
        f"- Max file size: {MAX_FILE_SIZE/(1024*1024*1024):.1f}GB"
    )

async def toggle_debug(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Toggle debug mode on/off."""
    global DEBUG_MODE
    
    # Check if user is admin
    if not await check_admin(update):
        return
    
    DEBUG_MODE = not DEBUG_MODE
    debug_status = "enabled" if DEBUG_MODE else "disabled"
    
    logger.info(f"Debug mode {debug_status} by admin")
    
    await update.message.reply_text(f"Debug mode is now {debug_status}.")
    
    if DEBUG_MODE:
        # Print current configuration when debug is enabled
        debug_log(f"Current configuration: TOKEN={TOKEN[:5]}... ADMIN_USER_ID={ADMIN_USER_ID}")
        debug_log(f"Channels: Main={CHANNEL_USERNAME}, Movies={MOVIES_CHANNEL}, Stuff={STUFF_CHANNEL}")
        debug_log(f"Auto-start: {AUTO_START}, Webhook: {USE_WEBHOOK}, Port: {PORT}")
        debug_log(f"Max file size: {MAX_FILE_SIZE/(1024*1024*1024):.1f}GB")

async def toggle_autostart(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Toggle auto-start mode on/off."""
    global AUTO_START
    
    # Check if user is admin
    if not await check_admin(update):
        return
    
    AUTO_START = not AUTO_START
    status = "enabled" if AUTO_START else "disabled"
    
    debug_log(f"Auto-start mode {status} by admin")
    
    await update.message.reply_text(
        f"Auto-start mode is now {status}.\n\n"
        f"{'✅ Videos will be processed immediately without needing to send /start first' if AUTO_START else '❌ You need to send /start before processing videos'}"
    )

async def help_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Send a message when the command /help is issued."""
    # Check if user is admin
    if not await check_admin(update):
        return
    
    debug_log("Help command executed by admin")
    
    await update.message.reply_text(
        "Admin commands:\n\n"
        "Send me a video file or forward a video from another chat and I'll generate multiple thumbnails for you to choose from.\n\n"
        "After selecting a thumbnail, I'll ask you for:\n"
        "1. A URL to link to\n"
        "2. A caption to display under the thumbnail\n"
        "3. Which channel to post to (MOVIES or STUFF)\n\n"
        "Commands:\n"
        "/start - Start the bot\n"
        "/help - Show this help message\n"
        "/cancel - Cancel the current operation\n"
        "/status - Check bot status and channels\n"
        "/posts - View history of posts sent by the bot\n"
        "/debug - Toggle debug mode on/off\n"
        "/autostart - Toggle auto-start mode on/off\n"
        "/cleanup - Remove temporary files and clear sessions\n"
        "/broadcast - Send a message to all channels\n\n"
        f"The maximum file size is set to {MAX_FILE_SIZE/(1024*1024*1024):.1f}GB"
    )

async def cleanup_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Clean up temporary files and user sessions."""
    # Check if user is admin
    if not await check_admin(update):
        return
    
    debug_log("Cleanup command executed by admin")
    
    # Clean up all files in the temp folder, except history subfolder
    files_removed = 0
    for filename in os.listdir(TEMP_FOLDER):
        file_path = os.path.join(TEMP_FOLDER, filename)
        try:
            if os.path.isfile(file_path):
                os.unlink(file_path)
                files_removed += 1
            elif os.path.isdir(file_path) and filename != "history":
                # If it's a directory but not the history folder, we can remove its contents
                import shutil
                shutil.rmtree(file_path)
                debug_log(f"Removed directory: {file_path}")
        except Exception as e:
            debug_log(f"Failed to delete {file_path}: {e}")
    
    # Clear user data
    user_count = len(user_data)
    user_data.clear()
    save_session()
    
    await update.message.reply_text(
        f"Cleanup completed:\n"
        f"- {files_removed} temporary files removed\n"
        f"- {user_count} user sessions cleared\n"
        f"- Post history remains intact"
    )

async def status_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Check bot status and configured channels."""
    # Check if user is admin
    if not await check_admin(update):
        return
    
    debug_log("Status command executed by admin")
    
    # Count temp files
    temp_file_count = len([name for name in os.listdir(TEMP_FOLDER) if os.path.isfile(os.path.join(TEMP_FOLDER, name))])
    
    # Get active sessions
    active_sessions = len(user_data)
    
    # Get post count
    post_count = len(post_history)
    
    status_message = (
        "🤖 Bot Status: Running\n\n"
        f"📢 Main Channel: {CHANNEL_USERNAME}\n"
        f"🎬 Movies Channel: {MOVIES_CHANNEL}\n"
        f"📦 Stuff Channel: {STUFF_CHANNEL}\n\n"
        f"🔐 Admin ID: {ADMIN_USER_ID}\n\n"
        f"🔧 Settings:\n"
        f"- Debug mode: {'✅ ON' if DEBUG_MODE else '❌ OFF'}\n"
        f"- Auto-start: {'✅ ON' if AUTO_START else '❌ OFF'}\n"
        f"- Webhook mode: {'✅ ON' if USE_WEBHOOK else '❌ OFF'}\n"
        f"- Max file size: {MAX_FILE_SIZE/(1024*1024*1024):.1f}GB\n"
        f"- Port: {PORT}\n\n"
        f"📊 System:\n"
        f"- Temporary files: {temp_file_count}\n"
        f"- Active sessions: {active_sessions}\n"
        f"- Posts sent: {post_count}"
    )
    
    await update.message.reply_text(status_message)

async def broadcast_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    """Start the broadcast message process."""
    # Check if user is admin
    if not await check_admin(update):
        return ConversationHandler.END
    
    debug_log("Broadcast command executed by admin")
    
    await update.message.reply_text(
        "📣 Please enter the message you want to broadcast to all channels.\n\n"
        "This message will be sent to both the MOVIES and STUFF channels."
    )
    
    return WAITING_FOR_BROADCAST_MESSAGE

async def process_broadcast_message(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    """Process the broadcast message and send it to all channels."""
    # Check if user is admin
    if not await check_admin(update):
        return ConversationHandler.END
    
    broadcast_message = update.message.text
    debug_log(f"Broadcast message received: {broadcast_message[:30]}...")
    
    channels = [MOVIES_CHANNEL, STUFF_CHANNEL]
    successful_channels = []
    
    # Add the join channel buttons
    keyboard = []
    for channel_id, channel_name in [(MOVIES_CHANNEL, "Join Movies Channel"), (STUFF_CHANNEL, "Join Stuff Channel")]:
        # Extract clean channel name for the URL
        clean_channel = channel_id.replace("@", "")
        keyboard.append([InlineKeyboardButton(channel_name, url=f"https://t.me/{clean_channel}")])
    
    reply_markup = InlineKeyboardMarkup(keyboard)
    
    # Send the message to each channel
    for channel in channels:
        try:
            debug_log(f"Sending broadcast to channel: {channel}")
            await context.bot.send_message(
                chat_id=channel,
                text=broadcast_message,
                reply_markup=reply_markup
            )
            successful_channels.append(channel)
        except Exception as e:
            logger.error(f"Error broadcasting to {channel}: {e}")
    
    # Send confirmation to admin
    if successful_channels:
        await update.message.reply_text(
            f"✅ Broadcast message sent successfully to {len(successful_channels)} channels."
        )
    else:
        await update.message.reply_text(
            "❌ Failed to send broadcast message to any channels."
        )
    
    return ConversationHandler.END

async def posts_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Display history of posts sent by the bot."""
    # Check if user is admin
    if not await check_admin(update):
        return
    
    debug_log("Posts command executed by admin")
    
    # Check if there are any posts in history
    if not post_history:
        await update.message.reply_text(
            "No posts found in history. Posts will be tracked once you start sending them."
        )
        return
    
    # Get argument for number of posts to display (default to 5)
    args = context.args
    try:
        limit = int(args[0]) if args else 5
        # Ensure limit is reasonable
        limit = max(1, min(limit, 20))
    except (ValueError, IndexError):
        limit = 5
    
    # Get the most recent posts (up to the limit)
    recent_posts = post_history[-limit:]
    
    await update.message.reply_text(
        f"📝 Recent Posts (showing {len(recent_posts)} of {len(post_history)} total posts):"
    )
    
    # Send information about each post
    for i, post in enumerate(reversed(recent_posts)):
        # Format timestamp
        try:
            timestamp = datetime.datetime.fromisoformat(post["timestamp"])
            formatted_time = timestamp.strftime("%Y-%m-%d %H:%M:%S")
        except:
            formatted_time = post.get("timestamp", "Unknown")
        
        # Prepare post info message
        post_info = (
            f"📌 Post #{len(post_history) - (len(post_history) - post_history.index(post))}:\n"
            f"📅 Date: {formatted_time}\n"
            f"📣 Channel: {post.get('channel', 'Unknown')}\n"
            f"🔗 URL: {post.get('url', 'None')}\n"
            f"📝 Caption: {post.get('caption', 'None')[:100]}{'...' if len(post.get('caption', '')) > 100 else ''}"
        )
        
        # If we have a thumbnail, send it with the post info
        thumbnail_path = post.get("thumbnail_path")
        if thumbnail_path and os.path.exists(thumbnail_path):
            try:
                with open(thumbnail_path, 'rb') as thumb_file:
                    await update.message.reply_photo(
                        photo=thumb_file,
                        caption=post_info
                    )
            except Exception as e:
                logger.error(f"Error sending thumbnail: {e}")
                await update.message.reply_text(
                    f"{post_info}\n\n(Thumbnail file could not be loaded: {str(e)})"
                )
        else:
            await update.message.reply_text(f"{post_info}\n\n(No thumbnail available)")

async def cancel(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    """Cancel the conversation."""
    # Check if user is admin
    if not await check_admin(update):
        return ConversationHandler.END
    
    debug_log("Cancel command executed by admin")
    
    user_id = update.effective_user.id
    if user_id in user_data:
        # Clean up any files before canceling
        if 'video_path' in user_data[user_id]:
            try_delete_file(user_data[user_id]['video_path'])
        
        if 'thumbnails' in user_data[user_id]:
            for thumb_path in user_data[user_id]['thumbnails']:
                try_delete_file(thumb_path)
        
        if 'thumbnail_path' in user_data[user_id]:
            try_delete_file(user_data[user_id]['thumbnail_path'])
            
        del user_data[user_id]
        save_session()
        debug_log(f"Session for user {user_id} has been cleared")
    
    await update.message.reply_text("Operation cancelled.")
    return ConversationHandler.END

async def download_large_file_with_progress(bot, file_id, file_path, update, context):
    """Download a large file with progress updates."""
    try:
        # Get file info first
        file_info = await bot.get_file(file_id)
        file_size = file_info.file_size
        
        if file_size > MAX_FILE_SIZE:
            raise ValueError(f"File size ({file_size/(1024*1024):.1f} MB) exceeds the maximum allowed size ({MAX_FILE_SIZE/(1024*1024*1024):.1f} GB)")
        
        debug_log(f"Starting download of file {file_id} with size {file_size/(1024*1024):.1f} MB")
        
        # Send initial progress message
        progress_message = await update.message.reply_text("Starting download: 0%")
        
        # Get file URL
        file_url = await file_info.get_url()
        
        # Use requests to download with progress
        with requests.get(file_url, stream=True) as response:
            response.raise_for_status()
            content_length = int(response.headers.get('content-length', 0))
            
            # Create parent directory if it doesn't exist
            os.makedirs(os.path.dirname(file_path), exist_ok=True)
            
            downloaded = 0
            last_update_time = time.time()
            update_interval = 3  # Update progress every 3 seconds
            
            with open(file_path, 'wb') as f:
                for chunk in response.iter_content(chunk_size=8192*16):  # Larger chunk size for speed
                    if chunk:
                        f.write(chunk)
                        downloaded += len(chunk)
                        
                        # Update progress less frequently
                        current_time = time.time()
                        if current_time - last_update_time > update_interval:
                            progress = (downloaded / content_length) * 100 if content_length > 0 else 0
                            await progress_message.edit_text(f"Downloading: {progress:.1f}%")
                            last_update_time = current_time
        
        # Final update
        await progress_message.edit_text("Download complete! Processing video...")
        debug_log(f"Download completed successfully, file saved to {file_path}")
        return True
    
    except Exception as e:
        logger.error(f"Error downloading file: {e}")
        await update.message.reply_text(f"Error downloading file: {str(e)}")
        return False

async def process_video(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    """Process the video and generate multiple thumbnails."""
    # Check if user is admin
    if not await check_admin(update):
        return ConversationHandler.END
    
    user_id = update.effective_user.id
    
    # Check if auto-start is disabled and no prior conversation exists
    if not AUTO_START and user_id not in user_data:
        debug_log("Auto-start is disabled, requiring explicit /start")
        await update.message.reply_text(
            "Please use the /start command first before sending videos. "
            "Alternatively, you can enable auto-start mode with /autostart."
        )
        return ConversationHandler.END
    
    # Check file size first
    file_size = update.message.video.file_size
    debug_log(f"Video file size: {file_size/(1024*1024):.1f} MB")
    
    if file_size > MAX_FILE_SIZE:
        await update.message.reply_text(
            f"The video file is too large ({file_size/(1024*1024):.1f} MB). "
            f"Maximum allowed size is {MAX_FILE_SIZE/(1024*1024*1024):.1f} GB."
        )
        return ConversationHandler.END
    
    # Notify the user that processing has started
    debug_log(f"Processing video from user {user_id}")
    await update.message.reply_text("Processing your video... Please wait.")
    
    try:
        # Get the video file ID
        video_file_id = update.message.video.file_id
        
        # Create a unique temporary file path
        temp_dir = tempfile.mkdtemp(dir=TEMP_FOLDER)
        video_path = os.path.join(temp_dir, f"{video_file_id}.mp4")
        
        debug_log(f"Downloading video {video_file_id} to {video_path}")
        
        # Download the file with progress updates
        download_success = await download_large_file_with_progress(
            context.bot, 
            video_file_id, 
            video_path, 
            update, 
            context
        )
        
        if not download_success:
            debug_log("Video download failed")
            # Clean up temp directory
            import shutil
            shutil.rmtree(temp_dir, ignore_errors=True)
            return ConversationHandler.END
        
        # Initialize user data
        user_data[user_id] = {
            'video_path': video_path,
            'thumbnails': []
        }
        save_session()
        
        # Get video metadata
        if DEBUG_MODE:
            file_size_mb = update.message.video.file_size / (1024 * 1024)
            duration = update.message.video.duration
            debug_log(f"Video metadata: Size={file_size_mb:.2f}MB, Duration={duration}s")
        
        # Inform user about thumbnail extraction
        await update.message.reply_text("Video downloaded successfully. Extracting thumbnails...")
        
        # For large files, use a more efficient approach with fewer thumbnails at strategic points
        positions = [0.1, 0.25, 0.5, 0.75, 0.9]  # Positions for thumbnails
        thumbnails = []
        
        # Process thumbnails with status updates
        status_message = await update.message.reply_text("Extracting thumbnails: 0%")
        
        for i, pos in enumerate(positions):
            thumbnail_path = os.path.join(temp_dir, f"{video_file_id}_thumbnail_{i}.jpg")
            debug_log(f"Extracting thumbnail {i+1} at position {pos*100:.0f}%")
            
            # Update progress
            await status_message.edit_text(f"Extracting thumbnails: {(i+1)/len(positions)*100:.0f}%")
            
            success = extract_thumbnail(video_path, thumbnail_path, pos)
            
            if success:
                thumbnails.append(thumbnail_path)
                user_data[user_id]['thumbnails'].append(thumbnail_path)
                debug_log(f"Thumbnail {i+1} extracted successfully to {thumbnail_path}")
            else:
                debug_log(f"Failed to extract thumbnail {i+1}")
        
        # Update final status
        await status_message.edit_text("Thumbnail extraction complete!")
        
        save_session()
        
        if thumbnails:
            # Send thumbnails with buttons for selection
            keyboard = []
            for i, _ in enumerate(thumbnails):
                callback_data = f"{CALLBACK_THUMBNAIL_START}{i}"
                keyboard.append([InlineKeyboardButton(f"Thumbnail {i+1}", callback_data=callback_data)])
            
            # Add option for custom position
            keyboard.append([InlineKeyboardButton("Custom Position (0-100%)", callback_data=CALLBACK_THUMBNAIL_CUSTOM)])
            
            reply_markup = InlineKeyboardMarkup(keyboard)
            
            debug_log(f"Sending {len(thumbnails)} thumbnails to user")
            
            # Send all thumbnails
            for i, thumb_path in enumerate(thumbnails):
                try:
                    with open(thumb_path, 'rb') as thumb_file:
                        await update.message.reply_photo(
                            photo=thumb_file, 
                            caption=f"Thumbnail {i+1} (from position {positions[i]*100:.0f}%)"
                        )
                except Exception as e:
                    logger.error(f"Error sending thumbnail {i+1}: {e}")
                    # Continue with other thumbnails if one fails
                    continue
            
            # Send selection message
            await update.message.reply_text(
                "Please select one of the thumbnails above:",
                reply_markup=reply_markup
            )
            
            return WAITING_FOR_THUMBNAIL_SELECTION
        else:
            debug_log("No thumbnails could be generated")
            await update.message.reply_text(
                "Sorry, I couldn't generate thumbnails from your video. The video might be corrupted or in an unsupported format."
            )
            # Clean up files
            try_delete_file(video_path)
            import shutil
            shutil.rmtree(temp_dir, ignore_errors=True)
            # Remove user data
            if user_id in user_data:
                del user_data[user_id]
                save_session()
            return ConversationHandler.END
            
    except Exception as e:
        logger.error(f"Error processing video: {e}")
        debug_log(f"Exception in process_video: {str(e)}")
        await update.message.reply_text(
            f"Sorry, there was an error processing your video: {str(e)}\n\n"
            "Try with a smaller video or from a different source."
        )
        return ConversationHandler.END

async def select_thumbnail(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    """Handle thumbnail selection."""
    query = update.callback_query
    await query.answer()
    
    user_id = query.from_user.id
    debug_log(f"Thumbnail selection callback from user {user_id}: {query.data}")
    
    # Check if user is admin
    if user_id != ADMIN_USER_ID:
        debug_log(f"Unauthorized user {user_id} attempted to select thumbnail")
        await query.edit_message_text("You're not authorized to use this bot.")
        return ConversationHandler.END
    
    if user_id not in user_data:
        debug_log(f"No active session for user {user_id}")
        await query.edit_message_text("Sorry, there was an error. Please start over.")
        return ConversationHandler.END
    
    # Handle custom thumbnail request
    if query.data == CALLBACK_THUMBNAIL_CUSTOM:
        debug_log("User requested custom thumbnail position")
        await query.edit_message_text(
            "Please enter a position for the thumbnail (0-100%).\n"
            "For example, enter '35' for a thumbnail at 35% of the video duration."
        )
        user_data[user_id]['waiting_for_custom_thumbnail'] = True
        save_session()
        return WAITING_FOR_THUMBNAIL_SELECTION
    
    # Handle regular thumbnail selection
    if query.data.startswith(CALLBACK_THUMBNAIL_START):
        # Extract thumbnail index
        try:
            thumb_index = int(query.data.replace(CALLBACK_THUMBNAIL_START, ""))
            if 'thumbnails' not in user_data[user_id] or thumb_index >= len(user_data[user_id]['thumbnails']):
                debug_log(f"Invalid thumbnail index: {thumb_index}")
                await query.edit_message_text("Invalid thumbnail selection. Please try again.")
                return WAITING_FOR_THUMBNAIL_SELECTION
            
            # Save selected thumbnail
            selected_thumbnail = user_data[user_id]['thumbnails'][thumb_index]
            user_data[user_id]['thumbnail_path'] = selected_thumbnail
            debug_log(f"User selected thumbnail #{thumb_index+1}: {selected_thumbnail}")
            
            # Move to next step
            await query.edit_message_text("Great! Now please enter the URL you want to link to in the post:")
            save_session()
            return WAITING_FOR_URL
            
        except (ValueError, IndexError) as e:
            logger.error(f"Error processing thumbnail selection: {e}")
            await query.edit_message_text("There was an error with your selection. Please try again.")
            return WAITING_FOR_THUMBNAIL_SELECTION
    
    # If we get here, something went wrong
    await query.edit_message_text("Invalid selection. Please try again or /cancel to start over.")
    return WAITING_FOR_THUMBNAIL_SELECTION

async def handle_custom_thumbnail(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    """Handle custom thumbnail position input."""
    user_id = update.effective_user.id
    
    # Check if user is admin
    if not await check_admin(update):
        return ConversationHandler.END
    
    if user_id not in user_data or 'waiting_for_custom_thumbnail' not in user_data[user_id]:
        await update.message.reply_text("Sorry, there was an error. Please start over.")
        return ConversationHandler.END
    
    try:
        # Parse position input
        position = float(update.message.text.strip())
        if position < 0 or position > 100:
            await update.message.reply_text("Position must be between 0 and 100%. Please try again:")
            return WAITING_FOR_THUMBNAIL_SELECTION
        
        # Convert to 0-1 range
        position = position / 100.0
        debug_log(f"Generating custom thumbnail at position {position*100:.1f}%")
        
        # Generate custom thumbnail
        video_path = user_data[user_id]['video_path']
        temp_dir = os.path.dirname(video_path)
        custom_thumbnail_path = os.path.join(temp_dir, f"{os.path.basename(video_path)}_custom.jpg")
        
        await update.message.reply_text(f"Generating custom thumbnail at {position*100:.1f}% of video duration...")
        
        # Extract thumbnail
        success = extract_thumbnail(video_path, custom_thumbnail_path, position)
        
        if success:
            debug_log(f"Custom thumbnail generated successfully: {custom_thumbnail_path}")
            user_data[user_id]['thumbnail_path'] = custom_thumbnail_path
            user_data[user_id].pop('waiting_for_custom_thumbnail', None)
            save_session()
            
            # Send the thumbnail for confirmation
            with open(custom_thumbnail_path, 'rb') as thumb_file:
                await update.message.reply_photo(
                    photo=thumb_file,
                    caption=f"Custom thumbnail at {position*100:.1f}% position."
                )
            
            # Move to next step
            await update.message.reply_text("Great! Now please enter the URL you want to link to in the post:")
            return WAITING_FOR_URL
        else:
            debug_log("Failed to generate custom thumbnail")
            await update.message.reply_text(
                "Sorry, I couldn't generate a thumbnail at that position. "
                "Please try a different position or select one of the pre-generated thumbnails."
            )
            return WAITING_FOR_THUMBNAIL_SELECTION
            
    except ValueError:
        await update.message.reply_text(
            "Please enter a valid number between 0 and 100. For example: 35"
        )
        return WAITING_FOR_THUMBNAIL_SELECTION

def extract_thumbnail(video_path, thumbnail_path, position):
    """Extract a thumbnail from the video at the specified position."""
    try:
        debug_log(f"Extracting thumbnail at position {position}")
        
        # Open the video clip
        clip = VideoFileClip(video_path)
        
        # Calculate position in seconds
        duration = clip.duration
        position_seconds = duration * position
        
        debug_log(f"Video duration: {duration}s, extracting at {position_seconds}s")
        
        # Get the frame at the specified position
        frame = clip.get_frame(position_seconds)
        
        # Save the frame as an image
        img = Image.fromarray(frame)
        img.save(thumbnail_path)
        
        # Close the clip
        clip.close()
        
        return True
    except Exception as e:
        logger.error(f"Error extracting thumbnail: {e}")
        return False

def try_delete_file(file_path):
    """Try to delete a file, ignoring errors."""
    try:
        if file_path and os.path.exists(file_path):
            os.remove(file_path)
            debug_log(f"Deleted file: {file_path}")
    except Exception as e:
        logger.error(f"Error deleting file {file_path}: {e}")

async def process_url(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    """Process URL input."""
    # Check if user is admin
    if not await check_admin(update):
        return ConversationHandler.END
    
    user_id = update.effective_user.id
    url = update.message.text.strip()
    
    if user_id not in user_data:
        await update.message.reply_text("Sorry, there was an error. Please start over.")
        return ConversationHandler.END
    
    # Simple URL validation
    if not url.startswith(('http://', 'https://')):
        await update.message.reply_text(
            "Please enter a valid URL starting with http:// or https://"
        )
        return WAITING_FOR_URL
    
    debug_log(f"URL received: {url}")
    user_data[user_id]['url'] = url
    save_session()
    
    await update.message.reply_text(
        "Now please enter the caption for your post. This will be displayed under the thumbnail."
    )
    return WAITING_FOR_CAPTION

async def process_caption(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    """Process caption input."""
    # Check if user is admin
    if not await check_admin(update):
        return ConversationHandler.END
    
    user_id = update.effective_user.id
    caption = update.message.text
    
    if user_id not in user_data:
        await update.message.reply_text("Sorry, there was an error. Please start over.")
        return ConversationHandler.END
    
    debug_log(f"Caption received (length: {len(caption)})")
    user_data[user_id]['caption'] = caption
    save_session()
    
    # Ask which channel to post to
    keyboard = [
        [InlineKeyboardButton("MOVIES Channel", callback_data=CALLBACK_MOVIES)],
        [InlineKeyboardButton("STUFF Channel", callback_data=CALLBACK_STUFF)]
    ]
    reply_markup = InlineKeyboardMarkup(keyboard)
    
    await update.message.reply_text(
        "Now, please select which channel to post to:",
        reply_markup=reply_markup
    )
    return WAITING_FOR_CHANNEL_SELECTION

async def select_channel_and_post(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    """Handle channel selection and post the content."""
    query = update.callback_query
    await query.answer()
    
    user_id = query.from_user.id
    debug_log(f"Channel selection callback from user {user_id}: {query.data}")
    
    # Check if user is admin
    if user_id != ADMIN_USER_ID:
        debug_log(f"Unauthorized user {user_id} attempted to select channel")
        await query.edit_message_text("You're not authorized to use this bot.")
        return ConversationHandler.END
    
    if user_id not in user_data:
        debug_log(f"No active session for user {user_id}")
        await query.edit_message_text("Sorry, there was an error. Please start over.")
        return ConversationHandler.END
    
    # Determine which channel was selected
    channel = None
    if query.data == CALLBACK_MOVIES:
        channel = MOVIES_CHANNEL
        debug_log(f"Selected MOVIES channel: {channel}")
    elif query.data == CALLBACK_STUFF:
        channel = STUFF_CHANNEL
        debug_log(f"Selected STUFF channel: {channel}")
    else:
        await query.edit_message_text("Invalid channel selection. Please try again.")
        return WAITING_FOR_CHANNEL_SELECTION
    
    # Get user data
    thumbnail_path = user_data[user_id].get('thumbnail_path')
    url = user_data[user_id].get('url')
    caption = user_data[user_id].get('caption')
    
    if not all([thumbnail_path, url, caption]):
        debug_log("Missing required data for posting")
        await query.edit_message_text("Missing required data. Please start over.")
        return ConversationHandler.END
    
    # Prepare inline keyboard with URL button
    keyboard = [
        [InlineKeyboardButton("🔗 Visit Link", url=url)]
    ]
    reply_markup = InlineKeyboardMarkup(keyboard)
    
    # Send post to channel
    try:
        debug_log(f"Sending post to channel {channel}")
        await query.edit_message_text("Sending post to channel...")
        
        with open(thumbnail_path, 'rb') as thumb_file:
            message = await context.bot.send_photo(
                chat_id=channel,
                photo=thumb_file,
                caption=caption,
                reply_markup=reply_markup
            )
        
        # Add to post history
        add_to_post_history(channel, caption, url, thumbnail_path)
        
        # Success message to admin including a link to the post
        message_link = f"https://t.me/{channel.replace('@', '')}/{message.message_id}"
        await query.message.reply_text(
            f"✅ Post successfully sent to {channel}!\n\n"
            f"View your post: {message_link}"
        )
        
        # Clean up files
        if 'video_path' in user_data[user_id]:
            try_delete_file(user_data[user_id]['video_path'])
        
        if 'thumbnails' in user_data[user_id]:
            for thumb in user_data[user_id]['thumbnails']:
                if thumb != thumbnail_path:  # Don't delete the selected thumbnail yet
                    try_delete_file(thumb)
        
        # Keep the thumbnail in the history folder
        
        # Clear user data
        del user_data[user_id]
        save_session()
        debug_log(f"Session cleared for user {user_id}")
        
        return ConversationHandler.END
        
    except Exception as e:
        logger.error(f"Error posting to channel: {e}")
        await query.edit_message_text(
            f"Sorry, there was an error posting to the channel: {str(e)}\n"
            "Please try again or contact the developer."
        )
        return ConversationHandler.END

async def error_handler(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Handle errors in the dispatcher."""
    logger.error(f"Exception while handling an update: {context.error}")
    
    # Send error message to admin
    try:
        if update:
            user_info = f" from user {update.effective_user.id}" if update.effective_user else ""
            debug_log(f"Error{user_info}: {context.error}")
            
            if update.effective_message:
                await update.effective_message.reply_text(
                    f"Sorry, an error occurred: {str(context.error)}\n\n"
                    "Please try again or contact the developer."
                )
    except Exception as e:
        logger.error(f"Error in error handler: {e}")

def main() -> None:
    """Start the bot."""
    # Load previous session and post history
    load_session()
    load_post_history()
    
    # Create the Application
    application = ApplicationBuilder().token(TOKEN).build()
    
    # Create a conversation handler
    conv_handler = ConversationHandler(
        entry_points=[
            CommandHandler("start", start),
            MessageHandler(filters.VIDEO & filters.ChatType.PRIVATE, process_video),
        ],
        states={
            WAITING_FOR_THUMBNAIL_SELECTION: [
                CallbackQueryHandler(select_thumbnail),
                MessageHandler(filters.TEXT & ~filters.COMMAND, handle_custom_thumbnail),
            ],
            WAITING_FOR_URL: [
                MessageHandler(filters.TEXT & ~filters.COMMAND, process_url),
            ],
            WAITING_FOR_CAPTION: [
                MessageHandler(filters.TEXT & ~filters.COMMAND, process_caption),
            ],
            WAITING_FOR_CHANNEL_SELECTION: [
                CallbackQueryHandler(select_channel_and_post),
            ],
        },
        fallbacks=[CommandHandler("cancel", cancel)],
    )
    
    # Create a broadcast conversation handler
    broadcast_handler = ConversationHandler(
        entry_points=[CommandHandler("broadcast", broadcast_command)],
        states={
            WAITING_FOR_BROADCAST_MESSAGE: [
                MessageHandler(filters.TEXT & ~filters.COMMAND, process_broadcast_message),
            ],
        },
        fallbacks=[CommandHandler("cancel", cancel)],
    )
    
    # Add conversation handlers
    application.add_handler(conv_handler)
    application.add_handler(broadcast_handler)
    
    # Add command handlers
    application.add_handler(CommandHandler("help", help_command))
    application.add_handler(CommandHandler("status", status_command))
    application.add_handler(CommandHandler("debug", toggle_debug))
    application.add_handler(CommandHandler("autostart", toggle_autostart))
    application.add_handler(CommandHandler("cleanup", cleanup_command))
    application.add_handler(CommandHandler("posts", posts_command))
    
    # Add error handler
    application.add_error_handler(error_handler)
    
    # Set up webhook or polling based on environment
    if USE_WEBHOOK and WEBHOOK_URL:
        debug_log(f"Starting bot with webhook at {WEBHOOK_URL}")
        application.run_webhook(
            listen="0.0.0.0",
            port=PORT,
            url_path=TOKEN,
            webhook_url=f"{WEBHOOK_URL}/{TOKEN}"
        )
    else:
        debug_log("Starting bot with polling")
        application.run_polling()

if __name__ == "__main__":
    main()
