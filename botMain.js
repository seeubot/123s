const { Telegraf, Markup } = require('telegraf');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { v4: uuidv4 } = require('uuid');
const http = require('http');

// Import our thumbnail generator module
const ThumbnailGenerator = require('./thumbnailGenerator');

// Get bot token from environment variable or use default
const BOT_TOKEN = process.env.BOT_TOKEN || '6866329408:AAE7bPEHzZQf2Dh6ccidxxJsWtD-Qj6GKdo';

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

// Initialize thumbnail generator
const thumbnailGenerator = new ThumbnailGenerator(tempDir);

// Maximum accepted video size (1GB)
const MAX_VIDEO_SIZE = 1024 * 1024 * 1024;

// Create temp directory if it doesn't exist
if (!fs.existsSync(tempDir)) {
  fs.mkdirSync(tempDir, { recursive: true });
}

// Keep track of user states
const userStates = {};

// Admin check middleware - Only applies to feature commands, not /start or /help
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

    await ctx.reply('Processing your video. This might take a moment for larger files...');

    // Store video information in user state
    userStates[userId] = {
      video: video,
      videoId: video.file_id,
      videoName: video.file_name || 'video.mp4',
      videoWidth: video.width,
      videoHeight: video.height,
      aspectRatio: video.width / video.height
    };
    
    // Process the video thumbnail generation
    await processVideoForThumbnails(ctx, userId);
  } catch (error) {
    console.error('Error handling video:', error);
    ctx.reply('Sorry, there was an error processing your video. Please try again or upload a different video.');
    
    // Clean up any temporary files
    cleanupTempFiles(userId);
  }
});

// Process videos for thumbnail generation using our external module
async function processVideoForThumbnails(ctx, userId) {
  const userState = userStates[userId];
  const video = userState.video;
  
  try {
    await ctx.reply('Analyzing video and preparing thumbnail extraction...');
    
    // Get file info from Telegram
    const fileInfo = await ctx.telegram.getFile(video.file_id);
    const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${fileInfo.file_path}`;
    
    // Use our thumbnail generator module
    const videoInfo = {
      duration: video.duration,
      width: video.width,
      height: video.height
    };
    
    const thumbnails = await thumbnailGenerator.generateThumbnails(fileUrl, videoInfo);
    
    if (thumbnails && thumbnails.length > 0) {
      // Successfully generated thumbnails
      userState.thumbnails = thumbnails;
      userState.waitingForThumbnailSelection = true;
      
      await ctx.reply('Choose one of these thumbnails by replying with the number (1-' + thumbnails.length + '):');
      
      // Send each thumbnail with its number
      for (let i = 0; i < thumbnails.length; i++) {
        await ctx.replyWithPhoto(
          { source: thumbnails[i] }, 
          { caption: `Thumbnail ${i + 1}` }
        );
      }
    } else {
      // If thumbnail generation failed, ask for manual upload
      await handleThumbnailGenerationError(ctx, userId);
    }
  } catch (error) {
    console.error('Error processing video for thumbnails:', error);
    // Ask user for manual thumbnail upload
    await handleThumbnailGenerationError(ctx, userId);
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
      // Use our thumbnail generator module to download the photo
      const thumbnailPath = await thumbnailGenerator.downloadThumbnailFromTelegram(fileId, BOT_TOKEN);
      
      if (thumbnailPath) {
        userState.selectedThumbnail = thumbnailPath;
        userState.waitingForManualThumbnail = false;
        userState.waitingForUrl = true;
        
        // Ask for URL
        ctx.reply('Thanks! Now please send me the URL to include with this post:');
      } else {
        throw new Error('Failed to download thumbnail');
      }
    } catch (error) {
      console.error('Error handling manually uploaded thumbnail:', error);
      ctx.reply('Sorry, there was an error processing your thumbnail. Please try again.');
    }
  } else {
    ctx.reply('Please send me a video first, then I can generate thumbnails for you.');
  }
});

// Improved error handling in thumbnail generation
async function handleThumbnailGenerationError(ctx, userId) {
  ctx.reply('I was unable to automatically extract thumbnails from your video due to its format or size. Please upload an image to use as a thumbnail instead.');
  
  // Update user state
  userStates[userId].waitingForManualThumbnail = true;
  userStates[userId].waitingForThumbnailSelection = false;
}

// Clean up temporary files
function cleanupTempFiles(userId) {
  const userState = userStates[userId];
  
  if (!userState) return;
  
  // Use our thumbnail generator to clean up thumbnails
  if (userState.thumbnails) {
    thumbnailGenerator.cleanupThumbnails(userState.thumbnails);
  }
  
  // Handle selected thumbnail separately
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

// Modified launch process with retry and conflict resolution
let launchAttempts = 0;
const maxAttempts = 5;

const attemptLaunch = () => {
  console.log(`Attempt ${launchAttempts + 1} to start the bot...`);
  
  bot.telegram.getMe()
    .then(botInfo => {
      console.log(`Connection successful! Bot info:`, botInfo);
      console.log(`Bot name: ${botInfo.first_name}, Username: @${botInfo.username}`);
      
      // Add launch options to avoid polling conflicts
      const launchOptions = {
        dropPendingUpdates: true // This ignores all pending updates when bot starts
      };
      
      return bot.launch(launchOptions);
    })
    .then(() => {
      console.log('Bot started successfully!');
      launchAttempts = 0; // Reset attempts counter on success
    })
    .catch(err => {
      console.error('Failed to connect to Telegram API:', err.message);
      
      if (err.message.includes('409: Conflict')) {
        console.log('Detected conflict with another bot instance. Waiting for it to release...');
        
        // Wait 10 seconds before retrying
        setTimeout(() => {
          if (launchAttempts < maxAttempts) {
            launchAttempts++;
            attemptLaunch();
          } else {
            console.error('Maximum retry attempts reached. Please ensure no other bot instances are running and restart manually.');
            process.exit(1);
          }
        }, 10000);
      } else if (err.response) {
        console.error('Response details:', err.response.data);
        console.error('\nPossible issues:');
        console.error('1. Bot token may be invalid - double-check with BotFather');
        console.error('2. Network connectivity issues');
        console.error('3. Telegram API might be blocked on your network');
        process.exit(1);
      }
    });
};

// Start HTTP server first, then launch the bot
server.listen(PORT, () => {
  console.log(`Health check server running on port ${PORT}`);
  attemptLaunch();
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
