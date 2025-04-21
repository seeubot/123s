const fs = require('fs');
const path = require('path');

// Setup logging directory
const logDir = path.join(__dirname, '../logs');
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}

const activityLogPath = path.join(logDir, 'activity.log');
const errorLogPath = path.join(logDir, 'error.log');

/**
 * Log activity to file and console
 * @param {string} message - Activity message to log
 */
function logActivity(message) {
  const timestamp = new Date().toISOString();
  const logEntry = `[${timestamp}] ${message}\n`;
  
  console.log(`[ACTIVITY] ${message}`);
  
  // Write to log file
  fs.appendFile(activityLogPath, logEntry, (err) => {
    if (err) {
      console.error('Failed to write to activity log:', err);
    }
  });
}

/**
 * Log errors to file and console
 * @param {string} message - Error message to log
 * @param {Error} [error] - Optional error object
 */
function logError(message, error) {
  const timestamp = new Date().toISOString();
  let logEntry = `[${timestamp}] ${message}`;
  
  if (error) {
    logEntry += `\n${error.stack || error}\n`;
    console.error(`[ERROR] ${message}`, error);
  } else {
    logEntry += '\n';
    console.error(`[ERROR] ${message}`);
  }
  
  // Write to log file
  fs.appendFile(errorLogPath, logEntry, (err) => {
    if (err) {
      console.error('Failed to write to error log:', err);
    }
  });
}

// Export logger functions
module.exports = {
  logActivity,
  logError
};
