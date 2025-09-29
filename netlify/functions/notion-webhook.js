// netlify/functions/notion-webhook.js
const { Client: DiscordClient, GatewayIntentBits, EmbedBuilder, Events } = require('discord.js');
const { Client: NotionClient } = require('@notionhq/client');

let discordClient = null;
let notionClient = null;

const pageStateCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const processedPages = new Set(); // This will only work per function instance

// Add these configuration constants at the top
const TRANSMISSION_CONFIG = {
    // Only send messages when these select values are chosen
    enabledStatuses: ['PNJ', 'Ulangan', 'Projek'], // Add your desired statuses
    disabledStatuses: ['Done', 'Cancelled', 'Out'], // Statuses that should NOT send messages
    
    // Only these property changes should trigger updates
    relevantProperties: ['Assignment Name', 'Jenis', 'Deadline', 'Priority', 'Content'],
    
    // Webhook types that should be processed
    allowedWebhookTypes: [
        'page.created',
        'page.properties_updated',
        'page.content_updated' // **NEW: Allow content updates**
    ],

    // Property that controls transmission
    controlProperty: 'Priority', // or 'Transmit', 'Send to Discord', etc.
    
    // **NEW: Configure default behavior**
    defaultTransmit: false // ✅ Set to false to block by default
};

async function initializeDiscordClient() {
    if (!discordClient) {
        discordClient = new DiscordClient({
            intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages]
        });
        
        discordClient.on(Events.ClientReady, () => {
            console.log('✅ Discord client ready! Logged in as:', discordClient.user.tag);
        });
        
        discordClient.on('error', (error) => {
            console.error('❌ Discord client error:', error);
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

// **NEW: Extract page ID from different webhook structures**
function extractPageId(webhookData) {
    if (webhookData.entity?.id) {
        return webhookData.entity.id;
    }
    return webhookData.page_id || webhookData.id || webhookData.object?.id;
}

// **NEW: Check if page belongs to target database**
function isTargetDatabase(databaseId) {
    if (!databaseId) {
        console.log('❌ No database ID provided');
        return false;
    }
    
    const targetDatabaseId = process.env.TARGET_DATABASE_ID;
    
    if (!targetDatabaseId) {
        console.log('⚠️ TARGET_DATABASE_ID not set, processing all pages');
        return true;
    }
    
    const normalizeId = (id) => id.replace(/-/g, '').toLowerCase();
    const isTarget = normalizeId(databaseId) === normalizeId(targetDatabaseId);
    
    console.log(`📊 Database filter: ${databaseId} → ${isTarget ? '✅ PROCESS' : '🚫 SKIP'}`);
    return isTarget;
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

        // **NEW: Aggressive filtering at the top level**
        if (shouldFilterWebhook(body)) {
            console.log('🚫 Top-level filter: Skipping webhook');
            return successResponse('Webhook filtered out');
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

// **NEW: Top-level webhook filtering**
function shouldFilterWebhook(webhookData) {
    // **CHANGED: Only filter out webhook types we don't want**
    const filteredTypes = [
        // Remove 'page.content_updated' from here
        'page.added_to_database',
        'page.removed_from_database'
        // Add any other webhook types you want to ignore
    ];
    
    if (filteredTypes.includes(webhookData.type)) {
        console.log(`🚫 Filtering out ${webhookData.type} at top level`);
        return true;
    }

    // **NEW: Also check if this webhook type is allowed**
    if (!TRANSMISSION_CONFIG.allowedWebhookTypes.includes(webhookData.type)) {
        console.log(`🚫 Webhook type ${webhookData.type} not in allowed types`);
        return true;
    }
    
    return false;
}

function hasRelevantChangesWithTracking({ pageId, currentData, webhookType, changedProperties = [] }) {
    
    console.log('🔍 hasRelevantChangesWithTracking called with:', {
    pageId,
    webhookType,
    changedPropertiesType: typeof changedProperties,
    changedPropertiesValue: changedProperties
    });
    
    // **ADD THIS DEBUG LINE**
    console.log('📊 changedProperties is Array?:', Array.isArray(changedProperties));
    
    const previousState = pageStateCache.get(pageId);
    const now = Date.now();
    
    // Clean up old cache entries
    if (previousState && (now - previousState.timestamp > CACHE_TTL)) {
        pageStateCache.delete(pageId);
        console.log('🔄 Cache expired, treating as new change');
        return true;
    }
    
    // For new pages, always process
    if (!previousState) {
        pageStateCache.set(pageId, {
            ...currentData,
            timestamp: now
        });
        return true;
    }
    
    // **NEW: Special handling for content updates**
    if (webhookType === 'page.content_updated') {
        const contentChanged = previousState.content !== currentData.content;
        console.log(`📝 Content change detected: ${contentChanged ? '✅ CHANGED' : '🚫 UNCHANGED'}`);
        
        if (contentChanged) {
            pageStateCache.set(pageId, {
                ...currentData,
                timestamp: now
            });
        }
        return contentChanged;
    }

    // If we know what properties changed, check only those
    if (changedProperties.length > 0) {
        const hasRelevant = hasRelevantChanges(previousState, currentData, changedProperties);
        if (hasRelevant) {
            pageStateCache.set(pageId, {
                ...currentData,
                timestamp: now
            });
        }
        return hasRelevant;
    }
    
    // Fallback: check all relevant properties
    const relevantProps = TRANSMISSION_CONFIG.relevantProperties;
    const changes = [];
    
    relevantProps.forEach(prop => {
        const propKey = prop.toLowerCase().replace(' ', '_');
        if (previousState[propKey] !== currentData[propKey]) {
            changes.push(prop);
        }
    });
    
    const hasChanges = changes.length > 0;
    
    if (hasChanges) {
        console.log(`📊 Relevant properties changed:`, changes);
        pageStateCache.set(pageId, {
            ...currentData,
            timestamp: now
        });
    } else {
        console.log(`📊 No relevant properties changed`);
    }
    
    return hasChanges;
}

// **NEW: Extract changed properties from webhook data**
function getChangedProperties(webhookData) {
    try {
        // Check if properties_updated exists and is an object
        if (webhookData.properties_updated && typeof webhookData.properties_updated === 'object') {
            const keys = Object.keys(webhookData.properties_updated);
            console.log(`📊 Changed properties detected:`, keys);
            return keys;
        }
        
        // For content_updated events, return a special indicator
        if (webhookData.type === 'page.content_updated') {
            console.log('📝 Content update - treating as relevant change');
            return ['content']; // Special case for content updates
        }
        
        console.log('📊 No specific changed properties detected');
        return [];
        
    } catch (error) {
        console.error('❌ Error getting changed properties:', error);
        return [];
    }
}

// **NEW: Check if page should be transmitted based on control property**
function shouldTransmitPage(properties) {
    const controlProp = properties[TRANSMISSION_CONFIG.controlProperty];
    
    // If no control property exists, default to sending (or not sending)
    if (!controlProp) {
        console.log(`⚠️ No "${TRANSMISSION_CONFIG.controlProperty}" property found, defaulting to transmit`);
        return TRANSMISSION_CONFIG.defaultTransmit; // or false depending on your preference
    }
    
    if (controlProp.type === 'select') {
        if (controlProp.select?.name) {
            const status = controlProp.select.name;
            const shouldTransmit = TRANSMISSION_CONFIG.enabledStatuses.includes(status);
            
            console.log(`📊 Transmission check: "${status}" → ${shouldTransmit ? '✅ SEND' : '🚫 BLOCK'}`);
            return shouldTransmit;
        } else {
            // If control property exists but no value selected, default behavior
            console.log(`⚠️ "${TRANSMISSION_CONFIG.controlProperty}" exists but no value selected, defaulting to ${TRANSMISSION_CONFIG.defaultTransmit ? 'TRANSMIT' : 'BLOCK'}`);
            return TRANSMISSION_CONFIG.defaultTransmit;
        }
    }
    
    console.log(`⚠️ "${TRANSMISSION_CONFIG.controlProperty}" is not a select property, defaulting to ${TRANSMISSION_CONFIG.defaultTransmit ? 'TRANSMIT' : 'BLOCK'}`);
    return TRANSMISSION_CONFIG.defaultTransmit;
}

// **NEW: Check if changes are relevant**
function hasRelevantChanges(previousData, currentData, changedProperties = []) {
    // **FIX: Ensure changedProperties is always an array**
    if (!Array.isArray(changedProperties)) {
        console.warn('⚠️ changedProperties is not an array, converting to empty array. Received:', typeof changedProperties, changedProperties);
        changedProperties = [];
    }
    
    // If we don't know what changed, check all relevant properties
    if (changedProperties.length === 0) {
        const relevantProps = TRANSMISSION_CONFIG.relevantProperties;
        return relevantProps.some(prop => {
            const previousValue = previousData[prop.toLowerCase().replace(' ', '_')];
            const currentValue = currentData[prop.toLowerCase().replace(' ', '_')];
            return previousValue !== currentValue;
        });
    }
    
    // Check if any changed property is relevant
    const hasRelevantChange = changedProperties.some(prop => 
        TRANSMISSION_CONFIG.relevantProperties.includes(prop)
    );
    
    console.log(`📊 Relevant changes check: ${hasRelevantChange ? '✅ RELEVANT' : '🚫 IRRELEVANT'}`);
    return hasRelevantChange;
}

// **NEW: Check if it's a page-related webhook**
function isPageWebhook(webhookType) {
    const pageWebhookTypes = [
        'page.created', 'page.updated', 'page.properties_updated',
        'page.content_updated', 'page.added_to_database', 'page.removed_from_database'
    ];
    
    return pageWebhookTypes.includes(webhookType);
}

async function processPageWebhook(webhookData) {
    console.log('🔍 Processing page webhook:', webhookData.type);
    
    // Extract page ID based on webhook type
    const pageId = extractPageId(webhookData);
    if (!pageId) {
        console.log('❌ Could not extract page ID from webhook');
        return;
    }

    console.log('📄 Page ID:', pageId);
    
    if (!shouldProcessWebhook(pageId, webhookData.type)) {
        return;
    }

    if (webhookData.type === 'page.content_updated') {
    // Content updates often come in batches, be more aggressive with filtering
    console.log('⚠️ Content update - applying aggressive filtering');
    }

    const page = await fetchPage(pageId);
    if (!page) {
        console.log('❌ Could not fetch page');
        return;
    }

    if (!page.parent || page.parent.type !== 'database_id') {
        console.log('🚫 Skipping page - not a database page');
        return;
    }

    if (!isTargetDatabase(page.parent.database_id)) {
    console.log('🚫 Skipping page - not in target database');
    return;
    }

    // **DEBUG: Check what getChangedProperties returns**
    const changedProps = getChangedProperties(webhookData);
    console.log('📊 getChangedProperties returned:', {
        type: typeof changedProps,
        value: changedProps,
        isArray: Array.isArray(changedProps)
    });

    // **DEBUG: Check parameter order**
    console.log('🔍 Calling hasRelevantChangesWithTracking with:', {
        pageId,
        webhookType: webhookData.type,
        changedProps
    });

    //if (webhookData.type === 'page.created') {
    //    console.log('⏳ Page creation detected, adding processing delay...');
    //    await new Promise(resolve => setTimeout(resolve, 1000));
    //}

    // Extract properties - handle different webhook structures
    const properties = await fetchPageProperties(pageId);
    if (!properties) {
        console.log('❌ Could not fetch page properties');
        return;
    }

    if (!shouldTransmitPage(properties)) {
    console.log(`🚫 Page transmission blocked by control property`);
    return;
    }

    console.log('📋 Available properties:', Object.keys(properties));
    
    // Extract data for Discord message
    const notionData = await extractNotionData(properties, pageId);
    console.log('📊 Extracted data:', notionData);

    // ✅ FIXED CALL:
    if (!hasRelevantChangesWithTracking({
        pageId: pageId,
        currentData: notionData,
        webhookType: webhookData.type,
        changedProperties: getChangedProperties(webhookData)
    })) {
        console.log(`🚫 No relevant changes, skipping Discord message for ${pageId}`);
        return;
    }

    // Send to Discord
    await sendToDiscord(pageId, notionData, webhookData.type);
}

function shouldProcessWebhook(pageId, webhookType) {
    const key = `${pageId}_${webhookType}`;
    
    // Simple check for same request (works within single function execution)
    if (processedPages.has(key)) {
        console.log(`🚫 Already processing ${webhookType} for ${pageId} in this request`);
        return false;
    }
    
    processedPages.add(key);
    return true;
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
    const jenis = extractSelectProperty(properties, ['Jenis', 'Category', 'Golongan']);
    const deadline = extractDateProperty(properties, ['Deadline', 'Due Date', 'Due']);
    const priority = extractSelectProperty(properties, ['Priority']);
    const pageContent = await extractPageContent(pageId);

    const extractedData = {
        title: title,
        content: pageContent,
        jenis: jenis,
        deadline: deadline,
        priority: priority
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
        let inList = false;
        
        // Process blocks with lookahead for list header detection
        for (let i = 0; i < blocks.length; i++) {
            if (contentLength >= maxLength) break;
            
            const currentBlock = blocks[i];
            const nextBlock = i + 1 < blocks.length ? blocks[i + 1] : null;
            
            const blockText = extractTextFromBlock(currentBlock, nextBlock, inList);
            
            if (blockText && contentLength + blockText.length <= maxLength) {
                // Check if we're starting/ending a list
                const isListItem = currentBlock.type === 'bulleted_list_item' || 
                                 currentBlock.type === 'numbered_list_item' || 
                                 currentBlock.type === 'to_do';
                
                if (isListItem && !inList) {
                    // Starting a list
                    inList = true;
                } else if (!isListItem && inList) {
                    // Ending a list - add extra space after last item
                    content += '\n';
                    inList = false;
                }
                
                content += blockText;
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
function extractTextFromBlock(block, nextBlock = null, inList = false) {
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
    // **IMPROVED: Only treat as list header if colon is at the VERY END**
    const trimmedText = text.trim();
    const isListHeader = trimmedText.endsWith(':') && 
                        !trimmedText.includes('\n') && // No internal newlines
                        nextBlock && 
                        (nextBlock.type === 'bulleted_list_item' || 
                         nextBlock.type === 'numbered_list_item' || 
                         nextBlock.type === 'to_do');

    switch (blockType) {
        case 'heading_1':
            return `# ${text}\n\n`;
        case 'heading_2':
            return `## ${text}\n\n`;
        case 'heading_3':
            return `### ${text}\n\n`;
        case 'bulleted_list_item':
            return `• ${text}\n`;
        case 'numbered_list_item':
            return `1. ${text}\n`;
        case 'to_do':
            const checked = blockData.checked ? '✅' : '☐';
            return `${checked} ${text}\n`;
        case 'paragraph':
            if (isListHeader) {
                return `${text}\n`; // Reduced spacing for list headers
            } else if (inList) {
                // If we're in a list and get a paragraph, it breaks the list
                return `\n${text}\n\n`; // Extra space to separate from list
            } else {
                return `${text}\n\n`; // Normal spacing
            }
        default:
            return `${text}\n\n`;
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

// **STORE MESSAGE ID IN NOTION**
async function storeMessageId(notionPageId, discordMessageId) {
    try {
        const notion = initializeNotionClient();
        
        await notion.pages.update({
            page_id: notionPageId,
            properties: {
                'Discord Message ID': {
                    type: 'rich_text',
                    rich_text: [
                        {
                            type: 'text',
                            text: { content: discordMessageId || '' }
                        }
                    ]
                }
            }
        });
        
        console.log(`💾 Stored Discord message ID ${discordMessageId} for page ${notionPageId}`);
        
    } catch (error) {
        console.error('❌ Error storing message ID:', error);
    }
}

// **RETRIEVE MESSAGE ID FROM NOTION**
async function getStoredMessageId(notionPageId) {
    try {
        const notion = initializeNotionClient();
        const page = await notion.pages.retrieve({ page_id: notionPageId });
        
        const messageIdProperty = page.properties['Discord Message ID'];
        if (messageIdProperty?.type === 'rich_text' && messageIdProperty.rich_text.length > 0) {
            return messageIdProperty.rich_text[0].plain_text;
        }
        
        return null;
        
    } catch (error) {
        console.error('❌ Error retrieving message ID:', error);
        return null;
    }
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
        
        // **CHECK BOTH SOURCES FOR MESSAGE ID**
        const storedMessageId = await getStoredMessageId(pageId);
        
        console.log('🔍 Message ID lookup:', { storedMessageId, fromNotion: notionData.discordMessageId });

        // **TRY TO UPDATE EXISTING MESSAGE**
        const messageId = storedMessageId || notionData.discordMessageId;
        
        if (messageId) {
            try {
                console.log('📝 Attempting to fetch message:', messageId);
                
                // **FIX: Proper message fetching with error handling**
                const message = await channel.messages.fetch(messageId);
                console.log('✅ Message fetched successfully:', { 
                    id: message.id, 
                    content: message.content.substring(0, 50) + '...',
                    hasEdit: typeof message.edit === 'function'
                });
                
                // **FIX: Verify the message object has edit method**
                if (typeof message.edit === 'function') {
                    const updatedMessage = await message.edit(messageContent);
                    console.log('✅ Message updated successfully! ID:', updatedMessage.id);
                    return;
                } else {
                    console.error('❌ Message object missing edit method:', message);
                    throw new Error('Message object does not have edit method');
                }
                
            } catch (error) {
                if (error.code === 10008) { // Unknown message (was deleted)
                    console.log('🗑️ Message was deleted, creating new one');
                    await storeMessageId(pageId, null);
                    // Fall through to create new message
                } else {
                    console.error('❌ Error updating message:', error);
                    // Fall through to create new message on error
                }
            }
        }
        
        // **CREATE NEW MESSAGE**
        console.log('📤 Creating new Discord message...');
        const message = await channel.send(messageContent);
        
        // **STORE THE NEW MESSAGE ID**
        await storeMessageId(pageId, message.id);
        console.log('✅ New message created and stored:', message.id);

    } catch (error) {
        console.error('❌ Error sending to Discord:', error);
    }
}

// **UPDATED: Format message content**
function formatMessageContent(notionData, webhookType) {
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
        ? notionData.content
            .split('\n')
            .map(line => line === '' ? '> ' : `> ${line}`)
            .join('\n')
        : 'No content available';
    
    return `
# **__----- :sparkles: ${notionData.title} (${jenisText}) :sparkles: -----__**

${formattedContent}

### **__----- :calendar_spiral:  Deadline ${deadlineText}  :calendar_spiral: -----__**
### **__----- ${isNew ? '🆕 *Tugas Baru* 🆕' : '✏️ *Tugas Update* ✏️'} -----__**
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