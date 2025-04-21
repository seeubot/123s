const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');

// Import ffmpeg-static and set it up with fluent-ffmpeg
const ffmpegPath = require('ffmpeg-static');
const ffmpeg = require('fluent-ffmpeg');
ffmpeg.setFfmpegPath(ffmpegPath);

class ThumbnailGenerator {
  constructor(tempDir) {
    this.tempDir = tempDir;
    
    // Create temp directory if it doesn't exist
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
  }

  // Generate thumbnails using different approaches based on video characteristics
  async generateThumbnails(fileUrl, videoInfo) {
    try {
      const { duration, width, height } = videoInfo;
      const aspectRatio = width / height;
      
      // Try primary approach first
      console.log('Attempting primary thumbnail generation approach');
      const thumbnails = await this.generateKeyFrameThumbnails(fileUrl, duration, aspectRatio);
      
      if (thumbnails && thumbnails.length > 0) {
        return thumbnails;
      }
      
      // If primary approach fails, try secondary approach
      console.log('Primary approach failed, trying secondary approach');
      return await this.generateTimestampThumbnails(fileUrl, duration, aspectRatio);
    } catch (error) {
      console.error('All thumbnail generation methods failed:', error);
      return null;
    }
  }
  
  // Primary method: Generate thumbnails based on key frames
  async generateKeyFrameThumbnails(fileUrl, videoDuration, aspectRatio) {
    try {
      // Calculate optimal dimensions
      const { width, height } = this._calculateDimensions(aspectRatio);
      
      // Define strategic timestamps for different video types
      const timestamps = this._getStrategicTimestamps(videoDuration);
      const thumbnails = [];
      
      // Generate thumbnails for each strategic timestamp
      for (const timestamp of timestamps) {
        const thumbnailPath = path.join(this.tempDir, `thumbnail-${uuidv4()}.jpg`);
        
        await new Promise((resolve, reject) => {
          const command = ffmpeg(fileUrl)
            .inputOptions([`-ss ${timestamp}`])
            .outputOptions([
              '-frames:v 1',
              `-s ${width}x${height}`,
              '-q:v 2',
              // Add filters for better quality thumbnails
              '-vf eq=contrast=1.1:brightness=0.05:saturation=1.2'
            ])
            .output(thumbnailPath);
          
          // Add timeout handling
          const timeout = setTimeout(() => {
            command.kill('SIGKILL');
            reject(new Error('Thumbnail generation timed out'));
          }, 60000); // 60 second timeout
          
          command
            .on('end', () => {
              clearTimeout(timeout);
              thumbnails.push(thumbnailPath);
              resolve();
            })
            .on('error', (err) => {
              clearTimeout(timeout);
              console.error(`Error generating key frame thumbnail:`, err);
              reject(err);
            })
            .run();
        });
      }
      
      return thumbnails;
    } catch (error) {
      console.error('Error in key frame thumbnail generation:', error);
      return null;
    }
  }
  
  // Secondary method: Generate thumbnails at specific timestamps
  async generateTimestampThumbnails(fileUrl, videoDuration, aspectRatio) {
    try {
      const { width, height } = this._calculateDimensions(aspectRatio);
      const thumbnails = [];
      
      // Use simple fixed percentages of video duration
      const percentages = [0.1, 0.25, 0.5, 0.75, 0.9];
      const timestamps = percentages.map(p => Math.min(videoDuration * p, videoDuration - 1));
      
      for (const timestamp of timestamps) {
        const thumbnailPath = path.join(this.tempDir, `thumbnail-${uuidv4()}.jpg`);
        
        // Skip 0 duration videos or invalid timestamps
        if (isNaN(timestamp) || timestamp <= 0) continue;
        
        await new Promise((resolve, reject) => {
          // Use more direct and reliable approach
          const command = ffmpeg()
            .input(fileUrl)
            .inputOptions([`-ss ${timestamp}`, '-threads 1'])
            .outputOptions([
              '-frames:v 1',
              `-s ${width}x${height}`,
              '-q:v 2'
            ])
            .output(thumbnailPath);
          
          // Add timeout handling
          const timeout = setTimeout(() => {
            command.kill('SIGKILL');
            reject(new Error('Thumbnail generation timed out'));
          }, 30000); // 30 second timeout
          
          command
            .on('end', () => {
              clearTimeout(timeout);
              if (fs.existsSync(thumbnailPath) && fs.statSync(thumbnailPath).size > 0) {
                thumbnails.push(thumbnailPath);
              }
              resolve();
            })
            .on('error', (err) => {
              clearTimeout(timeout);
              console.error(`Error in timestamp thumbnail generation:`, err);
              reject(err);
            })
            .run();
        });
      }
      
      return thumbnails;
    } catch (error) {
      console.error('Error in timestamp thumbnail generation:', error);
      return null;
    }
  }
  
  // Download thumbnail manually from Telegram if needed
  async downloadThumbnailFromTelegram(fileId, botToken) {
    try {
      // Get file info from Telegram
      const response = await axios.get(`https://api.telegram.org/bot${botToken}/getFile?file_id=${fileId}`);
      const filePath = response.data.result.file_path;
      const fileUrl = `https://api.telegram.org/file/bot${botToken}/${filePath}`;
      
      // Download the thumbnail
      const thumbnailPath = path.join(this.tempDir, `manual-thumbnail-${uuidv4()}.jpg`);
      const writer = fs.createWriteStream(thumbnailPath);
      
      const downloadResponse = await axios({
        method: 'GET',
        url: fileUrl,
        responseType: 'stream'
      });
      
      downloadResponse.data.pipe(writer);
      
      await new Promise((resolve, reject) => {
        writer.on('finish', resolve);
        writer.on('error', reject);
      });
      
      return thumbnailPath;
    } catch (error) {
      console.error('Error downloading thumbnail from Telegram:', error);
      return null;
    }
  }
  
  // Helper function to calculate optimal dimensions
  _calculateDimensions(aspectRatio) {
    let width = 320;
    let height = Math.round(width / aspectRatio);
    
    // If height exceeds 240, recalculate to ensure height is 240 max
    if (height > 240) {
      height = 240;
      width = Math.round(height * aspectRatio);
    }
    
    return { width, height };
  }
  
  // Helper function to get strategic timestamps
  _getStrategicTimestamps(videoDuration) {
    return [
      Math.min(5, videoDuration * 0.05),                 // Early frame (intro)
      videoDuration * 0.25,                              // First quarter
      videoDuration * 0.4,                               // Before middle
      videoDuration * 0.5,                               // Middle
      Math.max(videoDuration * 0.75, videoDuration - 30) // Later section
    ];
  }
  
  // Clean up thumbnail files
  cleanupThumbnails(thumbnailPaths) {
    if (!thumbnailPaths) return;
    
    thumbnailPaths.forEach(path => {
      if (fs.existsSync(path)) {
        try {
          fs.unlinkSync(path);
        } catch (err) {
          console.error(`Error deleting thumbnail file ${path}:`, err);
        }
      }
    });
  }
}

module.exports = ThumbnailGenerator;
