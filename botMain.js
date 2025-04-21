const { Telegraf, Markup } = require('telegraf');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { v4: uuidv4 } = require('uuid');
const http = require('http');

// Import our modules
const ThumbnailGenerator = require('./thumbnailGenerator');
const FallbackHandler = require('./fallbackHandler');

// Get bot token from environment variable or use default
const BOT_TOKEN = process.env.BOT_TOKEN || '6866329408:AAE7bPEHzZQf2Dh6ccidxxJsWtD-Qj6GKdo';

// Set your channel IDs here
const CHANNELS = {
  STUFF: '@dailydiskwala',
  MOVIE: '@diskmoviee'
};

// List of admin user IDs who can use the bot
const ADMIN_IDS = [
  1352497419,
  1352497419
];

// Debug token to verify it's in the correct format
console.log(`Token starting with: ${BOT_TOKEN.substring(0, 5)}... (length: ${BOT_TOKEN.length})`);

// Initialize the bot
const bot = new Telegraf(BOT_TOKEN);
const tempDir = path.join(os.tmpdir(), 'telegram-thumbnails');

// Initialize our modules
const thumbnailGenerator = new ThumbnailGenerator(tempDir);
const fallbackHandler = new FallbackHandler(tempDir);

// Maximum accepted video size (1GB)
const MAX_VIDEO_SIZE = 1024 * 1024 * 1024;

// Create temp directory if it doesn't exist
if (!fs.existsSync(tempDir)) {
  fs.mkdirSync(tempDir, { recursive: true });
}

// Keep track of user states
const userStates = {};

// Admin check middleware
const adminCheckMiddleware = (ctx, next) => {
  const userId = ctx.from.id;
  if (ADMIN_IDS.includes(userId)) {
    return next();
  } else {
    return ctx.reply('Sorry, this bot is only available to administrators.');
  }
};

// Basic commands
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

// Admin commands
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
    ctx.reply('Bot Statistics:\n- Active since: Bot start time\n- Videos processed: Count\n- Posts made: Count');
  } catch (error) {
    console.error('Error in stats command:', error);
    ctx.reply('An error occurred while processing your command. Please try again.');
  }
});

// Handle incoming videos
bot.on('video', adminCheckMiddleware, async (ctx) => {
  try {
    const video = ctx.message.video;
    const userId = ctx.from.id;
    
    // Check file size
    if (video.file_size > MAX_VIDEO_SIZE) {
      return ctx.reply('Sorry, the video is too large. Maximum allowed size is 1GB.');
    }

    await ctx.reply('Processing your video. This may take a moment...');

    // Store video information
    userStates[userId] = {
      video: video,
      videoId: video.file_id,
      videoName: video.file_name || 'video.mp4',
      videoWidth: video.width,
      videoHeight: video.height,
      aspectRatio: video.width / video.height,
      duration: video.duration
    };
    
    // Process the video
    await processVideoForThumbnails(ctx, userId);
  } catch (error) {
    console.error('Error handling video:', error);
    ctx.reply('Sorry, there was an error processing your video. Please try again or upload a different video.');
    
    // Clean up
    cleanupTempFiles(userId);
  }
});

// Process videos with improved error handling
async function processVideoForThumbnails(ctx, userId) {
  const userState = userStates[userId];
  const video = userState.video;
  
  try {
    await ctx.reply('Analyzing video and preparing thumbnail extraction...');
    
    // Get file info from Telegram
    const fileInfo = await ctx.telegram.getFile(video.file_id);
    const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${fileInfo.file_path}`;
    
    // Video info for thumbnail generation
    const videoInfo = {
      duration: video.duration,
      width: video.width,
      height: video.height,
      file_name: video.file_name,
      file_size: video.file_size
    };
    
    // Try to generate thumbnails
    let thumbnails = await thumbnailGenerator.generateThumbnails(fileUrl, videoInfo);
    
    // If thumbnails generation failed completely, try fallbacks
    if (!thumbnails || thumbnails.length === 0) {
      console.log('Main thumbnail generation failed, trying fallbacks');
      
      // Try to extract Telegram's own thumbnail first
      const telegramThumbnail = await fallbackHandler.extractVideoThumbnail(ctx.telegram, video.file_id);
      
      if (telegramThumbnail) {
        thumbnails = [telegramThumbnail];
      } else {
        // Try creating a placeholder as final resort
        const placeholderThumbnail = await fallbackHandler.generatePlaceholderThumbnail(video.file_name);
        
        if (placeholderThumbnail) {
          thumbnails = [placeholderThumbnail];
        }
      }
    }
    
    if (thumbnails && thumbnails.length > 0) {
      // Successfully generated or obtained thumbnails
      userState.thumbnails = thumbnails;
      userState.waitingForThumbnailSelection = true;
      
      // If only one thumbnail, skip selection
      if (thumbnails.length === 1) {
        userState.selectedThumbnail = thumbnails[0];
        userState.waitingForThumbnailSelection = false;
        userState.waitingForUrl = true;
        
        await ctx.replyWithPhoto(
          { source: thumbnails[0] },
          { caption: 'Only one thumbnail could be generated. I\'ll use this one!' }
        );
        
        // Ask for URL
        ctx.reply('Now please send me the URL to include with this post:');
      } else {
        // Multiple thumbnails, ask for selection
        await ctx.reply('Choose one of these thumbnails by replying with the number (1-' + thumbnails.length + '):');
        
        // Send thumbnails
        for (let i = 0; i < thumbnails.length; i++) {
          await ctx.replyWithPhoto(
            { source: thumbnails[i] }, 
            { caption: `Thumbnail ${i + 1}` }
          );
        }
      }
    } else {
      // All generation methods failed, ask for manual upload
      await handleThumbnailGenerationError(ctx, userId);
    }
  } catch (error) {
    console.error('Error processing video for thumbnails:', error);
    // Ask user for manual thumbnail upload
    await handleThumbnailGenerationError(ctx, userId);
  }
}

// Handle text messages
bot.on('text', async (ctx) => {
  const userId = ctx.from.id;
  const userState = userStates[userId];
  
  // Check if user is in a known state
  if (!userState && !ADMIN_IDS.includes(userId)) {
    return ctx.reply('Please use /start to begin using the bot.');
  }
  
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
    
    // Handle thumbnail selection
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

// Handle manual thumbnail upload
bot.on('photo', adminCheckMiddleware, async (ctx) => {
  const userId = ctx.from.id;
  const userState = userStates[userId];
  
  if (userState && userState.waitingForManualThumbnail) {
    const photo = ctx.message.photo[ctx.message.photo.length - 1]; // Get the highest resolution
    const fileId = photo.file_id;
    
    try {
      // Download the manually uploaded thumbnail
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

// Error handling for thumbnail generation
async function handleThumbnailGenerationError(ctx, userId) {
  ctx.reply('I was unable to automatically extract thumbnails from your video. Please upload an image to use as a thumbnail instead.');
  
  // Update user state
  userStates[userId].waitingForManualThumbnail = true;
  userStates[userId].waitingForThumbnailSelection = false;
}

// Clean up temporary files
function cleanupTempFiles(userId) {
  const userState = userStates[userId];
  
  if (!userState) return;
  
  // Clean up thumbnails
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

// Launch bot with retry mechanism
let launchAttempts = 0;
const maxAttempts = 5;

const attemptLaunch = async () => {
  try {
    console.log(`Attempt ${launchAttempts + 1} to launch bot...`);
    await bot.launch();
    console.log('Bot successfully launched!');
    
    // Start the HTTP server once bot is launched
    server.listen(PORT, () => {
      console.log(`HTTP server running on port ${PORT}`);
    });
    
    // Add shutdown handlers
    process.once('SIGINT', () => {
      bot.stop('SIGINT');
      server.close();
      console.log('Bot stopped due to SIGINT');
    });
    process.once('SIGTERM', () => {
      bot.stop('SIGTERM');
      server.close();
      console.log('Bot stopped due to SIGTERM');
    });
    
  } catch (error) {
    launchAttempts++;
    console.error(`Failed to launch bot (attempt ${launchAttempts}):`, error);
    
    if (launchAttempts < maxAttempts) {
      const retryDelay = Math.pow(2, launchAttempts) * 1000; // Exponential backoff
      console.log(`Retrying in ${retryDelay / 1000} seconds...`);
      setTimeout(attemptLaunch, retryDelay);
    } else {
      console.error(`Failed to launch bot after ${maxAttempts} attempts. Giving up.`);
      process.exit(1);
    }
  }
};

// Start the launch sequence
console.log('Starting Telegram thumbnail generator bot...');
attemptLaunch();

// Export modules for testing if needed
module.exports = {
  bot,
  server,
  thumbnailGenerator,
  fallbackHandler
};
