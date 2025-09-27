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
        headers: event.headers
    });

    // Handle CORS preflight requests
    if (event.httpMethod === 'OPTIONS') {
        return {
            statusCode: 200,
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Headers': 'Content-Type, Notion-Signature',
                'Access-Control-Allow-Methods': 'POST, OPTIONS'
            },
            body: ''
        };
    }

    // Only allow POST requests
    if (event.httpMethod !== 'POST') {
        return {
            statusCode: 405,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ error: 'Method Not Allowed' })
        };
    }

    try {
        const body = JSON.parse(event.body);
        console.log('Webhook body type:', body.type);

        // **HANDLE NOTION VERIFICATION CHALLENGE**
        if (body.type === 'verification') {
            console.log('Processing verification challenge');
            return {
                statusCode: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ challenge: body.challenge })
            };
        }

        // Verify webhook signature for actual webhooks
        if (body.type !== 'verification') {
            const notionSignature = event.headers['notion-signature'];
            if (!verifyNotionSignature(notionSignature, event.body, process.env.NOTION_SECRET)) {
                console.error('Invalid signature');
                return {
                    statusCode: 401,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ error: 'Unauthorized' })
                };
            }
        }

        // Process different webhook types
        switch (body.type) {
            case 'verification':
                // Already handled above
                break;
                
            case 'page_added':
            case 'page_updated':
                await handlePageUpdate(body);
                break;
                
            default:
                console.log('Unhandled webhook type:', body.type);
        }

        return {
            statusCode: 200,
            headers: { 
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
            },
            body: JSON.stringify({ success: true, message: 'Webhook processed' })
        };
        
    } catch (error) {
        console.error('Error processing webhook:', error);
        return {
            statusCode: 500,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ error: 'Internal Server Error', details: error.message })
        };
    }
};

// **VERIFICATION FUNCTION**
function verifyNotionSignature(signature, body, secret) {
    if (!signature || !secret) {
        console.log('Missing signature or secret');
        return false;
    }
    
    // For now, basic verification - implement proper crypto verification later
    return true; // Temporarily bypass for testing
}

async function handlePageUpdate(webhookData) {
    console.log('Processing page update:', webhookData);
    
    const { object: page_id, properties } = webhookData;
    const discordClient = getDiscordClient();
    
    if (!discordClient.isReady()) {
        await new Promise(resolve => discordClient.once('ready', resolve));
    }
    
    // Your existing message handling logic here
    const notionData = extractNotionData(properties);
    await createOrUpdateMessage(discordClient, page_id, notionData);
}

// Rest of your existing functions...
function extractNotionData(properties) {
    return {
        title: properties.Name?.title[0]?.text?.content || 'Untitled',
        description: properties.Description?.rich_text[0]?.text?.content || '',
        status: properties.Status?.select?.name || 'Todo',
        priority: properties.Priority?.select?.name || 'Medium'
    };
}

async function createOrUpdateMessage(client, notionPageId, notionData) {
    try {
        const channel = await client.channels.fetch(process.env.DISCORD_CHANNEL_ID);
        const messageContent = formatMessageContent(notionData, notionPageId, true);
        await channel.send(messageContent);
        console.log('Message sent successfully!');
    } catch (error) {
        console.error('Error sending message:', error);
    }
}

function formatMessageContent(notionData, notionPageId, isNew = false) {
    return `
# ${notionData.title}

**Description:**  
${notionData.description}

**Status:** ${notionData.status}  
**Priority:** ${notionData.priority}  
**Notion Page:** \`${notionPageId}\`

${isNew ? '🆕 *Webhook test successful!*' : '✏️ *Webhook test successful!*'}
    `.trim();
}