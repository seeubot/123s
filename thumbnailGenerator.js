const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');
const { spawn } = require('child_process');
const ffmpegPath = require('ffmpeg-static');

class ThumbnailGenerator {
  constructor(tempDir) {
    this.tempDir = tempDir;
    
    // Create temp directory if it doesn't exist
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
  }

  // Main method to generate multiple thumbnails for selection
  async generateSelectionThumbnails(fileUrl, videoInfo) {
    console.log('Starting thumbnail selection generation');
    
    try {
      // Get video information if not provided
      if (!videoInfo || !videoInfo.duration) {
        videoInfo = await this.getVideoMetadata(fileUrl);
        console.log('Retrieved video metadata:', videoInfo);
      }
      
      // Generate thumbnails at start, middle, and end
      const selectionThumbnails = await this.generatePositionedThumbnails(fileUrl, videoInfo);
      
      if (selectionThumbnails && selectionThumbnails.length > 0) {
        console.log(`Generated ${selectionThumbnails.length} thumbnails for selection`);
        return selectionThumbnails;
      }
      
      // If standard method fails, try embedded + fallback approach
      console.log('Positioned thumbnails failed, trying alternative methods');
      const alternativeThumbnails = await this.generateAlternativeThumbnails(fileUrl, videoInfo);
      
      return alternativeThumbnails;
    } catch (error) {
      console.error('Fatal error in thumbnail selection generation:', error);
      return [];
    }
  }
  
  // Generate thumbnails at specific positions (start, middle, end)
  async generatePositionedThumbnails(fileUrl, videoInfo) {
    const { duration } = videoInfo || { duration: 10 };
    const thumbnails = [];
    
    // Define positions for start, middle, and end
    const positions = [
      Math.max(1, Math.min(duration * 0.1, 3)),            // Start (10% in or 3 seconds, whichever is less)
      Math.max(2, Math.min(duration * 0.5, duration / 2)), // Middle (50%)
      Math.max(3, Math.min(duration * 0.9, duration - 3))  // End (90% or 3 seconds from end)
    ];
    
    // Set position labels
    const positionLabels = ['start', 'middle', 'end'];
    
    // Generate a thumbnail for each position
    for (let i = 0; i < positions.length; i++) {
      const position = positions[i];
      const label = positionLabels[i];
      
      const thumbnailPath = path.join(this.tempDir, `${label}-thumbnail-${uuidv4()}.jpg`);
      
      try {
        // Try to generate the thumbnail with optimal settings
        await this._runFfmpegCommand([
          '-ss', position.toString(),   // Seek position
          '-i', fileUrl,                // Input file
          '-vframes', '1',              // Extract one frame
          '-vf', 'scale=320:-1',        // Scale to width 320px
          '-f', 'image2',               // Force image format
          '-q:v', '2',                  // High quality
          thumbnailPath                 // Output path
        ], 30000);
        
        // Validate the thumbnail
        if (fs.existsSync(thumbnailPath) && fs.statSync(thumbnailPath).size > 100) {
          // Save metadata about the thumbnail
          thumbnails.push({
            path: thumbnailPath,
            position: label,
            timestamp: position,
            index: i
          });
          
          console.log(`Successfully generated ${label} thumbnail at position ${position}`);
        } else {
          console.log(`Generated ${label} thumbnail was invalid, trying alternative method`);
          
          // Try alternative method with different settings
          await this._runFfmpegCommand([
            '-i', fileUrl,              // Input first
            '-ss', position.toString(), // Then seek (sometimes more reliable)
            '-vframes', '1',            // Extract one frame
            '-vf', 'scale=320:-1',      // Scale to width 320px
            '-f', 'image2',             // Force image format
            '-q:v', '3',                // Slightly lower quality
            thumbnailPath               // Output path
          ], 30000);
          
          if (fs.existsSync(thumbnailPath) && fs.statSync(thumbnailPath).size > 100) {
            thumbnails.push({
              path: thumbnailPath,
              position: label,
              timestamp: position,
              index: i
            });
            
            console.log(`Successfully generated ${label} thumbnail with alternative method`);
          } else {
            console.log(`Failed to generate ${label} thumbnail`);
            this.cleanupThumbnails([thumbnailPath]);
          }
        }
      } catch (error) {
        console.error(`Error generating ${label} thumbnail:`, error);
        this.cleanupThumbnails([thumbnailPath]);
      }
    }
    
    // If we have at least one thumbnail, consider it a success
    return thumbnails;
  }
  
  // Generate alternative thumbnails if positioned approach fails
  async generateAlternativeThumbnails(fileUrl, videoInfo) {
    const thumbnails = [];
    
    // Try to extract embedded thumbnail
    console.log('Trying to extract embedded thumbnail');
    const embeddedThumbnail = await this.extractEmbeddedThumbnailWithConversion(fileUrl);
    
    if (embeddedThumbnail) {
      thumbnails.push({
        path: embeddedThumbnail,
        position: 'embedded',
        timestamp: 0,
        index: 0
      });
    }
    
    // If we couldn't get any embedded thumbnail, create a fallback
    if (thumbnails.length === 0) {
      console.log('Creating fallback thumbnail');
      const fallbackThumbnail = await this.createFallbackThumbnail(videoInfo);
      
      if (fallbackThumbnail) {
        thumbnails.push({
          path: fallbackThumbnail,
          position: 'fallback',
          timestamp: 0,
          index: 0
        });
      }
    }
    
    return thumbnails;
  }
  
  // Create a Telegram inline keyboard for thumbnail selection
  createThumbnailSelectionKeyboard(thumbnails) {
    // Create buttons for each thumbnail
    const keyboard = thumbnails.map(thumbnail => {
      const position = thumbnail.position.charAt(0).toUpperCase() + thumbnail.position.slice(1);
      return [{
        text: `Select ${position} Thumbnail`,
        callback_data: `select_thumbnail:${thumbnail.index}`
      }];
    });
    
    // Add a cancel button
    keyboard.push([{
      text: 'Cancel Selection',
      callback_data: 'cancel_thumbnail_selection'
    }]);
    
    return {
      inline_keyboard: keyboard
    };
  }
  
  // Get video metadata if not provided
  async getVideoMetadata(fileUrl) {
    try {
      console.log('Getting video metadata');
      
      return new Promise((resolve, reject) => {
        const ffprobeArgs = [
          '-v', 'error',
          '-show_entries', 'format=duration',
          '-of', 'json',
          fileUrl
        ];
        
        // Use ffprobe if available, otherwise use ffmpeg
        const probePath = ffmpegPath.replace('ffmpeg', 'ffprobe');
        const ffprobeProcess = spawn(
          fs.existsSync(probePath) ? probePath : ffmpegPath, 
          ffprobeArgs
        );
        
        let outputData = '';
        let errorData = '';
        
        ffprobeProcess.stdout.on('data', (data) => {
          outputData += data.toString();
        });
        
        ffprobeProcess.stderr.on('data', (data) => {
          errorData += data.toString();
        });
        
        ffprobeProcess.on('close', (code) => {
          if (code === 0) {
            try {
              const metadata = JSON.parse(outputData);
              const duration = parseFloat(metadata.format.duration);
              resolve({ duration });
            } catch (error) {
              console.error('Error parsing ffprobe output:', error);
              // Default fallback values
              resolve({ duration: 10 });
            }
          } else {
            console.error(`ffprobe exited with code ${code}: ${errorData}`);
            // Default fallback values
            resolve({ duration: 10 });
          }
        });
        
        // Handle process errors
        ffprobeProcess.on('error', (err) => {
          console.error('ffprobe spawn error:', err);
          // Default fallback values
          resolve({ duration: 10 });
        });
      });
    } catch (error) {
      console.error('Error in getVideoMetadata:', error);
      // Default fallback values
      return { duration: 10 };
    }
  }
  
  // Extract embedded thumbnail with conversion to make it Telegram-compatible
  async extractEmbeddedThumbnailWithConversion(fileUrl) {
    try {
      const rawThumbnailPath = path.join(this.tempDir, `raw-thumbnail-${uuidv4()}.jpg`);
      const convertedThumbnailPath = path.join(this.tempDir, `converted-thumbnail-${uuidv4()}.jpg`);
      
      // Step 1: Try to extract the embedded thumbnail
      try {
        await this._runFfmpegCommand([
          '-i', fileUrl,
          '-map', '0:v:0',
          '-map', '-0:a',
          '-c', 'copy',
          '-frames:v', '1',
          rawThumbnailPath
        ], 15000);
        
        // Check if thumbnail was extracted
        if (!fs.existsSync(rawThumbnailPath) || fs.statSync(rawThumbnailPath).size < 100) {
          console.log('No valid embedded thumbnail found, trying alternative method');
          
          // Try alternative methods for extraction
          await this._runFfmpegCommand([
            '-i', fileUrl,
            '-an',  // No audio
            '-vcodec', 'copy',
            '-y',
            rawThumbnailPath
          ], 15000);
        }
        
        // Check again if we have a valid file
        if (fs.existsSync(rawThumbnailPath) && fs.statSync(rawThumbnailPath).size > 100) {
          // Step 2: Convert the thumbnail to a format Telegram can handle (JPEG)
          await this._runFfmpegCommand([
            '-i', rawThumbnailPath,
            '-vf', 'scale=320:-1', // Resize to reasonable size
            '-q:v', '2',           // High quality
            '-f', 'image2',        // Force image format
            '-vcodec', 'mjpeg',    // Use MJPEG codec (more compatible)
            convertedThumbnailPath
          ], 10000);
          
          // Clean up the raw thumbnail
          try {
            if (fs.existsSync(rawThumbnailPath)) {
              fs.unlinkSync(rawThumbnailPath);
            }
          } catch (e) {
            console.error('Error cleaning up raw thumbnail:', e);
          }
          
          // Check if conversion succeeded
          if (fs.existsSync(convertedThumbnailPath) && fs.statSync(convertedThumbnailPath).size > 100) {
            return convertedThumbnailPath;
          }
        }
      } catch (extractError) {
        console.error('Error extracting or converting embedded thumbnail:', extractError);
        // Clean up any partial files
        this.cleanupThumbnails([rawThumbnailPath, convertedThumbnailPath]);
      }
      
      return null;
    } catch (error) {
      console.error('Error in extractEmbeddedThumbnailWithConversion:', error);
      return null;
    }
  }
  
  // Create a simple fallback thumbnail with text
  async createFallbackThumbnail(videoInfo) {
    try {
      const { duration } = videoInfo || { duration: 0 };
      const thumbnailPath = path.join(this.tempDir, `fallback-thumbnail-${uuidv4()}.jpg`);
      
      // Create a thumbnail with duration info
      const durationText = duration > 0 ? `Duration: ${Math.floor(duration / 60)}:${Math.floor(duration % 60).toString().padStart(2, '0')}` : 'Video';
      
      // Generate image with text
      await this._runFfmpegCommand([
        '-f', 'lavfi',
        '-i', `color=c=black:s=320x240`,
        '-vf', `drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:text='${durationText}':fontcolor=white:fontsize=24:x=(w-text_w)/2:y=(h-text_h)/2`,
        '-frames:v', '1',
        thumbnailPath
      ], 10000);
      
      if (fs.existsSync(thumbnailPath) && fs.statSync(thumbnailPath).size > 100) {
        console.log('Created fallback thumbnail with text');
        return thumbnailPath;
      }
      
      // If text overlay fails, try just a simple color
      console.log('Text overlay failed, creating simple color thumbnail');
      await this._runFfmpegCommand([
        '-f', 'lavfi',
        '-i', 'color=c=blue:s=320x240',
        '-frames:v', '1',
        thumbnailPath
      ], 5000);
      
      if (fs.existsSync(thumbnailPath) && fs.statSync(thumbnailPath).size > 100) {
        console.log('Created simple color thumbnail');
        return thumbnailPath;
      }
      
      return null;
    } catch (error) {
      console.error('Error creating fallback thumbnail:', error);
      return null;
    }
  }
  
  // Helper method to run ffmpeg with proper error handling and timeouts
  async _runFfmpegCommand(args, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      console.log(`Running ffmpeg with args: ${args.join(' ')}`);
      
      // Set conservative memory limits
      const ffmpegProcess = spawn(ffmpegPath, [
        '-hide_banner',         // Hide ffmpeg banner
        '-threads', '1',        // Use only one thread
        '-loglevel', 'error',   // Only show errors in logs
        ...args
      ]);
      
      let stdoutData = '';
      let stderrData = '';
      
      // Collect stdout data
      ffmpegProcess.stdout.on('data', (data) => {
        stdoutData += data.toString();
      });
      
      // Collect stderr data
      ffmpegProcess.stderr.on('data', (data) => {
        stderrData += data.toString();
      });
      
      // Set a timeout to kill the process if it takes too long
      const timeout = setTimeout(() => {
        console.log('Process timed out, killing ffmpeg');
        try {
          ffmpegProcess.kill('SIGKILL');
        } catch (e) {
          console.error('Error killing ffmpeg process:', e);
        }
        reject(new Error('FFmpeg process timed out'));
      }, timeoutMs);
      
      // When process exits
      ffmpegProcess.on('close', (code) => {
        clearTimeout(timeout);
        
        if (code === 0) {
          resolve();
        } else {
          console.error(`FFmpeg exited with code ${code}`);
          console.error(`stderr: ${stderrData}`);
          reject(new Error(`FFmpeg process exited with code ${code}`));
        }
      });
      
      // Handle process errors
      ffmpegProcess.on('error', (err) => {
        clearTimeout(timeout);
        console.error('FFmpeg spawn error:', err);
        reject(err);
      });
    });
  }
  
  // Clean up thumbnail files
  cleanupThumbnails(thumbnailPaths) {
    if (!thumbnailPaths) return;
    
    thumbnailPaths.forEach(path => {
      if (path && fs.existsSync(path)) {
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
