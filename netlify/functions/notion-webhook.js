// netlify/functions/notion-webhook.js
const { Client: DiscordClient, GatewayIntentBits, EmbedBuilder } = require('discord.js');

let discordClient = null;

async function initializeDiscordClient() {
    if (!discordClient) {
        discordClient = new DiscordClient({
            intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages]
        });
        
        discordClient.on('ready', () => {
            console.log('✅ Discord client ready!');
        });
        
        await discordClient.login(process.env.DISCORD_TOKEN);
    }
    return discordClient;
}

exports.handler = async (event, context) => {
    console.log('=== NOTION WEBHOOK RECEIVED ===');
    console.log('Method:', event.httpMethod);

    // Handle CORS and method checks
    if (event.httpMethod === 'OPTIONS') {
        return corsResponse();
    }

    if (event.httpMethod !== 'POST') {
        return methodNotAllowedResponse();
    }

    try {
        if (!event.body) {
            return badRequestResponse('No body received');
        }

        const body = JSON.parse(event.body);
        console.log('📝 Webhook type:', body.type);

        // Handle verification
        if (body.type === 'verification') {
            console.log('✅ Handling verification challenge');
            return {
                statusCode: 200,
                body: JSON.stringify({ challenge: body.challenge })
            };
        }

        // **FIXED: Handle all page-related webhook types**
        if (isPageWebhook(body.type)) {
            console.log('🔄 Processing page webhook');
            await processPageWebhook(body);
        } else {
            console.log('ℹ️ Ignoring non-page webhook type:', body.type);
        }

        return successResponse('Webhook processed');

    } catch (error) {
        console.error('❌ Error:', error);
        return errorResponse(error.message);
    }
};

// **NEW: Check if it's a page-related webhook**
function isPageWebhook(webhookType) {
    const pageWebhookTypes = [
        'page.created',
        'page.updated', 
        'page.properties_updated',
        'page.content_updated',
        'page.added_to_database',
        'page.removed_from_database'
    ];
    
    return pageWebhookTypes.includes(webhookType) || 
           webhookType === 'page_added' || // legacy type
           webhookType === 'page_updated'; // legacy type
}

// **UPDATED: Process page webhooks**
async function processPageWebhook(webhookData) {
    console.log('🔍 Processing page webhook:', webhookData.type);
    
    // Extract page ID based on webhook type
    const pageId = extractPageId(webhookData);
    if (!pageId) {
        console.log('❌ Could not extract page ID from webhook');
        return;
    }
    
    console.log('📄 Page ID:', pageId);
    
    // Extract properties - handle different webhook structures
    const properties = extractProperties(webhookData);
    console.log('📋 Available properties:', Object.keys(properties));
    
    // Extract data for Discord message
    const notionData = extractNotionData(properties);
    console.log('📊 Extracted data:', notionData);
    
    // Send to Discord
    await sendToDiscord(pageId, notionData, webhookData.type);
}

// **NEW: Extract page ID from different webhook structures**
function extractPageId(webhookData) {
    // Try different possible locations for page ID
    return webhookData.page_id || 
           webhookData.id ||
           webhookData.object?.id ||
           (webhookData.data && webhookData.data.id);
}

// **NEW: Extract properties from different webhook structures**
function extractProperties(webhookData) {
    // Try different property locations
    if (webhookData.properties) {
        return webhookData.properties; // Most common
    }
    
    if (webhookData.data?.properties) {
        return webhookData.data.properties;
    }
    
    if (webhookData.object?.properties) {
        return webhookData.object.properties;
    }
    
    console.log('⚠️ No properties found in webhook data');
    return {};
}

// **YOUR EXISTING extractNotionData FUNCTION**
function extractNotionData(properties) {
    console.log('🔧 Extracting data from properties...');
    
    // Debug: log all properties to see what's available
    console.log('All properties:', Object.keys(properties));
    
    return {
        title: properties.Name?.title[0]?.text?.content || 
               properties.Title?.title[0]?.text?.content || 
               'Untitled',
        description: properties.Description?.rich_text[0]?.text?.content || '',      
        // Status with better debugging
        jenis: extractSelectProperty(properties, ['Jenis', 'Status', 'State'], null),
        
        // Priority
        priority: extractSelectProperty(properties, ['Priority', 'Importance'], 'PNJ'),
        
        // Deadline
        deadline: properties.Deadline?.date?.start || 
                  properties['Due Date']?.date?.start || 
                  null
    };
}

// **NEW: Helper to extract select properties**
function extractSelectProperty(properties, possibleNames, defaultValue) {
    for (const propName of possibleNames) {
        if (properties[propName]?.select?.name) {
            console.log(`✅ Found select property "${propName}":`, properties[propName].select.name);
            return properties[propName].select.name;
        }
    }
    console.log(`❌ No select property found from: ${possibleNames.join(', ')}`);
    return defaultValue;
}

// **UPDATED: Send to Discord**
async function sendToDiscord(pageId, notionData, webhookType) {
    try {
        const client = await initializeDiscordClient();
        
        if (!client.isReady()) {
            await new Promise(resolve => client.once('ready', resolve));
        }
        
        const channel = await client.channels.fetch(process.env.DISCORD_CHANNEL_ID);
        const messageContent = formatMessageContent(notionData, pageId, webhookType);
        
        console.log('📤 Sending message to Discord...');
        const message = await channel.send(messageContent);
        
        console.log('✅ Message sent successfully! ID:', message.id);
        
    } catch (error) {
        console.error('❌ Error sending to Discord:', error);
    }
}

// **UPDATED: Format message content**
function formatMessageContent(notionData, pageId, webhookType) {
    const isNew = webhookType.includes('.created') || webhookType.includes('_added');
    
    let deadlineText = 'No deadline';
    if (notionData.deadline) {
        deadlineText = new Date(notionData.deadline).toLocaleDateString();
    }
    
    return `
# ${notionData.title}

**Description:**  
${notionData.description}

**Jenis:** ${notionData.jenis}
**Deadline:** ${deadlineText}  
**Page ID:** \`${pageId}\`
**Webhook Type:** ${webhookType}

${isNew ? '🆕 *New page created in Notion*' : '✏️ *Page updated in Notion*'}
    `.trim();
}

// Response helpers (keep your existing ones)
function corsResponse() {
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

function methodNotAllowedResponse() {
    return {
        statusCode: 405,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Method Not Allowed' })
    };
}

function badRequestResponse(message) {
    return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: message })
    };
}

function successResponse(message) {
    return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ success: true, message: message })
    };
}

function errorResponse(message) {
    return {
        statusCode: 500,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Internal Server Error', details: message })
    };
}