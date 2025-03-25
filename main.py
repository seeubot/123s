const axios = require('axios');

// Global configuration
const TERABOX_API_BASE = 'https://teradl-api.dapuntaratya.com';

// Middleware to handle CORS
const cors = (req, res, next) => {
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
    res.setHeader(
        'Access-Control-Allow-Headers',
        'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version'
    );
    
    // Handle preflight requests
    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
    }
    
    next();
};

// Configuration endpoint
const getConfig = async (req, res) => {
    try {
        // You can implement your own logic to determine the mode
        // For now, defaulting to mode 1
        res.status(200).json({ mode: 1 });
    } catch (error) {
        res.status(500).json({ error: 'Failed to get configuration' });
    }
};

// Generate file endpoint
const generateFile = async (req, res) => {
    try {
        // Handle OPTIONS preflight
        if (req.method === 'OPTIONS') {
            return res.status(200).end();
        }

        // Only allow POST method
        if (req.method !== 'POST') {
            return res.status(405).json({ error: 'Method Not Allowed' });
        }

        const { url, mode } = req.body;

        // Proxy the request to the original Terabox API
        const response = await axios.post(`${TERABOX_API_BASE}/generate_file`, {
            url,
            mode
        }, {
            headers: {
                'Content-Type': 'application/json'
            }
        });

        res.status(200).json(response.data);
    } catch (error) {
        console.error('Error in generate_file:', error);
        res.status(500).json({ 
            status: 'error', 
            message: error.response?.data || 'Failed to generate file list' 
        });
    }
};

// Generate link endpoint
const generateLink = async (req, res) => {
    try {
        // Handle OPTIONS preflight
        if (req.method === 'OPTIONS') {
            return res.status(200).end();
        }

        // Only allow POST method
        if (req.method !== 'POST') {
            return res.status(405).json({ error: 'Method Not Allowed' });
        }

        const params = req.body;

        // Proxy the request to the original Terabox API
        const response = await axios.post(`${TERABOX_API_BASE}/generate_link`, params, {
            headers: {
                'Content-Type': 'application/json'
            }
        });

        res.status(200).json(response.data);
    } catch (error) {
        console.error('Error in generate_link:', error);
        res.status(500).json({ 
            status: 'error', 
            message: error.response?.data || 'Failed to generate download links' 
        });
    }
};

// Health check endpoint
const healthCheck = (req, res) => {
    res.status(200).json({ 
        status: 'healthy', 
        message: 'Terabox API Proxy is running' 
    });
};

// Export serverless functions
module.exports = {
    getConfig,
    generateFile,
    generateLink,
    healthCheck
};
