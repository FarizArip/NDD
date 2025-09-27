require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const { Client: NotionClient } = require('@notionhq/client');
const express = require('express');

const app = express();
app.use(express.json());

// Initialize clients
const discordClient = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages]
});

const notion = new NotionClient({ 
    auth: process.env.NOTION_TOKEN 
});

const messageStore = new Map();

// Health check route (required by Render)
app.get('/', (req, res) => {
    res.json({ 
        status: 'OK', 
        message: 'Notion-Discord bot is running!',
        timestamp: new Date().toISOString()
    });
});

// Webhook endpoint for Notion
app.post('/notion-webhook', async (req, res) => {
    try {
        // Verify webhook secret for security
        const signature = req.headers['notion-signature'];
        if (process.env.NOTION_WEBHOOK_SECRET && signature !== process.env.NOTION_WEBHOOK_SECRET) {
            console.log('Unauthorized webhook attempt');
            return res.status(401).send('Unauthorized');
        }

        const { object: page_id, properties, created_time } = req.body;
        
        console.log('Received webhook for page:', page_id);
        
        const notionData = extractNotionData(properties);
        const isNewPage = Date.now() - new Date(created_time).getTime() < 60000;
        
        if (isNewPage && !messageStore.has(page_id)) {
            await createNewMessage(page_id, notionData);
        } else {
            await updateMessage(page_id, notionData);
        }
        
        res.status(200).send('OK');
    } catch (error) {
        console.error('Webhook error:', error);
        res.status(500).send('Error');
    }
});

// Discord bot functions (same as before)
async function createNewMessage(notionPageId, notionData) {
    try {
        const channel = await discordClient.channels.fetch(process.env.DISCORD_CHANNEL_ID);
        const messageContent = formatMessageContent(notionData, notionPageId, true);
        const message = await channel.send(messageContent);
        
        messageStore.set(notionPageId, {
            messageId: message.id,
            channelId: channel.id
        });
        
        console.log(`Created new message for Notion page ${notionPageId}`);
        return message.id;
    } catch (error) {
        console.error('Error creating message:', error);
    }
}

async function updateMessage(notionPageId, updatedData) {
    try {
        const messageInfo = messageStore.get(notionPageId);
        if (!messageInfo) {
            return await createNewMessage(notionPageId, updatedData);
        }
        
        const channel = await discordClient.channels.fetch(messageInfo.channelId);
        const message = await channel.messages.fetch(messageInfo.messageId);
        const messageContent = formatMessageContent(updatedData, notionPageId, false);
        
        await message.edit(messageContent);
        console.log(`Updated message for Notion page ${notionPageId}`);
    } catch (error) {
        console.error('Error updating message:', error);
    }
}

function formatMessageContent(notionData, notionPageId, isNew) {
    return `
# ${notionData.title || 'New Item'}

**Description:**  
${notionData.description || 'No description provided'}

**Status:** ${notionData.status || 'Todo'}  
**Priority:** ${notionData.priority || 'Medium'}  
**Last Updated:** ${new Date().toLocaleString()}  

${isNew ? '🆕 *New item created from Notion*' : '✏️ *Updated from Notion*'}
    `.trim();
}

function extractNotionData(properties) {
    return {
        title: properties.Name?.title[0]?.text?.content || 'Untitled',
        description: properties.Description?.rich_text[0]?.text?.content || '',
        status: properties.Status?.select?.name || 'Todo',
        priority: properties.Priority?.select?.name || 'Medium'
    };
}

// Start the server and bot
const PORT = process.env.PORT || 3000;

discordClient.once('ready', () => {
    console.log(`🤖 Discord bot logged in as ${discordClient.user.tag}`);
});

app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    discordClient.login(process.env.DISCORD_TOKEN);
});

// Handle graceful shutdown
process.on('SIGTERM', () => {
    console.log('SIGTERM received, shutting down gracefully');
    discordClient.destroy();
    process.exit(0);
});