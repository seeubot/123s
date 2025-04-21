const mongoose = require('mongoose');

const userStateSchema = new mongoose.Schema({
  userId: {
    type: Number,
    required: true,
    index: true
  },
  sessionId: {
    type: String,
    index: true
  },
  // Video information
  videoId: String,
  videoName: String,
  videoWidth: Number,
  videoHeight: Number,
  aspectRatio: String,
  duration: Number,
  // Processing state
  thumbnails: [String], // Array of file paths
  selectedThumbnail: String,
  url: String,
  caption: String,
  selectedChannel: String,
  channelName: String,
  // State flags
  waitingForThumbnailSelection: {
    type: Boolean,
    default: false
  },
  waitingForManualThumbnail: {
    type: Boolean,
    default: false
  },
  waitingForUrl: {
    type: Boolean,
    default: false
  },
  waitingForCaption: {
    type: Boolean,
    default: false
  },
  waitingForChannelSelection: {
    type: Boolean,
    default: false
  },
  waitingForBroadcastMessage: {
    type: Boolean,
    default: false
  },
  // Timestamps
  createdAt: {
    type: Date,
    default: Date.now
  },
  lastUpdated: {
    type: Date,
    default: Date.now
  }
});

// Add expiration - automatically delete documents after 1 day of inactivity
userStateSchema.index({ lastUpdated: 1 }, { expireAfterSeconds: 86400 });

const UserState = mongoose.model('UserState', userStateSchema);

module.exports = { UserState };
