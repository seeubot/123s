const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');

/**
 * This module provides fallback methods when the main thumbnail generation fails
 */
class FallbackHandler {
  constructor(tempDir) {
    this.tempDir = tempDir;
  }
  
  /**
   * Generates a placeholder thumbnail with text
   */
  async generatePlaceholderThumbnail(videoName) {
    try {
      const placeholderPath = path.join(this.tempDir, `placeholder-${uuidv4()}.jpg`);
      
      // Create a simple placeholder image
      // In a real implementation, you could use a library like 'canvas'
      // to create an actual image with text, but for now we'll create a simple file
      
      // Download a generic placeholder from a public service
      const response = await axios({
        method: 'GET',
        url: 'https://via.placeholder.com/320x180/333333/FFFFFF/?text=Video+Thumbnail',
        responseType: 'stream',
        timeout: 10000
      });
      
      const writer = fs.createWriteStream(placeholderPath);
      response.data.pipe(writer);
      
      await new Promise((resolve, reject) => {
        writer.on('finish', resolve);
        writer.on('error', reject);
      });
      
      return placeholderPath;
    } catch (error) {
      console.error('Error generating placeholder thumbnail:', error);
      return null;
    }
  }
  
  /**
   * Extracts the video's own thumbnail if available
   */
  async extractVideoThumbnail(telegram, fileId) {
    try {
      // Attempt to use Telegram's built-in thumbnail
      const thumbnailPath = path.join(this.tempDir, `tg-thumb-${uuidv4()}.jpg`);
      
      // Get file info with thumbnail
      const fileInfo = await telegram.getFile(fileId);
      
      // If the video has a thumbnail property
      if (fileInfo && fileInfo.thumb) {
        const thumbUrl = `https://api.telegram.org/file/bot${telegram.token}/${fileInfo.thumb.file_path}`;
        
        const response = await axios({
          method: 'GET',
          url: thumbUrl,
          responseType: 'stream',
          timeout: 10000
        });
        
        const writer = fs.createWriteStream(thumbnailPath);
        response.data.pipe(writer);
        
        await new Promise((resolve, reject) => {
          writer.on('finish', resolve);
          writer.on('error', reject);
        });
        
        return thumbnailPath;
      }
      
      return null;
    } catch (error) {
      console.error('Error extracting video thumbnail:', error);
      return null;
    }
  }
  
  /**
   * Final fallback method - create a simple text file with video info
   */
  async createTextInfoThumbnail(videoInfo) {
    try {
      const infoPath = path.join(this.tempDir, `info-${uuidv4()}.txt`);
      
      const infoContent = `Video Information:
Filename: ${videoInfo.file_name || 'Unknown'}
Duration: ${videoInfo.duration || 0} seconds
Resolution: ${videoInfo.width || 0}x${videoInfo.height || 0}
File size: ${Math.round((videoInfo.file_size || 0) / 1024 / 1024)}MB
`;
      
      fs.writeFileSync(infoPath, infoContent);
      return infoPath;
    } catch (error) {
      console.error('Error creating text info file:', error);
      return null;
    }
  }
}

module.exports = FallbackHandler;
