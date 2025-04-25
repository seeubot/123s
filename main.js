const { Telegraf, Markup } = require('telegraf');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { v4: uuidv4 } = require('uuid');
const http = require('http');
const mongoose = require('mongoose');
const rateLimit = require('telegraf-ratelimit');

// Import our modules
const ThumbnailGenerator = require('./thumbnailGenerator');
const FallbackHandler = require('./fallbackHandler');
const { UserState } = require('./models/userState');
const { logActivity, logError } = require('./utils/logger');

// Add Post model import
const { Post } = require('./models/post');

// Environment variables check
if (!process.env.BOT_TOKEN) {
  console.error('ERROR: BOT_TOKEN environment variable is not set!');
  process.exit(1);
}

if (!process.env.MONGODB_URI) {
  console.error('ERROR: MONGODB_URI environment variable is not set!');
  process.exit(1);
}

// Get bot token from environment variable
const BOT_TOKEN = process.env.BOT_TOKEN;

// Set your channel IDs here
const CHANNELS = {
  STUFF: '@dailydiskwala',
  MOVIE: '@diskmoviee'
};

// List of admin user IDs who can use the bot
const ADMIN_IDS = [
  1352497419,
  // Add additional admin IDs here
];

// Debug token length without revealing contents
console.log(`Token configuration verified (length: ${BOT_TOKEN.length})`);

// Initialize the bot
const bot = new Telegraf(BOT_TOKEN);
const tempDir = path.join(os.tmpdir(), 'telegram-thumbnails');

// Initialize our modules
const thumbnailGenerator = new ThumbnailGenerator(tempDir);
const fallbackHandler = new FallbackHandler(tempDir);

// Maximum accepted video size (1GB)
const MAX_VIDEO_SIZE = 1024 * 1024 * 1024;

// Number of posts per page for listing
const POSTS_PER_PAGE = 5;

// Create temp directory if it doesn't exist
if (!fs.existsSync(tempDir)) {
  fs.mkdirSync(tempDir, { recursive: true });
}

// Connect to MongoDB
mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
}).then(() => {
  console.log('Connected to MongoDB');
}).catch(err => {
  console.error('Failed to connect to MongoDB:', err);
  process.exit(1);
});

// Add rate limiting middleware
const limitConfig = {
  window: 5000, // 5 seconds
  limit: 3, // 3 messages per window
  onLimitExceeded: (ctx) => ctx.reply('Please slow down! You\'re sending messages too quickly.')
};

bot.use(rateLimit(limitConfig));

// Admin check middleware
const adminCheckMiddleware = async (ctx, next) => {
  const userId = ctx.from.id;
  
  // Log all attempted access
  logActivity(`Access attempt by user ${userId} (${ctx.from.username || 'no username'})`);
  
  if (ADMIN_IDS.includes(userId)) {
    return next();
  } else {
    logActivity(`Unauthorized access attempt by user ${userId}`);
    return ctx.reply('Sorry, this bot is only available to administrators.');
  }
};

// Basic commands
bot.start((ctx) => {
  try {
    logActivity(`User ${ctx.from.id} (${ctx.from.username || 'no username'}) started the bot`);
    ctx.reply('Welcome to Admin Thumbnail Generator Bot! Send me a video file (up to 1GB), and I\'ll generate thumbnails for you.');
  } catch (error) {
    logError('Error in start command:', error);
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
      '/stats - View bot usage statistics\n' +
      '/posts - List recent posts\n' +
      '/resend [postId] - Resend a specific post by ID\n' +
      '/recent [channel] - Show recent posts from a specific channel'
    );
  } catch (error) {
    logError('Error in help command:', error);
  }
});

// Admin commands
bot.command('broadcast', adminCheckMiddleware, async (ctx) => {
  try {
    // Store state in database
    await UserState.findOneAndUpdate(
      { userId: ctx.from.id },
      { 
        userId: ctx.from.id,
        waitingForBroadcastMessage: true,
        lastUpdated: new Date()
      },
      { upsert: true, new: true }
    );
    
    ctx.reply('Please send the message you want to broadcast to all channels.');
  } catch (error) {
    logError('Error in broadcast command:', error);
    ctx.reply('An error occurred while processing your command. Please try again.');
  }
});

bot.command('stats', adminCheckMiddleware, async (ctx) => {
  try {
    // Get post counts from database
    const totalPosts = await Post.countDocuments();
    const stuffPosts = await Post.countDocuments({ channelId: CHANNELS.STUFF });
    const moviePosts = await Post.countDocuments({ channelId: CHANNELS.MOVIE });
    const recentPosts = await Post.countDocuments({ createdAt: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } });
    
    ctx.reply(
      'Bot Statistics:\n' +
      `- Total posts: ${totalPosts}\n` +
      `- STUFF channel posts: ${stuffPosts}\n` +
      `- MOVIE channel posts: ${moviePosts}\n` +
      `- Posts in last 7 days: ${recentPosts}`
    );
  } catch (error) {
    logError('Error in stats command:', error);
    ctx.reply('An error occurred while processing your command. Please try again.');
  }
});

// New command for listing posts
bot.command('posts', adminCheckMiddleware, async (ctx) => {
  try {
    // Extract page number if provided
    const args = ctx.message.text.split(' ');
    const page = parseInt(args[1]) || 1;
    
    // Calculate skip value for pagination
    const skip = (page - 1) * POSTS_PER_PAGE;
    
    // Get total count for pagination
    const totalPosts = await Post.countDocuments();
    const totalPages = Math.ceil(totalPosts / POSTS_PER_PAGE);
    
    if (totalPosts === 0) {
      return ctx.reply('No posts found in the database.');
    }
    
    // Fetch posts with pagination, sorted by newest first
    const posts = await Post.find()
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(POSTS_PER_PAGE);
    
    if (posts.length === 0) {
      return ctx.reply(`No posts found on page ${page}. Total pages: ${totalPages}`);
    }
    
    // Format the posts list
    let message = `Posts (Page ${page}/${totalPages}):\n\n`;
    
    posts.forEach((post, index) => {
      const date = post.createdAt.toLocaleDateString();
      const time = post.createdAt.toLocaleTimeString();
      const channel = Object.keys(CHANNELS).find(key => CHANNELS[key] === post.channelId) || post.channelId;
      
      message += `${index + 1 + skip}. Post ID: ${post.postId}\n`;
      message += `📝 Caption: ${post.caption.substring(0, 30)}${post.caption.length > 30 ? '...' : ''}\n`;
      message += `📺 Channel: ${channel}\n`;
      message += `🕒 Posted: ${date} ${time}\n\n`;
    });
    
    // Add pagination info and instructions
    message += `Use /posts ${page + 1} to see the next page\n`;
    message += `Use /resend [postId] to resend a specific post`;
    
    ctx.reply(message);
  } catch (error) {
    logError('Error in posts command:', error);
    ctx.reply('An error occurred while retrieving posts. Please try again.');
  }
});

// New command for showing recent posts from a specific channel
bot.command('recent', adminCheckMiddleware, async (ctx) => {
  try {
    const args = ctx.message.text.split(' ');
    const channelName = args[1]?.toUpperCase();
    const page = parseInt(args[2]) || 1;
    
    if (!channelName || !CHANNELS[channelName]) {
      return ctx.reply(`Please specify a valid channel name: /recent [STUFF|MOVIE] [page]`);
    }
    
    const channelId = CHANNELS[channelName];
    const skip = (page - 1) * POSTS_PER_PAGE;
    
    // Get total count for this channel
    const totalPosts = await Post.countDocuments({ channelId });
    const totalPages = Math.ceil(totalPosts / POSTS_PER_PAGE);
    
    if (totalPosts === 0) {
      return ctx.reply(`No posts found for channel ${channelName}.`);
    }
    
    // Fetch posts for this channel
    const posts = await Post.find({ channelId })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(POSTS_PER_PAGE);
    
    if (posts.length === 0) {
      return ctx.reply(`No posts found on page ${page} for channel ${channelName}. Total pages: ${totalPages}`);
    }
    
    // Format the posts list
    let message = `Recent posts for ${channelName} (Page ${page}/${totalPages}):\n\n`;
    
    posts.forEach((post, index) => {
      const date = post.createdAt.toLocaleDateString();
      const time = post.createdAt.toLocaleTimeString();
      
      message += `${index + 1 + skip}. Post ID: ${post.postId}\n`;
      message += `📝 Caption: ${post.caption.substring(0, 30)}${post.caption.length > 30 ? '...' : ''}\n`;
      message += `🔗 URL: ${post.url}\n`;
      message += `🕒 Posted: ${date} ${time}\n\n`;
    });
    
    // Add pagination info and instructions
    message += `Use /recent ${channelName} ${page + 1} to see the next page\n`;
    message += `Use /resend [postId] to resend a specific post`;
    
    ctx.reply(message);
  } catch (error) {
    logError('Error in recent command:', error);
    ctx.reply('An error occurred while retrieving channel posts. Please try again.');
  }
});

// New command for resending a post
bot.command('resend', adminCheckMiddleware, async (ctx) => {
  try {
    const args = ctx.message.text.split(' ');
    const postId = args[1];
    
    if (!postId) {
      return ctx.reply('Please provide a post ID: /resend [postId]');
    }
    
    // Find the post in the database
    const post = await Post.findOne({ postId });
    
    if (!post) {
      return ctx.reply(`Post with ID ${postId} not found.`);
    }
    
    // Send a confirmation with post details and channel selection
    let message = `Post found! Details:\n\n`;
    message += `Caption: ${post.caption}\n`;
    message += `URL: ${post.url}\n`;
    message += `Original channel: ${Object.keys(CHANNELS).find(key => CHANNELS[key] === post.channelId) || post.channelId}\n\n`;
    message += `Select destination channel for repost:`;
    
    // Create keyboard with channel options
    const channelKeyboard = Markup.inlineKeyboard([
      [
        Markup.button.callback('STUFF', `resend_${postId}_STUFF`), 
        Markup.button.callback('MOVIE', `resend_${postId}_MOVIE`)
      ]
    ]);
    
    ctx.reply(message, channelKeyboard);
  } catch (error) {
    logError('Error in resend command:', error);
    ctx.reply('An error occurred while processing your resend request. Please try again.');
  }
});

// Handle resend action
bot.action(/resend_(.+)_(.+)/, adminCheckMiddleware, async (ctx) => {
  const postId = ctx.match[1];
  const channelName = ctx.match[2]; // STUFF or MOVIE
  
  try {
    await ctx.answerCbQuery(`Preparing to resend to ${channelName} channel...`);
    
    // Find the post in the database
    const post = await Post.findOne({ postId });
    
    if (!post) {
      return ctx.reply(`Post with ID ${postId} not found.`);
    }
    
    const channelId = CHANNELS[channelName];
    
    // Create inline keyboard with URL button and Request Video button
    const inlineKeyboard = Markup.inlineKeyboard([
      [Markup.button.url('Link mawas', post.url)],
      [Markup.button.url('Request Video', 'https://t.me/teraseeubot')]
    ]);
    
    ctx.reply(`Resending post to ${channelName} channel...`);
    
    // Check if we have the thumbnail file
    const thumbnailExists = post.thumbnailPath && fs.existsSync(post.thumbnailPath);
    let result;
    
    if (thumbnailExists) {
      // Resend with original thumbnail
      result = await ctx.telegram.sendPhoto(
        channelId,
        { source: post.thumbnailPath },
        { 
          caption: post.caption,
          reply_markup: inlineKeyboard.reply_markup
        }
      );
    } else {
      // If original thumbnail is unavailable, let's try to fetch from Telegram
      if (post.thumbnailFileId) {
        try {
          result = await ctx.telegram.sendPhoto(
            channelId,
            post.thumbnailFileId,
            { 
              caption: post.caption,
              reply_markup: inlineKeyboard.reply_markup
            }
          );
        } catch (thumbnailError) {
          logError('Error resending with thumbnail file ID:', thumbnailError);
          // If that also fails, send as text
          result = await ctx.telegram.sendMessage(
            channelId,
            `${post.caption}\n\nOriginal post resent by admin.`,
            { reply_markup: inlineKeyboard.reply_markup }
          );
        }
      } else {
        // No thumbnail info available, send as text
        result = await ctx.telegram.sendMessage(
          channelId,
          `${post.caption}\n\nOriginal post resent by admin.`,
          { reply_markup: inlineKeyboard.reply_markup }
        );
      }
    }
    
    logActivity(`Resent post ${postId} to ${channelId}`);
    
    // Create a new post entry for this resend
    const newPostId = uuidv4().substring(0, 8);
    const newPost = new Post({
      postId: newPostId,
      caption: post.caption,
      url: post.url,
      channelId: channelId,
      channelName: channelName,
      thumbnailFileId: result.photo ? result.photo[0].file_id : null,
      messageId: result.message_id,
      isResend: true,
      originalPostId: postId,
      createdBy: ctx.from.id
    });
    
    await newPost.save();
    
    ctx.reply(`Successfully resent post to ${channelId}! New post ID: ${newPostId}`);
  } catch (error) {
    logError('Error resending post:', error);
    ctx.reply('Sorry, there was an error resending the post. Please make sure the bot is an admin in the channel with posting permissions.');
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

    // Generate a unique session ID for this processing session
    const sessionId = uuidv4();
    
    // Store video information in database
    await UserState.findOneAndUpdate(
      { userId },
      {
        userId,
        sessionId,
        videoId: video.file_id,
        videoName: video.file_name || 'video.mp4',
        videoWidth: video.width,
        videoHeight: video.height,
        aspectRatio: (video.width / video.height).toFixed(2),
        duration: video.duration,
        lastUpdated: new Date()
      },
      { upsert: true, new: true }
    );
    
    // Process the video
    await processVideoForThumbnails(ctx, userId);
  } catch (error) {
    logError('Error handling video:', error);
    ctx.reply('Sorry, there was an error processing your video. Please try again or upload a different video.');
    
    // Clean up
    await cleanupTempFiles(ctx.from.id);
  }
});

// Process videos with improved error handling
async function processVideoForThumbnails(ctx, userId) {
  let userState;
  try {
    // Get user state from database
    userState = await UserState.findOne({ userId });
    
    if (!userState) {
      throw new Error('User state not found');
    }
    
    await ctx.reply('Analyzing video and preparing thumbnail extraction...');
    
    // Get file info from Telegram
    const fileInfo = await ctx.telegram.getFile(userState.videoId);
    const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${fileInfo.file_path}`;
    
    // Video info for thumbnail generation
    const videoInfo = {
      duration: userState.duration,
      width: userState.videoWidth,
      height: userState.videoHeight,
      file_name: userState.videoName,
      file_size: fileInfo.file_size
    };
    
    // Try to generate thumbnails
    let thumbnails = await thumbnailGenerator.generateThumbnails(fileUrl, videoInfo);
    
    // If thumbnails generation failed completely, try fallbacks
    if (!thumbnails || thumbnails.length === 0) {
      logActivity('Main thumbnail generation failed, trying fallbacks');
      
      // Try to extract Telegram's own thumbnail first
      const telegramThumbnail = await fallbackHandler.extractVideoThumbnail(ctx.telegram, userState.videoId);
      
      if (telegramThumbnail) {
        thumbnails = [telegramThumbnail];
      } else {
        // Try creating a placeholder as final resort
        const placeholderThumbnail = await fallbackHandler.generatePlaceholderThumbnail(userState.videoName);
        
        if (placeholderThumbnail) {
          thumbnails = [placeholderThumbnail];
        }
      }
    }
    
    if (thumbnails && thumbnails.length > 0) {
      // Store thumbnails paths in database
      userState.thumbnails = thumbnails;
      userState.waitingForThumbnailSelection = thumbnails.length > 1;
      
      await userState.save();
      
      // If only one thumbnail, skip selection
      if (thumbnails.length === 1) {
        userState.selectedThumbnail = thumbnails[0];
        userState.waitingForThumbnailSelection = false;
        userState.waitingForUrl = true;
        
        await userState.save();
        
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
    logError('Error processing video for thumbnails:', error);
    // Ask user for manual thumbnail upload
    await handleThumbnailGenerationError(ctx, userId);
  }
}

// Handle text messages
bot.on('text', adminCheckMiddleware, async (ctx) => {
  const userId = ctx.from.id;
  
  try {
    // Retrieve user state from database
    const userState = await UserState.findOne({ userId });
    
    if (!userState) {
      return ctx.reply('Please use /start to begin using the bot.');
    }
    
    // Handle broadcast message
    if (userState.waitingForBroadcastMessage) {
      const broadcastMessage = ctx.message.text;
      
      // Update user state
      userState.waitingForBroadcastMessage = false;
      await userState.save();
      
      ctx.reply('Broadcasting message to all channels...');
      
      // Send broadcast to all channels
      for (const [channelName, channelId] of Object.entries(CHANNELS)) {
        try {
          await ctx.telegram.sendMessage(
            channelId,
            broadcastMessage
          );
          logActivity(`Broadcast sent to ${channelName}`);
        } catch (error) {
          logError(`Error broadcasting to ${channelName}:`, error);
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
      
      // Update database
      userState.selectedThumbnail = selectedThumbnail;
      userState.waitingForThumbnailSelection = false;
      userState.waitingForUrl = true;
      await userState.save();
      
      // Ask for URL
      ctx.reply('Great! Now please send me the URL to include with this post:');
      
    } else if (userState.waitingForUrl) {
      // Save URL and ask for caption
      userState.url = ctx.message.text;
      userState.waitingForUrl = false;
      userState.waitingForCaption = true;
      await userState.save();
      
      ctx.reply('Thanks! Now please send me the caption for this post:');
      
    } else if (userState.waitingForCaption) {
      // Save caption and ask which channel to post to
      userState.caption = ctx.message.text;
      userState.waitingForCaption = false;
      userState.waitingForChannelSelection = true;
      await userState.save();
      
      // Create keyboard with channel options
      const channelKeyboard = Markup.inlineKeyboard([
        [
          Markup.button.callback('STUFF', 'channel_STUFF'), 
          Markup.button.callback('MOVIE', 'channel_MOVIE')
        ]
      ]);
      
      ctx.reply('Select which channel to post to:', channelKeyboard);
    }
  } catch (error) {
    logError('Error handling text message:', error);
    ctx.reply('Sorry, an error occurred. Please try again.');
  }
});

// Handle channel selection
bot.action(/channel_(.+)/, adminCheckMiddleware, async (ctx) => {
  const userId = ctx.from.id;
  const selectedChannel = ctx.match[1]; // STUFF or MOVIE
  
  try {
    // Retrieve user state from database
    const userState = await UserState.findOne({ userId });
    
    if (!userState) return;
    
    await ctx.answerCbQuery(`Selected ${selectedChannel} channel`);
    
    // Update database
    userState.selectedChannel = CHANNELS[selectedChannel];
    userState.channelName = selectedChannel;
    await userState.save();
    
    ctx.reply(`Preparing to post to ${selectedChannel} channel...`);
    
    // Post to channel
    await postToChannel(ctx, userId);
  } catch (error) {
    logError('Error handling channel selection:', error);
    ctx.reply('Sorry, there was an error with your channel selection. Please try again.');
  }
});

// Post to channel function
async function postToChannel(ctx, userId) {
  try {
    // Retrieve user state from database
    const userState = await UserState.findOne({ userId });
    
    if (!userState) {
      throw new Error('User state not found');
    }
    
    const channelId = userState.selectedChannel;
    const channelName = userState.channelName;
    
    // Create inline keyboard with URL button and Request Video button
    const inlineKeyboard = Markup.inlineKeyboard([
      [Markup.button.url('Link mawas', userState.url)],
      [Markup.button.url('Request Video', 'https://t.me/teraseeubot')]
    ]);
    
    // Verify thumbnail exists
    if (!userState.selectedThumbnail || !fs.existsSync(userState.selectedThumbnail)) {
      throw new Error('Selected thumbnail file not found');
    }
    
    // Post photo with caption and inline buttons to channel
    const result = await ctx.telegram.sendPhoto(
      channelId,
      { source: userState.selectedThumbnail },
      { 
        caption: userState.caption,
        reply_markup: inlineKeyboard.reply_markup
      }
    );
    
    logActivity(`Posted to ${channelId}`);
    
    // Generate a unique post ID for tracking
    const postId = uuidv4().substring(0, 8);
    
    // Save post information to database for future reference
    const post = new Post({
      postId: postId,
      caption: userState.caption,
      url: userState.url,
      channelId: channelId,
      channelName: userState.channelName,
      thumbnailPath: userState.selectedThumbnail,
      thumbnailFileId: result.photo[0].file_id, // Store Telegram's file_id for future use
      messageId: result.message_id,
      createdBy: userId
    });
    
    await post.save();
    
    ctx.reply(`Successfully posted to ${channelId}! Post ID: ${postId}`);
    
    // Clean up
    await cleanupTempFiles(userId);
  } catch (error) {
    logError('Error posting to channel:', error);
    ctx.reply('Sorry, there was an error posting to the channel. Please make sure the bot is an admin in the channel with posting permissions.');
  }
}

// Handle manual thumbnail upload
bot.on('photo', adminCheckMiddleware, async (ctx) => {
  const userId = ctx.from.id;
  
  try {
    // Retrieve user state from database
    const userState = await UserState.findOne({ userId });
    
    if (!userState || !userState.waitingForManualThumbnail) {
      return ctx.reply('Please send me a video first, then I can generate thumbnails for you.');
    }
    
    const photo = ctx.message.photo[ctx.message.photo.length - 1]; // Get the highest resolution
    const fileId = photo.file_id;
    
    // Download the manually uploaded thumbnail
    const thumbnailPath = await thumbnailGenerator.downloadThumbnailFromTelegram(fileId, BOT_TOKEN);
    
    if (thumbnailPath) {
      // Update database
      userState.selectedThumbnail = thumbnailPath;
      userState.waitingForManualThumbnail = false;
      userState.waitingForUrl = true;
      await userState.save();
      
      // Ask for URL
      ctx.reply('Thanks! Now please send me the URL to include with this post:');
    } else {
      throw new Error('Failed to download thumbnail');
    }
  } catch (error) {
    logError('Error handling manually uploaded thumbnail:', error);
    ctx.reply('Sorry, there was an error processing your thumbnail. Please try again.');
  }
});

// Error handling for thumbnail generation
async function handleThumbnailGenerationError(ctx, userId) {
  try {
    ctx.reply('I was unable to automatically extract thumbnails from your video. Please upload an image to use as a thumbnail instead.');
    
    // Update user state in database
    await UserState.findOneAndUpdate(
      { userId },
      { 
        waitingForManualThumbnail: true,
        waitingForThumbnailSelection: false
      }
    );
  } catch (error) {
    logError('Error handling thumbnail generation error:', error);
    ctx.reply('An error occurred. Please try starting over with /start');
  }
}

// Clean up temporary files with improved error handling
async function cleanupTempFiles(userId) {
  try {
    // Get user state from database
    const userState = await UserState.findOne({ userId });
    
    if (!userState) return;
    
    // Clean up thumbnails
    if (userState.thumbnails && Array.isArray(userState.thumbnails)) {
      for (const thumbnail of userState.thumbnails) {
        try {
          if (thumbnail && fs.existsSync(thumbnail)) {
            fs.unlinkSync(thumbnail);
            logActivity(`Deleted thumbnail: ${thumbnail}`);
          }
        } catch (err) {
          logError(`Error deleting thumbnail file ${thumbnail}:`, err);
        }
      }
    }
    
    // Don't delete selected thumbnail if it was saved to a post
    // Just check if the file exists first
    if (userState.selectedThumbnail && fs.existsSync(userState.selectedThumbnail)) {
      const recentPost = await Post.findOne({ thumbnailPath: userState.selectedThumbnail });
      
      if (!recentPost) {
        // If not used in a post, delete it
        try {
          fs.unlinkSync(userState.selectedThumbnail);
          logActivity(`Deleted selected thumbnail: ${userState.selectedThumbnail}`);
        } catch (err) {
          logError(`Error deleting selected thumbnail file ${userState.selectedThumbnail}:`, err);
        }
      }
    }
    
    // Reset state but keep userId
    await UserState.findOneAndUpdate(
      { userId },
      {
        $unset: {
          sessionId: "",
          videoId: "",
          videoName: "",
          videoWidth: "",
          videoHeight: "",
          aspectRatio: "",
          duration: "",
          thumbnails: "",
          selectedThumbnail: "",
          waitingForThumbnailSelection: "",
          waitingForManualThumbnail: "",
          waitingForUrl: "",
          waitingForCaption: "",
          waitingForChannelSelection: "",
          waitingForBroadcastMessage: "",
          url: "",
          caption: "",
          selectedChannel: "",
          channelName: ""
        },
        lastUpdated: new Date()
      }
    );
    
    logActivity(`Cleaned up state for user ${userId}`);
  } catch (error) {
    logError('Error cleaning up temp files:', error);
  }
}

// Set up a simple keepalive server if running on a hosting platform
const server = http.createServer((req, res) => {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/plain');
  res.end('Bot server running\n');
});

server.listen(process.env.PORT || 3000, () => {
  console.log(`Server running on port ${process.env.PORT || 3000}`);
});

// Handle bot errors gracefully
bot.catch((err, ctx) => {
  logError('Global error handler caught:', err);
  
  // Try to notify the user
  try {
    if (ctx && ctx.reply) {
      ctx.reply('An error occurred while processing your request. The issue has been logged and will be investigated.');
    }
  } catch (replyErr) {
    logError('Error in error handler:', replyErr);
  }
});

// Start the bot
bot.launch()
  .then(() => {
    console.log('Bot started successfully');
    logActivity('Bot started');
  })
  .catch(err => {
    console.error('Failed to start bot:', err);
    logError('Bot startup failed:', err);
    process.exit(1);
  });

// Enable graceful stop
process.once('SIGINT', () => {
  logActivity('Bot stopping due to SIGINT');
  bot.stop('SIGINT');
});

process.once('SIGTERM', () => {
  logActivity('Bot stopping due to SIGTERM');
  bot.stop('SIGTERM');
});

// Export the bot instance for testing purposes
module.exports = { bot };
