const express = require('express');
const axios = require('axios');
const cors = require('cors');
const mongoose = require('mongoose');

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// MongoDB Connection
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/terabox_api';
mongoose.connect(MONGO_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
});

// User Schema
const UserSchema = new mongoose.Schema({
    userId: { 
        type: String, 
        required: true, 
        unique: true 
    },
    joinedAt: { 
        type: Date, 
        default: Date.now 
    }
});

const User = mongoose.model('User', UserSchema);

// Configuration
const BASE_URL = process.env.BASE_URL || 'https://alphaapis.org/terabox';
const CHANNEL_USERNAME = process.env.CHANNEL_USERNAME || '@awt_bots';

// Utility Functions
function extractTeraboxId(text) {
    const match = text.match(/\/s\/([a-zA-Z0-9_-]+)/);
    return match ? match[1] : text.trim();
}

// API Endpoints
app.post('/api/download', async (req, res) => {
    try {
        const { text, userId } = req.body;

        // Validate input
        if (!text) {
            return res.status(400).json({ 
                success: false, 
                message: 'TeraBox link or Video ID is required' 
            });
        }

        // Optional: User membership validation
        if (CHANNEL_USERNAME) {
            // In a real-world scenario, you'd implement actual channel membership check
            // This is a placeholder for the Telegram bot's channel membership logic
            const isMember = await checkUserMembership(userId);
            if (!isMember) {
                return res.status(403).json({ 
                    success: false, 
                    message: `You must join ${CHANNEL_USERNAME} to use this service` 
                });
            }
        }

        // Save user (if userId provided)
        if (userId) {
            await saveUser(userId);
        }

        // Extract video ID
        const videoId = extractTeraboxId(text);

        if (!videoId) {
            return res.status(400).json({ 
                success: false, 
                message: 'Invalid TeraBox link. Please send a correct link or ID.' 
            });
        }

        // Fetch video details
        const response = await axios.get(`${BASE_URL}?id=${videoId}`);

        if (!response.data || response.data.success !== true) {
            return res.status(404).json({ 
                success: false, 
                message: 'Failed to fetch video. Please check the link.' 
            });
        }

        const { downloadLink, filename, size } = response.data.data;

        // Validate download link
        if (!downloadLink) {
            return res.status(404).json({ 
                success: false, 
                message: 'No download link found.' 
            });
        }

        // File size validation (50MB limit)
        const fileSize = parseInt(size, 10) || 0;
        if (fileSize > 50000000) {
            return res.status(413).json({ 
                success: true, 
                message: 'Video is too large',
                downloadLink 
            });
        }

        // Return video details
        res.json({
            success: true,
            data: {
                downloadLink,
                filename: filename || 'video.mp4',
                size: fileSize
            }
        });
    } catch (error) {
        console.error('Download API Error:', error.message);
        res.status(500).json({ 
            success: false, 
            message: 'Something went wrong. Try again later.',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

// User Membership Check (Placeholder)
async function checkUserMembership(userId) {
    // In a real-world scenario, implement actual channel membership validation
    // This could involve checking against a list of members or an external service
    return userId ? true : false;
}

// Save User to Database
async function saveUser(userId) {
    try {
        await User.findOneAndUpdate(
            { userId }, 
            { userId }, 
            { upsert: true, new: true }
        );
    } catch (error) {
        console.error('Error saving user:', error.message);
    }
}

// Health Check Endpoint
app.get('/api/health', (req, res) => {
    res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        baseUrl: BASE_URL,
        channelUsername: CHANNEL_USERNAME
    });
});

// 404 Handler
app.use((req, res) => {
    res.status(404).json({
        success: false,
        message: 'Endpoint not found',
        availableEndpoints: [
            '/api/download',
            '/api/health'
        ]
    });
});

// Server setup
const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
    console.log(`🚀 TeraBox Download API running on port ${PORT}`);
});

// Graceful Shutdown
process.on('SIGINT', () => {
    console.log('Shutting down server...');
    server.close(() => {
        mongoose.connection.close(false, () => {
            console.log('MongoDB connection closed');
            process.exit(0);
        });
    });
});

module.exports = app;
