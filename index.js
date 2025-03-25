const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();

// Configurable API URL from environment or fallback
const EXTERNAL_API_URL = process.env.EXTERNAL_API_URL || 'https://alphaapis.org/terabox';

// Middleware
app.use(cors());
app.use(express.json());

// Video Fetch Route with Flexible API Integration
app.get('/api/fetch', async (req, res) => {
    try {
        const { id, url = EXTERNAL_API_URL } = req.query;

        if (!id) {
            return res.status(400).json({ 
                success: false, 
                message: 'Video ID is required' 
            });
        }

        // Allow dynamic API URL injection via query parameter or environment variable
        const apiUrl = url.includes('?') 
            ? `${url}&id=${id}` 
            : `${url}?id=${id}`;

        // Fetch video details from the specified or default API
        const response = await axios.get(apiUrl, {
            // Optional: Add headers for authentication if needed
            headers: process.env.API_HEADERS 
                ? JSON.parse(process.env.API_HEADERS) 
                : {}
        });

        // Flexible response handling
        const responseData = response.data;
        
        // Check if the external API response structure is different
        const result = {
            success: responseData.success ?? (responseData.status === 'success'),
            data: responseData.data || responseData,
            originalResponse: process.env.NODE_ENV === 'development' ? responseData : undefined
        };

        // If success is false or undefined, return an error
        if (result.success === false) {
            return res.status(404).json({ 
                success: false, 
                message: 'Unable to fetch video details',
                details: result.data
            });
        }

        // Return video details
        res.json(result);
    } catch (error) {
        console.error('External API Error:', error.message);
        res.status(500).json({ 
            success: false, 
            message: 'Internal server error',
            error: {
                message: error.message,
                // Conditionally add more error details in development
                ...(process.env.NODE_ENV === 'development' && { 
                    stack: error.stack,
                    response: error.response?.data 
                })
            }
        });
    }
});

// Proxy Route for More Flexible API Interaction
app.get('/api/proxy', async (req, res) => {
    try {
        const { url } = req.query;

        if (!url) {
            return res.status(400).json({ 
                success: false, 
                message: 'Target URL is required' 
            });
        }

        // Validate and sanitize URL (basic protection)
        const parsedUrl = new URL(url);
        const allowedProtocols = ['http:', 'https:'];
        
        if (!allowedProtocols.includes(parsedUrl.protocol)) {
            return res.status(400).json({ 
                success: false, 
                message: 'Invalid URL protocol' 
            });
        }

        // Fetch data from the specified URL
        const response = await axios.get(url, {
            // Optional: Add headers for authentication if needed
            headers: process.env.PROXY_HEADERS 
                ? JSON.parse(process.env.PROXY_HEADERS) 
                : {}
        });

        // Return the proxied response
        res.json({
            success: true,
            data: response.data
        });
    } catch (error) {
        console.error('Proxy Error:', error.message);
        res.status(500).json({ 
            success: false, 
            message: 'Proxy request failed',
            error: process.env.NODE_ENV === 'development' 
                ? { 
                    message: error.message,
                    stack: error.stack,
                    response: error.response?.data 
                } 
                : error.message
        });
    }
});

// Health check route
app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'healthy', 
        timestamp: new Date().toISOString(),
        apiUrl: EXTERNAL_API_URL,
        environment: process.env.NODE_ENV || 'production'
    });
});

// Root route for basic information
app.get('/api', (req, res) => {
    res.json({
        name: 'Flexible API Server',
        version: '1.0.0',
        endpoints: [
            '/api/fetch',
            '/api/proxy',
            '/api/health'
        ]
    });
});

// Catch-all route for undefined endpoints
app.use((req, res) => {
    res.status(404).json({
        success: false,
        message: 'Endpoint not found',
        availableEndpoints: [
            '/api/fetch',
            '/api/proxy',
            '/api/health'
        ]
    });
});

module.exports = app;
