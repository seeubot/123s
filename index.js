// Advanced Video Thumbnail Generator Bot for Telegram
// Features:
// - Handles videos up to 1GB
// - Generates thumbnails without full download
// - Admin-only access control
// - Multiple channel posting options
// - Inline URL buttons & join channel buttons
// - Broadcasting capability
// - HTTP health check server for hosting platform compatibility

const { Telegraf, Markup } = require('telegraf');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const os = require('os');
const { v4: uuidv4 } = require('uuid');
const http = require('http');

// Import ffmpeg-static and set it up with fluent-ffmpeg
const ffmpegPath = require('ffmpeg-static');
const ffmpeg = require('fluent-ffmpeg');
ffmpeg.setFfmpegPath(ffmpegPath);

// Get bot token from environment variable or use default
const BOT_TOKEN = process.env.BOT_TOKEN || '6866329408:AAGbn9Cd6V5f10TcNsec4h9yTposBWd2okI';

// IMPORTANT: Set your channel IDs here
const CHANNELS = {
  STUFF: '@dailydiskwala',
  MOVIE: '@diskmoviee' // Replace with your movie channel ID
};

// IMPORTANT: List of admin user IDs who can use the bot
const ADMIN_IDS = [
  1352497419, // Replace with actual admin Telegram IDs
  1352497419  // Add more admin IDs as needed
];

// Check if the token is a placeholder
if (BOT_TOKEN === 'YOUR_ACTUAL_BOT_TOKEN_HERE') {
  console.error('Error: Please replace the placeholder with your actual bot token!');
  process.exit(1);
}

// Debug token to verify it's in the correct format
console.log(`Token starting with: ${BOT_TOKEN.substring(0, 5)}... (length: ${BOT_TOKEN.length})`);

// Initialize the bot
const bot = new Telegraf(BOT_TOKEN);
const tempDir = path.join(os.tmpdir(), 'telegram-thumbnails');

// Maximum accepted video size (1GB)
const MAX_VIDEO_SIZE = 1024 * 1024 * 1024;

// Create temp directory if it doesn't exist
if (!fs.existsSync(tempDir)) {
  fs.mkdirSync(tempDir, { recursive: true });
}

// Keep track of user states
const userStates = {};

// Admin check middleware - FIXED: Now this only applies to feature commands, not /start or /help
const adminCheckMiddleware = (ctx, next) => {
  const userId = ctx.from.id;
  if (ADMIN_IDS.includes(userId)) {
    return next();
  } else {
    return ctx.reply('Sorry, this bot is only available to administrators.');
  }
};

// Allow anyone to access basic commands
bot.start((ctx) => {
  try {
    console.log(`User ${ctx.from.id} (${ctx.from.username || 'no username'}) started the bot`);
    ctx.reply('Welcome to Admin Thumbnail Generator Bot! Send me a video file (up to 1GB), and I\'ll generate thumbnails for you.');
  } catch (error) {
    console.error('Error in start command:', error);
  }
});

bot.help((ctx) => {
  try {
    ctx.reply(
      'This bot generates thumbnails from your videos and can post to channels. Here\'s how to use it:\n\n' +
      '1. Send a video file (up to 1GB)\n' +
      '2. I\'ll generate thumbnails without downloading the whole video\n' +
      '3. Choose one as your final thumbnail\n' +
      '4. I\'ll ask for a URL and caption\n' +
      '5. Select which channel to post to\n' +
      '6. I\'ll post everything to the channel with URL buttons\n\n' +
      'Admin commands:\n' +
      '/broadcast - Send message to all channels\n' +
      '/stats - View bot usage statistics'
    );
  } catch (error) {
    console.error('Error in help command:', error);
  }
});

// Apply admin check to feature commands
bot.command('broadcast', adminCheckMiddleware, async (ctx) => {
  try {
    userStates[ctx.from.id] = {
      waitingForBroadcastMessage: true
    };
    
    ctx.reply('Please send the message you want to broadcast to all channels.');
  } catch (error) {
    console.error('Error in broadcast command:', error);
    ctx.reply('An error occurred while processing your command. Please try again.');
  }
});

bot.command('stats', adminCheckMiddleware, async (ctx) => {
  try {
    // You can implement actual stats here
    ctx.reply('Bot Statistics:\n- Active since: Bot start time\n- Videos processed: Count\n- Posts made: Count');
  } catch (error) {
    console.error('Error in stats command:', error);
    ctx.reply('An error occurred while processing your command. Please try again.');
  }
});

// Handle incoming videos - apply admin check
bot.on('video', adminCheckMiddleware, async (ctx) => {
  try {
    const video = ctx.message.video;
    const userId = ctx.from.id;
    
    // Check file size (limit to 1GB)
    if (video.file_size > MAX_VIDEO_SIZE) {
      return ctx.reply('Sorry, the video is too large. Maximum allowed size is 1GB.');
    }

    // Store video information in user state
    userStates[userId] = {
      video: video,
      videoId: video.file_id,
      videoName: video.file_name || 'video.mp4',
      videoWidth: video.width,
      videoHeight: video.height,
      aspectRatio: video.width / video.height
    };
    
    // Process the video thumbnail generation without downloading the entire file
    await processVideoForThumbnails(ctx, userId);
  } catch (error) {
    console.error('Error handling video:', error);
    ctx.reply('Sorry, there was an error processing your video. Please try again or upload a different video.');
    
    // Clean up any temporary files
    cleanupTempFiles(ctx.from.id);
  }
});

// Process videos for thumbnail generation using stream processing
async function processVideoForThumbnails(ctx, userId) {
  const userState = userStates[userId];
  const video = userState.video;
  
  try {
    ctx.reply('Processing your video to generate thumbnails...');
    
    // Get file info from Telegram
    const fileInfo = await ctx.telegram.getFile(video.file_id);
    const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${fileInfo.file_path}`;
    
    // Generate thumbnails directly from the stream
    await generateThumbnailsFromStream(ctx, userId, fileUrl);
  } catch (error) {
    console.error('Error processing video for thumbnails:', error);
    // If any error occurs, fall back to manual thumbnail upload
    handleThumbnailGenerationError(ctx, userId);
  }
}

// Generate thumbnails from video stream without downloading the entire file
async function generateThumbnailsFromStream(ctx, userId, fileUrl) {
  const userState = userStates[userId];
  const videoDuration = userState.video.duration;
  const aspectRatio = userState.aspectRatio;
  
  ctx.reply('Generating thumbnails while preserving the original aspect ratio...');
  
  // Generate 5 thumbnails at different positions in the video
  const thumbnails = [];
  const timestamps = [0.1, 0.25, 0.5, 0.75, 0.9].map(fraction => videoDuration * fraction);
  
  try {
    // Calculate dimensions preserving aspect ratio
    let width = 320;
    let height = Math.round(width / aspectRatio);
    
    // If height exceeds 240, recalculate to ensure height is 240 max
    if (height > 240) {
      height = 240;
      width = Math.round(height * aspectRatio);
    }
    
    // Generate thumbnails
    for (let i = 0; i < timestamps.length; i++) {
      const timestamp = timestamps[i];
      const thumbnailPath = path.join(tempDir, `thumbnail-${uuidv4()}.jpg`);
      
      await new Promise((resolve, reject) => {
        // Use ffmpeg to extract a frame directly from the stream
        ffmpeg(fileUrl)
          .inputOptions([
            // Seek to position before input to speed up extraction
            `-ss ${timestamp}`
          ])
          .outputOptions([
            // Only read a small portion of the file
            '-frames:v 1',
            `-s ${width}x${height}`
          ])
          .output(thumbnailPath)
          .on('end', () => {
            thumbnails.push(thumbnailPath);
            resolve();
          })
          .on('error', (err) => {
            console.error(`Error generating thumbnail ${i + 1}:`, err);
            reject(err);
          })
          .run();
      });
    }
    
    // Send thumbnails to user and ask to choose one
    ctx.reply('Choose one of these thumbnails by replying with the number (1-5):');
    
    // Store thumbnails in user state
    userState.thumbnails = thumbnails;
    userState.waitingForThumbnailSelection = true;
    
    // Send each thumbnail
    for (let i = 0; i < thumbnails.length; i++) {
      await ctx.replyWithPhoto({ source: thumbnails[i] }, { caption: `Thumbnail ${i + 1}` });
    }
  } catch (thumbnailError) {
    console.error('Error generating thumbnails:', thumbnailError);
    // Error in thumbnail generation, ask user to upload an image
    handleThumbnailGenerationError(ctx, userId);
  }
}

// Handle text messages - apply admin check only for users in specific state
bot.on('text', async (ctx) => {
  const userId = ctx.from.id;
  const userState = userStates[userId];
  
  // If not in a state, only admins should get a response
  if (!userState && !ADMIN_IDS.includes(userId)) {
    return ctx.reply('Please use /start to begin using the bot.');
  }
  
  // If we have a state, this user is already authenticated
  if (!userState) return;
  
  try {
    // Handle broadcast message
    if (userState.waitingForBroadcastMessage) {
      const broadcastMessage = ctx.message.text;
      userState.waitingForBroadcastMessage = false;
      
      ctx.reply('Broadcasting message to all channels...');
      
      // Send broadcast to all channels
      for (const [channelName, channelId] of Object.entries(CHANNELS)) {
        try {
          await ctx.telegram.sendMessage(
            channelId,
            broadcastMessage
          );
        } catch (error) {
          console.error(`Error broadcasting to ${channelName}:`, error);
        }
      }
      
      ctx.reply('Broadcast completed!');
      return;
    }
    
    if (userState.waitingForThumbnailSelection) {
      const choice = parseInt(ctx.message.text);
      
      if (isNaN(choice) || choice < 1 || choice > userState.thumbnails.length) {
        return ctx.reply(`Please enter a valid number between 1 and ${userState.thumbnails.length}.`);
      }
      
      const selectedThumbnail = userState.thumbnails[choice - 1];
      userState.selectedThumbnail = selectedThumbnail;
      userState.waitingForThumbnailSelection = false;
      userState.waitingForUrl = true;
      
      // Ask for URL
      ctx.reply('Great! Now please send me the URL to include with this post:');
      
    } else if (userState.waitingForUrl) {
      // Save URL and ask for caption
      userState.url = ctx.message.text;
      userState.waitingForUrl = false;
      userState.waitingForCaption = true;
      
      ctx.reply('Thanks! Now please send me the caption for this post:');
      
    } else if (userState.waitingForCaption) {
      // Save caption and ask which channel to post to
      userState.caption = ctx.message.text;
      userState.waitingForCaption = false;
      userState.waitingForChannelSelection = true;
      
      // Create keyboard with channel options
      const channelKeyboard = Markup.inlineKeyboard([
        [Markup.button.callback('STUFF', 'channel_STUFF'), Markup.button.callback('MOVIE', 'channel_MOVIE')]
      ]);
      
      ctx.reply('Select which channel to post to:', channelKeyboard);
    }
  } catch (error) {
    console.error('Error handling text message:', error);
    ctx.reply('Sorry, an error occurred. Please try again.');
  }
});

// Handle channel selection
bot.action(/channel_(.+)/, async (ctx) => {
  const userId = ctx.from.id;
  const userState = userStates[userId];
  const selectedChannel = ctx.match[1]; // STUFF or MOVIE
  
  if (!userState) return;
  
  try {
    await ctx.answerCbQuery(`Selected ${selectedChannel} channel`);
    userState.selectedChannel = CHANNELS[selectedChannel];
    userState.channelName = selectedChannel;
    
    ctx.reply(`Preparing to post to ${selectedChannel} channel...`);
    
    // Post to channel
    await postToChannel(ctx, userId);
  } catch (error) {
    console.error('Error handling channel selection:', error);
    ctx.reply('Sorry, there was an error with your channel selection. Please try again.');
  }
});

// Post to channel function
async function postToChannel(ctx, userId) {
  const userState = userStates[userId];
  const channelId = userState.selectedChannel;
  const channelName = userState.channelName;
  
  try {
    // Create inline keyboard with URL button and join channel button
    const joinButton = `Join ${channelName}`;
    const channelUrl = `https://t.me/${channelId.replace('@', '')}`;
    
    const inlineKeyboard = Markup.inlineKeyboard([
      [Markup.button.url('Visit Website', userState.url)],
      [Markup.button.url(joinButton, channelUrl)]
    ]);
    
    // Post photo with caption and inline buttons to channel
    await ctx.telegram.sendPhoto(
      channelId,
      { source: userState.selectedThumbnail },
      { 
        caption: userState.caption,
        reply_markup: inlineKeyboard.reply_markup
      }
    );
    
    ctx.reply(`Successfully posted to ${channelId}!`);
    
    // Clean up
    cleanupTempFiles(userId);
  } catch (error) {
    console.error('Error posting to channel:', error);
    ctx.reply('Sorry, there was an error posting to the channel. Please make sure the bot is an admin in the channel with posting permissions.');
  }
}

// Handle manual thumbnail upload - apply admin check
bot.on('photo', adminCheckMiddleware, async (ctx) => {
  const userId = ctx.from.id;
  const userState = userStates[userId];
  
  if (userState && userState.waitingForManualThumbnail) {
    const photo = ctx.message.photo[ctx.message.photo.length - 1]; // Get the highest resolution
    const fileId = photo.file_id;
    
    try {
      // Get file info from Telegram
      const fileInfo = await ctx.telegram.getFile(fileId);
      const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${fileInfo.file_path}`;
      
      // Generate a unique filename for the thumbnail
      const thumbnailPath = path.join(tempDir, `manual-thumbnail-${uuidv4()}.jpg`);
      
      // Download the photo
      const response = await axios({
        method: 'GET',
        url: fileUrl,
        responseType: 'stream'
      });
      
      const writer = fs.createWriteStream(thumbnailPath);
      response.data.pipe(writer);
      
      await new Promise((resolve, reject) => {
        writer.on('finish', resolve);
        writer.on('error', reject);
      });
      
      userState.selectedThumbnail = thumbnailPath;
      userState.waitingForManualThumbnail = false;
      userState.waitingForUrl = true;
      
      // Ask for URL
      ctx.reply('Thanks! Now please send me the URL to include with this post:');
    } catch (error) {
      console.error('Error handling manually uploaded thumbnail:', error);
      ctx.reply('Sorry, there was an error processing your thumbnail. Please try again.');
    }
  } else {
    ctx.reply('Please send me a video first, then I can generate thumbnails for you.');
  }
});

// Handle errors in thumbnail generation
function handleThumbnailGenerationError(ctx, userId) {
  ctx.reply('I couldn\'t generate thumbnails from your video. Please upload an image to use as a thumbnail.');
  
  // Update user state
  userStates[userId].waitingForManualThumbnail = true;
  userStates[userId].waitingForThumbnailSelection = false;
}

// Clean up temporary files
function cleanupTempFiles(userId) {
  const userState = userStates[userId];
  
  if (!userState) return;
  
  // Delete thumbnail files
  if (userState.thumbnails) {
    userState.thumbnails.forEach(thumbnail => {
      if (fs.existsSync(thumbnail)) {
        try {
          fs.unlinkSync(thumbnail);
        } catch (err) {
          console.error(`Error deleting thumbnail file ${thumbnail}:`, err);
        }
      }
    });
  }
  
  // Delete selected thumbnail if exists
  if (userState.selectedThumbnail && fs.existsSync(userState.selectedThumbnail)) {
    try {
      fs.unlinkSync(userState.selectedThumbnail);
    } catch (err) {
      console.error(`Error deleting selected thumbnail file ${userState.selectedThumbnail}:`, err);
    }
  }
  
  // Clear user state
  delete userStates[userId];
}

// Create HTTP server for health checks
const PORT = process.env.PORT || 8000;
const server = http.createServer((req, res) => {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/plain');
  res.end('Bot is running!\n');
});

// Handle errors in both the HTTP server and the bot
bot.catch((err, ctx) => {
  console.error(`Bot error for ${ctx.updateType}:`, err);
  // Try to notify user of error
  try {
    ctx.reply('Sorry, an error occurred processing your request. Please try again.');
  } catch (replyErr) {
    console.error('Error sending error notification:', replyErr);
  }
});

// Start HTTP server first, then launch the bot
server.listen(PORT, () => {
  console.log(`Health check server running on port ${PORT}`);
  
  // Test connection before fully launching
  console.log('Testing connection to Telegram API...');
  bot.telegram.getMe()
    .then(botInfo => {
      console.log(`Connection successful! Bot info:`, botInfo);
      console.log(`Bot name: ${botInfo.first_name}, Username: @${botInfo.username}`);
      
      // Start the bot after successful connection test
      console.log('Starting bot...');
      return bot.launch();
    })
    .then(() => {
      console.log('Bot started successfully!');
    })
    .catch(err => {
      console.error('Failed to connect to Telegram API:', err.message);
      if (err.response) {
        console.error('Response details:', err.response.data);
      }
      console.error('\nPossible issues:');
      console.error('1. Bot token may be invalid - double-check with BotFather');
      console.error('2. Network connectivity issues');
      console.error('3. Telegram API might be blocked on your network');
      process.exit(1);
    });
});

// Enhanced error handling for the HTTP server
server.on('error', (err) => {
  console.error('HTTP server error:', err);
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Try a different port.`);
    process.exit(1);
  }
});

// Enable graceful stop
process.once('SIGINT', () => {
  console.log('Received SIGINT. Shutting down gracefully...');
  bot.stop('SIGINT');
  server.close(() => {
    console.log('HTTP server closed.');
  });
});

process.once('SIGTERM', () => {
  console.log('Received SIGTERM. Shutting down gracefully...');
  bot.stop('SIGTERM');
  server.close(() => {
    console.log('HTTP server closed.');
  });
});

// Handle uncaught exceptions and unhandled promise rejections to prevent crashes
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
  // Don't exit process, just log the error
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  // Don't exit process, just log the error
});
