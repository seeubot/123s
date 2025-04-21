const fs = require('fs');
const path = require('path');
const { createCanvas, loadImage } = require('canvas');
const { v4: uuidv4 } = require('uuid');
const { logActivity, logError } = require('./utils/logger');

/**
 * Class to handle fallback thumbnail generation when the main method fails
 */
class FallbackHandler {
  /**
   * Constructor
   * @param {string} tempDir - Directory to store temporary files
   */
  constructor(tempDir) {
    this.tempDir = tempDir;
    
    // Create temp directory if it doesn't exist
    if (!fs.existsSync(this.tempDir)) {
      fs.mkdirSync(this.tempDir, { recursive: true });
    }
    
    logActivity(`FallbackHandler initialized with tempDir: ${this.tempDir}`);
  }
  
  /**
   * Extract Telegram's own thumbnail from video
   * @param {Object} telegram - Telegram context object
   * @param {string} fileId - File ID of the video
   * @returns {Promise<string>} - Path to the downloaded thumbnail
   */
  async extractVideoThumbnail(telegram, fileId) {
    try {
      logActivity(`Trying to extract Telegram's thumbnail for file ${fileId}`);
      
      // Get file info
      const file = await telegram.getFile(fileId);
      
      if (file && file.thumbnail) {
        // Telegram generated a thumbnail
        const thumbFileId = file.thumbnail.file_id;
        const thumbFile = await telegram.getFile(thumbFileId);
        
        if (thumbFile && thumbFile.file_path) {
          // Download the thumbnail
          const outputPath = path.join(this.tempDir, `telegram_thumb_${uuidv4()}.jpg`);
          const fileUrl = `https://api.telegram.org/file/bot${telegram.token}/${thumbFile.file_path}`;
          
          await this.downloadFile(fileUrl, outputPath);
          logActivity(`Successfully extracted Telegram thumbnail: ${outputPath}`);
          
          return outputPath;
        }
      }
      
      logActivity('No Telegram thumbnail found for the video');
      return null;
    } catch (error) {
      logError('Error extracting Telegram thumbnail:', error);
      return null;
    }
  }
  
  /**
   * Generate a placeholder thumbnail with text
   * @param {string} videoName - Name of the video for display
   * @returns {Promise<string>} - Path to the generated placeholder
   */
  async generatePlaceholderThumbnail(videoName) {
    try {
      logActivity(`Generating placeholder thumbnail for ${videoName}`);
      
      // Create a filename-safe version of the video name
      const safeVideoName = videoName.replace(/[^a-z0-9]/gi, '_').toLowerCase();
      const outputPath = path.join(this.tempDir, `placeholder_${safeVideoName}_${uuidv4()}.jpg`);
      
      // Create canvas (16:9 aspect ratio)
      const width = 1280;
      const height = 720;
      const canvas = createCanvas(width, height);
      const ctx = canvas.getContext('2d');
      
      // Fill background
      ctx.fillStyle = '#1e1e1e';
      ctx.fillRect(0, 0, width, height);
      
      // Add play button
      ctx.beginPath();
      ctx.arc(width / 2, height / 2, 50, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
      ctx.fill();
      
      // Draw play triangle
      ctx.beginPath();
      ctx.moveTo(width / 2 + 20, height / 2);
      ctx.lineTo(width / 2 - 10, height / 2 + 15);
      ctx.lineTo(width / 2 - 10, height / 2 - 15);
      ctx.closePath();
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      
      // Draw video name
      ctx.font = '24px Arial';
      ctx.fillStyle = '#ffffff';
      ctx.textAlign = 'center';
      
      // Truncate if necessary
      let displayName = videoName;
      if (displayName.length > 40) {
        displayName = displayName.substring(0, 37) + '...';
      }
      
      ctx.fillText(displayName, width / 2, height / 2 + 100);
      
      // Save to file
      const buffer = canvas.toBuffer('image/jpeg', { quality: 0.9 });
      fs.writeFileSync(outputPath, buffer);
      
      logActivity(`Generated placeholder thumbnail: ${outputPath}`);
      return outputPath;
    } catch (error) {
      logError('Error generating placeholder thumbnail:', error);
      return this.generateSimplePlaceholder(); // Fallback to very simple method
    }
  }
  
  /**
   * Generate a very simple placeholder as last resort
   * @returns {Promise<string>} - Path to the generated simple placeholder
   */
  async generateSimplePlaceholder() {
    try {
      logActivity('Generating simple placeholder as last resort');
      
      const outputPath = path.join(this.tempDir, `simple_placeholder_${uuidv4()}.jpg`);
      
      // Create a simple canvas
      const width = 640;
      const height = 360;
      const canvas = createCanvas(width, height);
      const ctx = canvas.getContext('2d');
      
      // Fill with gradient
      const gradient = ctx.createLinearGradient(0, 0, width, height);
      gradient.addColorStop(0, '#1e3c72');
      gradient.addColorStop(1, '#2a5298');
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, width, height);
      
      // Add text
      ctx.font = '24px Arial';
      ctx.fillStyle = '#ffffff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('Video Preview', width / 2, height / 2);
      
      // Save to file
      const buffer = canvas.toBuffer('image/jpeg', { quality: 0.8 });
      fs.writeFileSync(outputPath, buffer);
      
      logActivity(`Generated simple placeholder: ${outputPath}`);
      return outputPath;
    } catch (error) {
      logError('Error generating simple placeholder:', error);
      return null;
    }
  }
  
  /**
   * Download a file from URL
   * @param {string} url - URL to download
   * @param {string} outputPath - Where to save the file
   * @returns {Promise<void>}
   */
  async downloadFile(url, outputPath) {
    return new Promise((resolve, reject) => {
      const https = require('https');
      const file = fs.createWriteStream(outputPath);
      
      https.get(url, (response) => {
        response.pipe(file);
        
        file.on('finish', () => {
          file.close();
          resolve();
        });
      }).on('error', (err) => {
        fs.unlink(outputPath, () => {}); // Delete the file on error
        reject(err);
      });
    });
  }
}

module.exports = FallbackHandler;
