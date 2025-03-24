const express = require('express');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const axios = require('axios');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 8080;

// Create WebSocket server
let wss;
try {
    wss = new WebSocket.Server({ port: PORT });
    console.log(`WebSocket server started on port ${PORT}`);
} catch (error) {
    console.error(`Failed to start WebSocket server on port ${PORT}:`, error);
    // Try alternative port
    try {
        const altPort = PORT + 1;
        wss = new WebSocket.Server({ port: altPort });
        console.log(`WebSocket server started on port ${altPort}`);
    } catch (error) {
        console.error('Failed to start WebSocket server on alternative port:', error);
        process.exit(1);
    }
}

// Store connected ESP32 clients
let esp32Clients = new Set();

// WebSocket connection handling
wss.on('connection', (ws) => {
    console.log('New WebSocket client connected');
    
    ws.on('message', (message) => {
        try {
            const data = message.toString();
            console.log('Raw message received:', data);
            
            // Handle ESP32 connection messages
            if (data === 'ESP32 Connected' || data === 'ESP32 Ready') {
                console.log('ESP32 connection confirmed:', data);
                esp32Clients.add(ws);
                console.log('Total connected ESP32s:', esp32Clients.size);
                return;
            }
            
            // Try to parse JSON messages
            try {
                const jsonData = JSON.parse(data);
                console.log('Received JSON message from client:', jsonData);
                
                if (jsonData.type === 'product_selection') {
                    console.log('Product selection received:', jsonData.productId);
                    // Broadcast to all connected clients
                    wss.clients.forEach((client) => {
                        if (client.readyState === WebSocket.OPEN) {
                            client.send(JSON.stringify({
                                type: 'product_selection',
                                productId: jsonData.productId
                            }));
                            console.log('Broadcasted product selection to client');
                        }
                    });
                }
            } catch (jsonError) {
                console.log('Message is not JSON:', data);
            }
        } catch (error) {
            console.error('Error processing WebSocket message:', error);
        }
    });

    ws.on('error', (error) => {
        console.error('WebSocket error:', error);
        esp32Clients.delete(ws);
        console.log('Remaining connected ESP32s:', esp32Clients.size);
    });

    ws.on('close', () => {
        console.log('Client disconnected');
        esp32Clients.delete(ws);
        console.log('Remaining connected ESP32s:', esp32Clients.size);
    });
});

wss.on('error', (error) => {
    console.error('WebSocket server error:', error);
});

wss.on('listening', () => {
    console.log('WebSocket server is listening on port 8080');
});

// Function to send command to ESP32
function sendToESP32(categoryNumber) {
    const command = `MOTOR:${categoryNumber}\n`;
    esp32Clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(command);
            console.log(`Sent command to ESP32: ${command}`);
        }
    });
}

// Validate environment variables
if (!process.env.GEMINI_API_KEY) {
    console.error('GEMINI_API_KEY is not set in environment variables');
    process.exit(1);
}

// Initialize Gemini 2.0 Flash-Lite
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ 
    model: "gemini-2.0-flash-lite",
    generationConfig: {
        temperature: 0.7, // Increased temperature for more creative responses
        candidateCount: 1,
        maxOutputTokens: 500,
    }
});

// Load menu data
let menuData = null;
try {
    const menuPath = path.join(__dirname, 'menu.json');
    menuData = JSON.parse(fs.readFileSync(menuPath, 'utf8'));
    console.log('Menu data loaded successfully');
    console.log('Categories:', menuData.categories.map(cat => cat.name));
    console.log('Total products:', menuData.categories.reduce((acc, cat) => acc + cat.products.length, 0));
} catch (error) {
    console.error('Error loading menu data:', error);
}

// Create a map for quick access to products by ID
const productMap = new Map();
menuData.categories.forEach(category => {
    category.products.forEach(product => {
        productMap.set(product.id, product);
    });
});

// Create a map for quick access to products by name (case-insensitive)
const productNameMap = new Map();
menuData.categories.forEach(category => {
    category.products.forEach(product => {
        productNameMap.set(product.name.toLowerCase(), product.id);
    });
});

// Create a structured prompt for Gemini
function createMenuPrompt() {
    let prompt = `You are a restaurant menu assistant. Your sole purpose is to provide information about our menu items and help customers navigate to specific products.

Available Categories:
${menuData.categories.map(cat => `- ${cat.name}`).join('\n')}

Available Products (with their IDs):
${menuData.categories.map(cat => `
${cat.name}:
${cat.products.map(p => `- ${p.name} (ID: ${p.id})`).join('\n')}`).join('\n')}

Rules for responses:
1. ONLY provide information about our menu items
2. If asked about non-menu items, respond with: "I can only provide information about our menu items. Please ask about our food and drinks."
3. For navigation commands:
   - If the user says "take me to", "show me", "let's go to", or similar phrases followed by a product name, respond with: "NAVIGATE_TO_PRODUCT:{product_id}"
   - Example: If user says "take me to Margherita Pizza", respond with: "NAVIGATE_TO_PRODUCT:pizza1"
4. For combined requests (asking for info AND navigation):
   - If the user asks for information about a product and also wants to see it, respond with: "INFO_AND_NAVIGATE:{product_id}:{detailed_info}"
   - Example: If user says "tell me about Margherita Pizza and take me there", respond with: "INFO_AND_NAVIGATE:pizza1:Our Margherita Pizza is a classic Italian delight! Made with fresh mozzarella, ripe tomatoes, and fragrant basil on our signature thin crust. At $12.99, it's a perfect blend of traditional flavors with 850 calories per serving."
5. For product information:
   - Provide detailed, appetizing descriptions
   - Include price, ingredients, and nutritional information
   - Use engaging, conversational language
   - STRICTLY limit responses to 100 words or less
   - Count words carefully and ensure you don't exceed the limit

Example responses:
For "tell me about Margherita Pizza":
"Our Margherita Pizza is a classic Italian delight! Made with fresh mozzarella, ripe tomatoes, and fragrant basil on our signature thin crust. At $12.99, it's a perfect blend of traditional flavors with 850 calories per serving."

For "take me to Margherita Pizza":
"NAVIGATE_TO_PRODUCT:pizza1"

For "tell me about Margherita Pizza and take me there":
"INFO_AND_NAVIGATE:pizza1:Our Margherita Pizza is a classic Italian delight! Made with fresh mozzarella, ripe tomatoes, and fragrant basil on our signature thin crust. At $12.99, it's a perfect blend of traditional flavors with 850 calories per serving."

For "what's the spiciest item?":
"I can only provide information about our menu items. Please ask about our food and drinks."

Remember: 
- Only provide information about our menu items
- Respond with navigation commands when appropriate
- STRICTLY limit all responses to 100 words or less
- Count words carefully before sending responses`;

    return prompt;
}

// Menu API endpoint
app.get('/api/menu', (req, res) => {
    if (!menuData) {
        return res.status(500).json({ error: 'Menu data not available' });
    }
    res.json(menuData);
});

// Get product by ID endpoint
app.get('/api/product/:id', (req, res) => {
    const product = productMap.get(req.params.id);
    if (!product) {
        return res.status(404).json({ error: 'Product not found' });
    }
    res.json(product);
});

// Test endpoint to verify menu data and Gemini response
app.get('/api/test-menu', async (req, res) => {
    try {
        // Log the menu prompt
        const menuPrompt = createMenuPrompt();
        console.log('Menu Prompt Length:', menuPrompt.length);
        console.log('First 500 characters of prompt:', menuPrompt.substring(0, 500));

        // Test with a simple question
        const testQuestion = "What is the price of the Margherita Pizza?";
        const prompt = `${menuPrompt}\n\nCustomer Question: ${testQuestion}\nAssistant:`;
        
        console.log('Sending prompt to Gemini...');
        const result = await model.generateContent(prompt);
        const text = (await result.response).text();
        
        console.log('Gemini Response:', text);
        
        res.json({
            success: true,
            menuLoaded: !!menuData,
            categories: menuData?.categories.map(cat => cat.name),
            totalProducts: menuData?.categories.reduce((acc, cat) => acc + cat.products.length, 0),
            promptLength: menuPrompt.length,
            testResponse: text
        });
    } catch (error) {
        console.error('Test Error:', error);
        res.status(500).json({
            success: false,
            error: error.message,
            menuLoaded: !!menuData
        });
    }
});

// Simplified test connection
async function testApiConnection() {
    try {
        const result = await model.generateContent("test");
        await result.response;
        console.log('Gemini 2.0 Flash-Lite Connected');
    } catch (error) {
        console.error('API Connection Failed:', error.message);
        process.exit(1);
    }
}

// Chat endpoint
app.post('/api/chat', async (req, res) => {
    try {
        const { message } = req.body;
        const menuPrompt = createMenuPrompt();
        
        const chat = model.startChat({
            history: [
                {
                    role: "user",
                    parts: menuPrompt
                }
            ],
            generationConfig: {
                temperature: 0.7,
                maxOutputTokens: 500,
            },
        });

        const result = await chat.sendMessage(message);
        const response = result.response.text();

        // Check if the response is a navigation command
        if (response.startsWith('NAVIGATE_TO_PRODUCT:')) {
            const productId = response.split(':')[1];
            res.json({ 
                type: 'navigation',
                productId: productId,
                message: `Navigating to ${productId}`
            });
        } 
        // Check if the response is a combined info and navigation command
        else if (response.startsWith('INFO_AND_NAVIGATE:')) {
            const [productId, info] = response.split(':').slice(1);
            res.json({ 
                type: 'info_and_navigate',
                productId: productId,
                message: `Navigating to ${productId}: ${info}`,
                info: info
            });
        }
        else {
            res.json({ 
                type: 'message',
                message: response 
            });
        }
    } catch (error) {
        console.error('Error in chat endpoint:', error);
        res.status(500).json({ error: 'Failed to process chat message' });
    }
});

// Category mapping for ESP32
const categoryMap = {
    'pizza': 1,
    'burger': 2,
    'fries': 3,
    'dessert': 4
};

// Order endpoint
app.post('/api/order', async (req, res) => {
    try {
        const { productId } = req.body;
        
        // Extract category from product ID (e.g., "pizza1" -> "pizza")
        const category = productId.replace(/\d+$/, '');
        const categoryNumber = categoryMap[category];

        if (!categoryNumber) {
            return res.status(400).json({ error: 'Invalid product category' });
        }

        // Send command to ESP32
        const command = {
            type: 'order',
            category: categoryNumber
        };

        // Broadcast to all connected ESP32s
        esp32Clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify(command));
            }
        });

        res.json({ 
            success: true, 
            message: 'Order sent to ESP32',
            category: categoryNumber
        });
    } catch (error) {
        console.error('Order error:', error);
        res.status(500).json({ error: 'Failed to process order' });
    }
});

// Health endpoint
app.get('/health', (_, res) => res.json({ status: 'ok' }));

// ElevenLabs TTS endpoint
app.post('/api/tts', async (req, res) => {
    try {
        const { text } = req.body;
        console.log('TTS Request received:', { text: text.substring(0, 50) + '...' });
        
        if (!text) {
            console.log('TTS Error: No text provided');
            return res.status(400).json({ error: 'Text is required' });
        }

        if (!process.env.ELEVENLABS_API_KEY) {
            console.error('TTS Error: ELEVENLABS_API_KEY is not set');
            return res.status(500).json({ error: 'API key not configured' });
        }

        if (!process.env.ELEVENLABS_VOICE_ID) {
            console.error('TTS Error: ELEVENLABS_VOICE_ID is not set');
            return res.status(500).json({ error: 'Voice ID not configured' });
        }

        console.log('TTS Request:', {
            text: text.substring(0, 50) + '...', // Log first 50 chars
            voiceId: process.env.ELEVENLABS_VOICE_ID,
            apiKey: process.env.ELEVENLABS_API_KEY.substring(0, 10) + '...' // Log first 10 chars of API key
        });

        const response = await axios.post(
            `https://api.elevenlabs.io/v1/text-to-speech/${process.env.ELEVENLABS_VOICE_ID}`,
            {
                text: text,
                model_id: "eleven_monolingual_v1",
                voice_settings: {
                    stability: 0.5,
                    similarity_boost: 0.75
                }
            },
            {
                headers: {
                    'Accept': 'audio/mpeg',
                    'Content-Type': 'application/json',
                    'xi-api-key': process.env.ELEVENLABS_API_KEY
                },
                responseType: 'arraybuffer'
            }
        );

        console.log('TTS Response received successfully');
        
        // Convert the audio buffer to base64
        const audioBase64 = Buffer.from(response.data).toString('base64');
        
        res.json({ audio: audioBase64 });
    } catch (error) {
        console.error('TTS Error Details:', {
            message: error.message,
            response: error.response?.data,
            status: error.response?.status,
            headers: error.response?.headers
        });
        res.status(500).json({ 
            error: 'Failed to generate speech',
            details: error.message
        });
    }
});

// Start server
async function startServer() {
    try {
        await testApiConnection();
        app.listen(PORT, () => console.log(`Server running on ${PORT}`));
    } catch (error) {
        console.error('Server Error:', error);
        process.exit(1);
    }
}

startServer(); 