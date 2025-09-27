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

function logCompleteWebhookStructure(webhookData) {
    console.log('=== COMPLETE WEBHOOK STRUCTURE ===');
    console.log(JSON.stringify(webhookData, null, 2));
    console.log('=== END WEBHOOK STRUCTURE ===');
}

// Call it in your processPageWebhook function
async function processPageWebhook(webhookData) {
    console.log('🔍 Processing page webhook:', webhookData.type);
    
    // **TEMPORARY: Log the complete structure**
    logCompleteWebhookStructure(webhookData);
    
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

// **ENHANCED: Extract properties with detailed debugging**
function extractProperties(webhookData) {
    console.log('🔍 Searching for properties in webhook data...');
    
    // Log the entire webhook structure to see what we're working with
    console.log('Webhook data keys:', Object.keys(webhookData));
    
    // Try different property locations
    if (webhookData.properties) {
        console.log('✅ Found properties in webhookData.properties');
        console.log('Properties available:', Object.keys(webhookData.properties));
        return webhookData.properties;
    }
    
    if (webhookData.data && webhookData.data.properties) {
        console.log('✅ Found properties in webhookData.data.properties');
        console.log('Properties available:', Object.keys(webhookData.data.properties));
        return webhookData.data.properties;
    }
    
    if (webhookData.object && webhookData.object.properties) {
        console.log('✅ Found properties in webhookData.object.properties');
        console.log('Properties available:', Object.keys(webhookData.object.properties));
        return webhookData.object.properties;
    }
    
    // For page.properties_updated, properties might be in a different structure
    if (webhookData.properties_updated) {
        console.log('✅ Found properties_updated field');
        // This might contain only the updated properties, not all properties
        return webhookData.properties_updated;
    }
    
    // Log the entire webhook data to see the structure
    console.log('📋 Full webhook data structure:', JSON.stringify(webhookData, null, 2).substring(0, 1000));
    
    console.log('❌ No properties found in expected locations');
    return {};
}

// **ENHANCED: Extract notion data with better property handling**
function extractNotionData(properties) {
    console.log('🔧 Extracting data from properties...');
    
    if (!properties || Object.keys(properties).length === 0) {
        console.log('❌ No properties provided to extractNotionData');
        return getDefaultData();
    }
    
    console.log('📋 Properties to extract from:', Object.keys(properties));
    
    // Debug each property
    Object.keys(properties).forEach(propName => {
        const prop = properties[propName];
        console.log(`Property "${propName}":`, {
            type: prop?.type,
            value: prop ? prop[prop.type] : 'undefined'
        });
    });
    
    const extractedData = {
        // Title extraction - try multiple property names and types
        title: extractTitle(properties),
        
        // Description extraction
        description: extractDescription(properties),
        
        // Select property extraction (Jenis means "Type" in Indonesian)
        jenis: extractSelectProperty(properties, ['Jenis', 'Type', 'Category', 'Status']),
        
        // Deadline extraction
        deadline: extractDateProperty(properties, ['Deadline', 'Due Date', 'Due'])
    };
    
    console.log('📊 Final extracted data:', extractedData);
    return extractedData;
}

// **NEW: Specialized extraction functions**
function extractTitle(properties) {
    // Try different title property names and types
    const titleCandidates = [
        { name: 'Name', type: 'title' },
        { name: 'Title', type: 'title' },
        { name: 'Task', type: 'title' },
        { name: 'Task Name', type: 'title' },
        // Also try rich_text fields that might contain titles
        { name: 'Name', type: 'rich_text' },
        { name: 'Title', type: 'rich_text' }
    ];
    
    for (const candidate of titleCandidates) {
        const prop = properties[candidate.name];
        if (prop && prop.type === candidate.type) {
            if (candidate.type === 'title' && prop.title?.[0]?.text?.content) {
                console.log(`✅ Found title in "${candidate.name}.title":`, prop.title[0].text.content);
                return prop.title[0].text.content;
            }
            if (candidate.type === 'rich_text' && prop.rich_text?.[0]?.text?.content) {
                console.log(`✅ Found title in "${candidate.name}.rich_text":`, prop.rich_text[0].text.content);
                return prop.rich_text[0].text.content;
            }
        }
    }
    
    console.log('❌ No title found in properties');
    return 'Untitled';
}

function extractDescription(properties) {
    const descCandidates = ['Description', 'Notes', 'Details', 'Content'];
    
    for (const propName of descCandidates) {
        const prop = properties[propName];
        if (prop) {
            if (prop.type === 'rich_text' && prop.rich_text?.[0]?.text?.content) {
                console.log(`✅ Found description in "${propName}":`, prop.rich_text[0].text.content);
                return prop.rich_text[0].text.content;
            }
            if (prop.type === 'title' && prop.title?.[0]?.text?.content) {
                console.log(`✅ Found description in "${propName}.title":`, prop.title[0].text.content);
                return prop.title[0].text.content;
            }
        }
    }
    
    console.log('❌ No description found');
    return '';
}

function extractSelectProperty(properties, possibleNames) {
    for (const propName of possibleNames) {
        const prop = properties[propName];
        if (prop && prop.type === 'select') {
            if (prop.select?.name) {
                console.log(`✅ Found select property "${propName}":`, prop.select.name);
                return prop.select.name;
            } else if (prop.select === null) {
                console.log(`✅ Select property "${propName}" exists but no value selected`);
                return 'Not selected';
            }
        }
    }
    
    console.log(`❌ No select property found from: ${possibleNames.join(', ')}`);
    return null;
}

function extractDateProperty(properties, possibleNames) {
    for (const propName of possibleNames) {
        const prop = properties[propName];
        if (prop && prop.type === 'date' && prop.date?.start) {
            console.log(`✅ Found date property "${propName}":`, prop.date.start);
            return prop.date.start;
        }
    }
    
    console.log(`❌ No date property found from: ${possibleNames.join(', ')}`);
    return null;
}

function getDefaultData() {
    return {
        title: 'Untitled',
        description: '',
        jenis: null,
        deadline: null
    };
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

    let jenisText = 'Not set';
    if (notionData.jenis) {
        jenisText = notionData.jenis;
    }
    
    return `
# ${notionData.title}

**Description:**  
${notionData.description}

**Jenis:** ${jenisText}
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