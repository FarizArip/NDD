// netlify/functions/notion-webhook.js
const { Client: DiscordClient, GatewayIntentBits } = require('discord.js');
const { Client: NotionClient } = require('@notionhq/client');

// Initialize clients
let discordClient;
let notionClient;

function getDiscordClient() {
    if (!discordClient) {
        discordClient = new DiscordClient({
            intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages]
        });
        discordClient.login(process.env.DISCORD_TOKEN);
    }
    return discordClient;
}

function getNotionClient() {
    if (!notionClient) {
        notionClient = new NotionClient({ auth: process.env.NOTION_TOKEN });
    }
    return notionClient;
}

// **STORAGE FUNCTIONS** - Put these at the top level of your file
async function storeMessageId(notionPageId, discordMessageId) {
    try {
        const notion = getNotionClient();
        
        await notion.pages.update({
            page_id: notionPageId,
            properties: {
                'Discord Message ID': {
                    rich_text: [{ 
                        type: 'text',
                        text: { content: discordMessageId } 
                    }]
                }
            }
        });
        console.log(`Stored message ID ${discordMessageId} for Notion page ${notionPageId}`);
    } catch (error) {
        console.error('Error storing message ID:', error);
    }
}

async function getMessageId(notionPageId) {
    try {
        const notion = getNotionClient();
        
        const page = await notion.pages.retrieve({ page_id: notionPageId });
        const messageIdProperty = page.properties['Discord Message ID'];
        
        if (messageIdProperty && messageIdProperty.type === 'rich_text') {
            return messageIdProperty.rich_text[0]?.text?.content;
        }
        return null;
    } catch (error) {
        console.error('Error retrieving message ID:', error);
        return null;
    }
}

// **MAIN WEBHOOK HANDLER**
exports.handler = async (event, context) => {
    console.log('Received webhook request');

    // Handle CORS and method checks first
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
        console.log('Webhook type:', body.type);

        // Handle verification challenge
        if (body.type === 'verification') {
            return verificationResponse(body.challenge);
        }

        // Verify signature (simplified for now)
        const notionSignature = event.headers['x-notion-signature'];
        if (!notionSignature) {
            return unauthorizedResponse('Missing signature');
        }

        // Process the webhook
        await processNotionWebhook(body);

        return successResponse('Webhook processed successfully');

    } catch (error) {
        console.error('Error:', error);
        return errorResponse(error.message);
    }
};

// **PROCESS NOTION WEBHOOK** - Integrated with storage
async function processNotionWebhook(webhookData) {
    const { object, created_time } = webhookData;
    
    if (!object || object !== 'page') {
        console.log('Not a page object, skipping');
        return;
    }

    const pageId = webhookData.page_id || webhookData.id;
    if (!pageId) {
        console.log('No page ID found');
        return;
    }

    const notionData = extractNotionData(webhookData);
    const discordClient = getDiscordClient();

    // Wait for Discord client to be ready
    if (!discordClient.isReady()) {
        await new Promise(resolve => discordClient.once('ready', resolve));
    }

    // **CHECK IF WE ALREADY HAVE A MESSAGE FOR THIS PAGE**
    const existingMessageId = await getMessageId(pageId);
    
    if (existingMessageId) {
        // **UPDATE EXISTING MESSAGE**
        await updateExistingMessage(discordClient, pageId, existingMessageId, notionData);
    } else {
        // **CREATE NEW MESSAGE**
        await createNewMessage(discordClient, pageId, notionData);
    }
}

// **CREATE NEW MESSAGE** - with storage
async function createNewMessage(discordClient, notionPageId, notionData) {
    try {
        const channel = await discordClient.channels.fetch(process.env.DISCORD_CHANNEL_ID);
        const messageContent = formatMessageContent(notionData, notionPageId, true);
        
        const message = await channel.send(messageContent);
        
        // **STORE THE MESSAGE ID IN NOTION**
        await storeMessageId(notionPageId, message.id);
        
        console.log(`Created and stored message ${message.id} for Notion page ${notionPageId}`);
        
    } catch (error) {
        console.error('Error creating message:', error);
    }
}

// **UPDATE EXISTING MESSAGE** - using stored ID
async function updateExistingMessage(discordClient, notionPageId, discordMessageId, notionData) {
    try {
        const channel = await discordClient.channels.fetch(process.env.DISCORD_CHANNEL_ID);
        const message = await channel.messages.fetch(discordMessageId);
        
        const messageContent = formatMessageContent(notionData, notionPageId, false);
        await message.edit(messageContent);
        
        console.log(`Updated message ${discordMessageId} for Notion page ${notionPageId}`);
        
    } catch (error) {
        if (error.code === 10008) { // Unknown Message error
            console.log(`Message ${discordMessageId} not found, creating new one`);
            // Message was deleted, create a new one
            await storeMessageId(notionPageId, null); // Clear invalid ID
            await createNewMessage(discordClient, notionPageId, notionData);
        } else {
            console.error('Error updating message:', error);
        }
    }
}

// **HELPER FUNCTIONS** (keep your existing ones)
function extractNotionData(webhookData) {
    const properties = webhookData.properties || {};
    return {
        title: properties.Name?.title[0]?.text?.content || 
               properties.Title?.title[0]?.text?.content || 
               'Untitled',
        description: properties.Description?.rich_text[0]?.text?.content || '',
        jenis: properties.Jenis?.select?.name || '',
        priority: properties.Priority?.select?.name || 'PNJ',
        deadline: properties.Deadline?.date?.start || null
    };
}

function formatMessageContent(notionData, notionPageId, isNew = false) {
    // Format deadline for display
    let deadlineDisplay = 'No deadline';
    if (notionData.deadline) {
        if (typeof notionData.deadline === 'string') {
            // Simple string date
            deadlineDisplay = new Date(notionData.deadline).toLocaleDateString();
        } else if (notionData.deadline.formatted) {
            // Enhanced deadline object
            deadlineDisplay = notionData.deadline.formatted;
            if (notionData.deadline.isPast) {
                deadlineDisplay += ' ⚠️ (Overdue)';
            }
        }
    }
    
    return `
# ${notionData.title}

**Description:**  
${notionData.description}

**Status:** ${notionData.jenis}  
**Deadline:** ${deadlineDisplay}  
**Notion Page:** \`${notionPageId}\`
**Last Updated:** ${new Date().toLocaleString()}

${isNew ? '🆕 *New item from Notion*' : '✏️ *Updated from Notion*'}
    `.trim();
}

// **RESPONSE HELPERS**
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

function unauthorizedResponse(message) {
    return {
        statusCode: 401,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: message })
    };
}

function verificationResponse(challenge) {
    return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ challenge: challenge })
    };
}

function successResponse(message) {
    return {
        statusCode: 200,
        headers: { 
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
        },
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
app.listen(3000, () => {
    console.log('Webhook server listening on port 3000');
    discordClient.login('YOUR_DISCORD_BOT_TOKEN');
});