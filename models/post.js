// Save this file as models/post.js
const mongoose = require('mongoose');

const postSchema = new mongoose.Schema({
  // Unique identifier for the post
  postId: {
    type: String,
    required: true,
    unique: true
  },
  // Content of the post
  caption: {
    type: String,
    required: true
  },
  // URL included in the post
  url: {
    type: String,
    required: true
  },
  // Channel where the post was sent
  channelId: {
    type: String,
    required: true
  },
  // Channel name (for readability)
  channelName: {
    type: String,
    required: true
  },
  // Path to the thumbnail on disk (if available)
  thumbnailPath: {
    type: String
  },
  // Telegram file ID for the thumbnail
  thumbnailFileId: {
    type: String
  },
  // Message ID in the channel
  messageId: {
    type: Number,
    required: true
  },
  // Whether this is a resent post
  isResend: {
    type: Boolean,
    default: false
  },
  // Reference to original post if this is a resend
  originalPostId: {
    type: String
  },
  // Who created the post
  createdBy: {
    type: Number,
    required: true
  },
  // When the post was created
  createdAt: {
    type: Date,
    default: Date.now
  }
});

// Create indexes for better query performance
postSchema.index({ channelId: 1, createdAt: -1 });
postSchema.index({ postId: 1 });
postSchema.index({ createdBy: 1 });
postSchema.index({ isResend: 1 });

const Post = mongoose.model('Post', postSchema);

module.exports = { Post };
