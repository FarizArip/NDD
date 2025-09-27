// netlify/functions/notion-webhook.js
const { Client: DiscordClient, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const { Client: NotionClient } = require('@notionhq/client');

let discordClient = null;
let notionClient = null;

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

function initializeNotionClient() {
    if (!notionClient) {
        // Use NOTION_TOKEN for API calls
        notionClient = new NotionClient({ 
            auth: process.env.NOTION_TOKEN 
        });
        console.log('✅ Notion client initialized with API token');
    }
    return notionClient;
}

function verifyNotionWebhook(signature, body, secret) {
    // Use NOTION_SECRET for webhook verification (optional)
    if (!process.env.NOTION_SECRET) {
        console.log('⚠️ NOTION_SECRET not set, skipping webhook verification');
        return true; // Skip verification if secret not set
    }
    
    // ... verification logic using crypto
    return true; // Simplified for now
}

// Add at the top of your file (outside handler)
const recentWebhooks = new Map(); // pageId -> timestamp
const WEBHOOK_DEBOUNCE_TIME = 3000; // 3 seconds

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

    // Verify webhook signature if NOTION_SECRET is set
    const signature = event.headers['x-notion-signature'];
    if (!verifyNotionWebhook(signature, event.body, process.env.NOTION_SECRET)) {
        return { statusCode: 401, body: 'Unauthorized' };
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

function shouldProcessWebhook(pageId, webhookType) {
    const now = Date.now();
    const key = `${pageId}_${webhookType}`;
    
    // Check if we recently processed a similar webhook
    const lastProcessed = recentWebhooks.get(key);
    
    if (lastProcessed && (now - lastProcessed < WEBHOOK_DEBOUNCE_TIME)) {
        console.log(`🚫 Debouncing: Skipping ${webhookType} for page ${pageId}`);
        return false;
    }
    
    // Special case: ignore content_updated shortly after created
    if (webhookType === 'page.content_updated') {
        const createdKey = `${pageId}_page.created`;
        const recentlyCreated = recentWebhooks.get(createdKey);
        
        if (recentlyCreated && (now - recentlyCreated < WEBHOOK_DEBOUNCE_TIME)) {
            console.log(`🚫 Skipping content_updated (recently created): ${pageId}`);
            return false;
        }
    }
    
    // Update the timestamp
    recentWebhooks.set(key, now);
    
    // Clean up old entries
    setTimeout(() => {
        recentWebhooks.delete(key);
    }, WEBHOOK_DEBOUNCE_TIME + 1000);
    
    return true;
}

const pageStateCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

function hasMeaningfulChanges(pageId, currentData) {
    const previousState = pageStateCache.get(pageId);
    const now = Date.now();
    
    // Clean up old cache entries
    if (previousState && (now - previousState.timestamp > CACHE_TTL)) {
        pageStateCache.delete(pageId);
        return true; // Treat as meaningful change after cache expires
    }
    
    // For new pages or first time seeing this page
    if (!previousState) {
        pageStateCache.set(pageId, {
            title: currentData.title,
            content: currentData.content,
            jenis: currentData.jenis,
            deadline: currentData.deadline,
            timestamp: now
        });
        return true; // Always process new pages
    }
    
    // Check for actual changes
    const changes = [];
    
    if (previousState.title !== currentData.title) {
        changes.push('title');
    }
    if (previousState.content !== currentData.content) {
        changes.push('content');
    }
    if (previousState.jenis !== currentData.jenis) {
        changes.push('jenis');
    }
    if (previousState.deadline !== currentData.deadline) {
        changes.push('deadline');
    }
    
    const hasChanges = changes.length > 0;
    
    if (hasChanges) {
        console.log(`📊 Meaningful changes detected for ${pageId}:`, changes);
        // Update cache with new state
        pageStateCache.set(pageId, {
            title: currentData.title,
            content: currentData.content,
            jenis: currentData.jenis,
            deadline: currentData.deadline,
            timestamp: now
        });
    } else {
        console.log(`📊 No meaningful changes for ${pageId}`);
    }
    
    return hasChanges;
}

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

// Call it in your processPageWebhook function
async function processPageWebhook(webhookData) {
    console.log('🔍 Processing page webhook:', webhookData.type);
    
    // Extract page ID based on webhook type
    const pageId = extractPageId(webhookData);
    if (!pageId) {
        console.log('❌ Could not extract page ID from webhook');
        return;
    }
    
    // **NEW: Check if we should process this webhook**
    if (!shouldProcessWebhook(pageId, webhookData.type)) {
        return;
    }

    console.log('📄 Page ID:', pageId);
    
    const page = await fetchPage(pageId);
    if (!page) return;

    if (!isTargetDatabase(page.parent.database_id)) {
    console.log('🚫 Skipping page - not in target database');
    return;
    }

    // Extract properties - handle different webhook structures
    const properties = await fetchPageProperties(pageId);
    
    if (!properties) {
        console.log('❌ Could not fetch page properties');
        return;
    }
    console.log('📋 Available properties:', Object.keys(properties));
    
    // Extract data for Discord message
    const notionData = await extractNotionData(properties, pageId);
    console.log('📊 Extracted data:', notionData);
    
    if (!hasMeaningfulChanges(pageId, notionData)) {
        console.log(`🚫 No meaningful changes, skipping Discord message for ${pageId}`);
        return;
    }

    // Send to Discord
    await sendToDiscord(pageId, notionData, webhookData.type);
}

// **Add periodic cache cleanup**
setInterval(() => {
    const now = Date.now();
    let cleanedCount = 0;
    
    for (const [pageId, state] of pageStateCache.entries()) {
        if (now - state.timestamp > CACHE_TTL) {
            pageStateCache.delete(pageId);
            cleanedCount++;
        }
    }
    
    if (cleanedCount > 0) {
        console.log(`🧹 Cleaned up ${cleanedCount} old cache entries`);
    }
}, CACHE_TTL);

// **NEW: Extract page ID from different webhook structures**
function extractPageId(webhookData) {
    // For different webhook types, the page ID is in different places
    if (webhookData.entity?.id) {
        return webhookData.entity.id; // For content_updated events
    } // Try different possible locations for page ID
    return webhookData.page_id || 
           webhookData.id ||
           webhookData.object?.id ||
           (webhookData.data && webhookData.data.id);
}

// **NEW: Fetch page properties from Notion API**
async function fetchPageProperties(pageId) {
    try {
        console.log('🔗 Fetching page properties from Notion API...');
        const notion = initializeNotionClient();
        
        const page = await notion.pages.retrieve({
            page_id: pageId
        });
        
        console.log('✅ Page retrieved successfully');
        console.log('📋 Available properties:', Object.keys(page.properties || {}));
        
        return page.properties;
        
    } catch (error) {
        console.error('❌ Error fetching page from Notion API:', error);
        
        if (error.code === 'object_not_found') {
            console.error('❌ Page not found - check if the integration has access to the page');
        } else if (error.code === 'unauthorized') {
            console.error('❌ Notion token is invalid or lacks permissions');
        }
        
        return null;
    }
}

// **UPDATED: Extract notion data from actual page properties**
async function extractNotionData(properties, pageId) {
    if (!properties || Object.keys(properties).length === 0) {
        console.log('❌ No properties available');
        return getDefaultData();
    }
    
    console.log('🔧 Extracting data from properties...');
    
    // Debug: log all available properties
    Object.keys(properties).forEach(propName => {
        const prop = properties[propName];
        console.log(`Property "${propName}":`, {
            type: prop?.type,
            value: prop ? prop[prop.type] : 'undefined'
        });
    });

    const title = extractTitle(properties);
    const jenis = extractSelectProperty(properties, ['Jenis', 'Category', 'Status']);
    const deadline = extractDateProperty(properties, ['Deadline', 'Due Date', 'Due']);
    const pageContent = await extractPageContent(pageId);

    const extractedData = {
        title: title,
        content: pageContent,
        jenis: jenis,
        deadline: deadline
    };
    
    console.log('📊 Final extracted data:', extractedData);
    return extractedData;
}

// **NEW: Specialized extraction functions**
function extractTitle(properties) {
    console.log('🔍 Searching for title property...');
    
        // Try specific property names first
    const specificCandidates = [
        'Assignment Name', // Your actual property name
        'Name', 
        'Title', 
        'Task Name'
    ];

    // Try different title property names and types
    const titleCandidates = [
        { name: 'Assignment Name', type: 'title' }, // Add this first since it exists
        { name: 'Name', type: 'title' },
        { name: 'Title', type: 'title' },
        { name: 'Task', type: 'title' },
        { name: 'Task Name', type: 'title' },
    ];
    
    for (const propName of specificCandidates) {
        const prop = properties[propName];
        if (prop && prop.type === 'title' && prop.title?.[0]?.text?.content) {
            console.log(`✅ Found title in "${propName}":`, prop.title[0].text.content);
            return prop.title[0].text.content;
        }
    }

    for (const candidate of titleCandidates) {
        const prop = properties[candidate.name];
        console.log(`Checking "${candidate.name}":`, prop ? 'exists' : 'not found');
        
        if (prop && prop.type === candidate.type) {
            if (candidate.type === 'title' && prop.title?.[0]?.text?.content) {
                console.log(`✅ Found title in "${candidate.name}.title":`, prop.title[0].text.content);
                return prop.title[0].text.content;
            }
        }
    }
    
    // If no title property found, try to find any title-like property
    console.log('🔍 Searching for any title property...');
    for (const propName in properties) {
        const prop = properties[propName];
        if (prop.type === 'title' && prop.title?.[0]?.text?.content) {
            console.log(`✅ Found title in "${propName}":`, prop.title[0].text.content);
            return prop.title[0].text.content;
        }
    }
    
    console.log('❌ No title found in properties');
    return 'Untitled';
}

// **NEW: Extract page content from blocks**
async function extractPageContent(pageId) {
    try {
        console.log('📖 Fetching page content...');
        const blocks = await fetchPageBlocks(pageId);
        
        if (!blocks || blocks.length === 0) {
            return 'No content available';
        }
        
        let content = '';
        let contentLength = 0;
        const maxLength = 1000; // Discord character limit
        
        // Process each block
        for (const block of blocks) {
            if (contentLength >= maxLength) break;
            
            const blockText = extractTextFromBlock(block);
            if (blockText && contentLength + blockText.length <= maxLength) {
                content += blockText + '\n';
                contentLength += blockText.length;
            }
        }
        
        // Trim and add ellipsis if content was truncated
        content = content.trim();
        if (contentLength >= maxLength) {
            content += '...';
        }
        
        console.log(`✅ Extracted ${contentLength} characters of content`);
        return content || 'No text content';
        
    } catch (error) {
        console.error('❌ Error extracting page content:', error);
        return 'Error loading content';
    }
}

// **NEW: Fetch complete page to get parent database info**
async function fetchPage(pageId) {
    try {
        const notion = initializeNotionClient();
        const page = await notion.pages.retrieve({ page_id: pageId });
        return page;
    } catch (error) {
        console.error('❌ Error fetching page:', error);
        return null;
    }
}

// **NEW: Check if page belongs to target database**
function isTargetDatabase(databaseId) {
    const targetDatabaseId = process.env.TARGET_DATABASE_ID; // "10df242906098142a428e51111d13ae4"
    
    if (!targetDatabaseId) {
        console.log('⚠️ TARGET_DATABASE_ID not set, processing all pages');
        return true;
    }
    
    // Remove hyphens from both IDs for comparison
    const normalizeId = (id) => id.replace(/-/g, '').toLowerCase();
    const isTarget = normalizeId(databaseId) === normalizeId(targetDatabaseId);
    
    console.log(`📊 Database filter: ${databaseId} → ${isTarget ? '✅ PROCESS' : '🚫 SKIP'}`);
    return isTarget;
}

// **NEW: Fetch blocks from Notion API**
async function fetchPageBlocks(pageId) {
    const notion = initializeNotionClient();
    
    const response = await notion.blocks.children.list({
        block_id: pageId,
        page_size: 20 // Limit to first 20 blocks for performance
    });
    
    return response.results;
}

// **NEW: Extract text from a single block**
function extractTextFromBlock(block) {
    if (!block || !block.type) return '';
    
    const blockType = block.type;
    const blockData = block[blockType];
    
    if (!blockData.rich_text || blockData.rich_text.length === 0) {
        return '';
    }
    
    // Extract all rich text segments
    let text = '';
    for (const richText of blockData.rich_text) {
        if (richText.plain_text) {
            text += richText.plain_text;
        }
    }
    
    // Format based on block type
    switch (blockType) {
        case 'heading_1':
            return `# ${text}`;
        case 'heading_2':
            return `## ${text}`;
        case 'heading_3':
            return `### ${text}`;
        case 'bulleted_list_item':
            return `• ${text}`;
        case 'numbered_list_item':
            return `1. ${text}`;
        case 'to_do':
            const checked = blockData.checked ? '✅' : '☐';
            return `${checked} ${text}`;
        case 'paragraph':
        default:
            return text;
    }
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
        content: '',
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
        deadlineText = formatDeadline(notionData.deadline);
    }

    let jenisText = 'Not set';
    if (notionData.jenis) {
        jenisText = notionData.jenis;
    }

    // **NEW: Format content with proper line breaks**
    const formattedContent = notionData.content 
        ? notionData.content.split('\n').map(line => line.trim() ? `> ${line}` : '').join('\n')
        : 'No content available';
    
    return `
# **__----- :sparkles: ${notionData.title} (${jenisText}) :sparkles: -----__**

${formattedContent}

### **__----- :calendar_spiral:  Deadline ${deadlineText}  :calendar_spiral: -----__**
### **__----- ${isNew ? '🆕 *Tugas Baru*' : '✏️ *Tugas Update*'} -----__**
    `.trim();
} //**Page ID:** \`${pageId}\` // **Webhook Type:** ${webhookType}

// **ADD THIS NEW FUNCTION:**
function formatDeadline(deadlineString) {
    if (!deadlineString) return 'No deadline';
    
    try {
        const date = new Date(deadlineString);
        
        // Check if date is valid
        if (isNaN(date.getTime())) {
            return 'Invalid deadline';
        }
        
        // Format: "Saturday, September 27, 2025"
        return date.toLocaleDateString('id-ID', {
            weekday: 'long',
            year: 'numeric',
            month: 'long',
            day: 'numeric'
        });
    } catch (error) {
        console.error('Error formatting deadline:', error);
        return 'Error formatting deadline';
    }
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