// netlify/functions/notion-webhook.js
const { Client, GatewayIntentBits } = require('discord.js');

// Initialize Discord client
let discordClient;
function getDiscordClient() {
    if (!discordClient) {
        discordClient = new Client({
            intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages]
        });
        discordClient.login(process.env.DISCORD_TOKEN);
    }
    return discordClient;
}

exports.handler = async (event, context) => {
    console.log('Received webhook request:', {
        method: event.httpMethod,
        path: event.path,
        body: event.body ? 'Body exists' : 'No body'
    });

    // Handle CORS preflight
    if (event.httpMethod === 'OPTIONS') {
        return {
            statusCode: 200,
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Headers': 'Content-Type, x-notion-signature',
                'Access-Control-Allow-Methods': 'POST, OPTIONS'
            },
            body: ''
        };
    }

    // Only allow POST
    if (event.httpMethod !== 'POST') {
        return {
            statusCode: 405,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ error: 'Method Not Allowed' })
        };
    }

    try {
        // **FIX: Check if body exists and parse it safely**
        if (!event.body) {
            console.log('No body received in request');
            return {
                statusCode: 400,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ error: 'No body received' })
            };
        }

        let body;
        try {
            body = JSON.parse(event.body);
            console.log('Parsed body successfully:', { type: body.type });
        } catch (parseError) {
            console.error('Error parsing JSON:', parseError);
            console.log('Raw body:', event.body);
            return {
                statusCode: 400,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ error: 'Invalid JSON' })
            };
        }

        // **HANDLE VERIFICATION CHALLENGE**
        if (body.type === 'verification') {
            console.log('Processing verification challenge:', body.challenge);
            return {
                statusCode: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ challenge: body.challenge })
            };
        }

        // **Handle actual webhook events**
        console.log('Processing webhook event:', {
            type: body.type,
            object: body.object,
            object_id: body.object?.id
        });

        // For now, just log the full body to see what we're getting
        console.log('Full webhook body:', JSON.stringify(body, null, 2));

        // Simple response to acknowledge receipt
        return {
            statusCode: 200,
            headers: { 
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
            },
            body: JSON.stringify({ 
                success: true, 
                message: 'Webhook received',
                type: body.type || 'unknown'
            })
        };
        
    } catch (error) {
        console.error('Error processing webhook:', error);
        return {
            statusCode: 500,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                error: 'Internal Server Error', 
                details: error.message 
            })
        };
    }
};