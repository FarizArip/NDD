const { Client, GatewayIntentBits } = require('discord.js');

// Initialize Discord client (serverless-friendly)
let discordClient;
function getDiscordClient() {
    if (!discordClient) {
        discordClient = new Client({
            intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages]
        });
        
        // Login once (Netlify functions reuse environments)
        discordClient.login(process.env.DISCORD_TOKEN);
    }
    return discordClient;
}

// In-memory store (for demo - use a database in production)
const messageStore = new Map();

exports.handler = async (event, context) => {
    // Only allow POST requests
    if (event.httpMethod !== 'POST') {
        return {
            statusCode: 405,
            body: JSON.stringify({ error: 'Method Not Allowed' })
        };
    }

    try {
        // Verify webhook secret (important!)
        const notionSignature = event.headers['notion-signature'];
        if (notionSignature !== process.env.NOTION_SECRET) {
            return {
                statusCode: 401,
                body: JSON.stringify({ error: 'Unauthorized' })
            };
        }

        const body = JSON.parse(event.body);
        const { object: page_id, properties, created_time } = body;
        
        // Process the webhook
        await handleNotionWebhook(page_id, properties, created_time);
        
        return {
            statusCode: 200,
            body: JSON.stringify({ success: true, message: 'Webhook processed' })
        };
        
    } catch (error) {
        console.error('Error processing webhook:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Internal Server Error' })
        };
    }
};

async function handleNotionWebhook(page_id, properties, created_time) {
    const discordClient = getDiscordClient();
    
    // Wait for client to be ready
    if (!discordClient.isReady()) {
        await new Promise(resolve => discordClient.once('ready', resolve));
    }
    
    const notionData = extractNotionData(properties);
    const isNewPage = Date.now() - new Date(created_time).getTime() < 60000;
    
    if (isNewPage && !messageStore.has(page_id)) {
        await createNewMessage(discordClient, page_id, notionData);
    } else {
        await updateMessage(discordClient, page_id, notionData);
    }
}

async function createNewMessage(client, notionPageId, notionData) {
    try {
        const channel = await client.channels.fetch(process.env.DISCORD_CHANNEL_ID);
        
        const messageContent = formatMessageContent(notionData, notionPageId, true);
        const message = await channel.send(messageContent);
        
        messageStore.set(notionPageId, {
            messageId: message.id,
            channelId: channel.id
        });
        
        console.log(`Created message for Notion page ${notionPageId}`);
    } catch (error) {
        console.error('Error creating message:', error);
    }
}

async function updateMessage(client, notionPageId, updatedData) {
    try {
        const messageInfo = messageStore.get(notionPageId);
        if (!messageInfo) {
            return await createNewMessage(client, notionPageId, updatedData);
        }
        
        const channel = await client.channels.fetch(messageInfo.channelId);
        const message = await channel.messages.fetch(messageInfo.messageId);
        
        const messageContent = formatMessageContent(updatedData, notionPageId, false);
        await message.edit(messageContent);
        
        console.log(`Updated message for Notion page ${notionPageId}`);
    } catch (error) {
        console.error('Error updating message:', error);
    }
}

function extractNotionData(properties) {
    return {
        title: properties.Name?.title[0]?.text?.content || 'Untitled',
        description: properties.Description?.rich_text[0]?.text?.content || '',
        status: properties.Status?.select?.name || 'Todo',
        priority: properties.Priority?.select?.name || 'Medium'
    };
}

function formatMessageContent(notionData, notionPageId, isNew = false) {
    return `
# ${notionData.title}

**Description:**  
${notionData.description}

**Status:** ${notionData.status}  
**Priority:** ${notionData.priority}  
**Last Updated:** ${new Date().toLocaleString()}  
**Notion Page:** \`${notionPageId}\`

${isNew ? '🆕 *New item created from Notion*' : '✏️ *Updated from Notion*'}
    `.trim();
}