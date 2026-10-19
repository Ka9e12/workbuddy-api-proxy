/**
 * Token estimation utilities
 * Based on Claude Code source - rough estimation for token counting
 */

/**
 * Estimate token count from string length using bytes-per-token ratio
 * @param {string} content - The content to estimate tokens for
 * @param {number} bytesPerToken - Bytes per token ratio (default: 4)
 * @returns {number} Estimated token count
 */
export function roughTokenCountEstimation(content, bytesPerToken = 4) {
    if (!content || typeof content !== 'string') {
        return 0;
    }
    // Rough estimation: character count / bytes per token
    return Math.round(content.length / bytesPerToken);
}

/**
 * Get bytes-per-token ratio for a given file type
 * JSON and structured data tend to have higher token density
 * @param {string} fileType - The file extension or type
 * @returns {number} Bytes per token ratio
 */
export function bytesPerTokenForFileType(fileType) {
    const lowerType = fileType?.toLowerCase() || '';

    // JSON has higher token density due to structure
    const jsonTypes = ['json', 'jsonl', 'geojson'];
    if (jsonTypes.some(t => lowerType === t || lowerType.endsWith('.' + t))) {
        return 2;
    }

    // Markdown and text have moderate density
    const textTypes = ['md', 'markdown', 'txt', 'text'];
    if (textTypes.some(t => lowerType === t || lowerType.endsWith('.' + t))) {
        return 3;
    }

    // Code files - varies by language
    const codeTypes = ['js', 'ts', 'jsx', 'tsx', 'py', 'java', 'go', 'rs', 'c', 'cpp', 'h', 'css', 'scss', 'html', 'xml', 'yaml', 'yml'];
    if (codeTypes.some(t => lowerType === t || lowerType.endsWith('.' + t))) {
        return 4;
    }

    // Default ratio
    return 4;
}

/**
 * Estimate tokens for a content block
 * @param {Object} block - Content block with type and data
 * @returns {number} Estimated token count
 */
export function estimateContentBlockTokens(block) {
    if (!block || typeof block !== 'object') {
        return 0;
    }

    switch (block.type) {
        case 'text': {
            // Text blocks: estimate from text content
            const text = block.text || '';
            return roughTokenCountEstimation(text, 4);
        }

        case 'image': {
            // Image blocks: fixed cost for image token estimation
            // Claude uses approximately 85-1105 tokens per image depending on size
            // Using a reasonable middle-ground estimate
            if (block.source?.data) {
                // For base64 images, use a fixed estimate
                return 2000;
            }
            // For URL images, lower fixed cost
            return 1000;
        }

        case 'tool_use': {
            // Tool use blocks: estimate from name and input
            let tokens = 0;
            // Tool name overhead
            tokens += roughTokenCountEstimation(block.name || '', 4);
            // Tool input (usually JSON)
            const inputStr = typeof block.input === 'string'
                ? block.input
                : JSON.stringify(block.input || {});
            tokens += roughTokenCountEstimation(inputStr, 2); // JSON-like structure
            // Add overhead for tool formatting
            tokens += 10;
            return tokens;
        }

        case 'tool_result': {
            // Tool result blocks: estimate from content
            const content = block.content || '';
            if (typeof content === 'string') {
                return roughTokenCountEstimation(content, 4);
            }
            // If content is an array of blocks, estimate each
            if (Array.isArray(content)) {
                return content.reduce((sum, c) => {
                    if (typeof c === 'string') {
                        return sum + roughTokenCountEstimation(c, 4);
                    }
                    if (typeof c === 'object') {
                        return sum + estimateContentBlockTokens(c);
                    }
                    return sum;
                }, 0);
            }
            return 0;
        }

        case 'document': {
            // Document blocks for PDFs and other files
            // Use a fixed estimate based on document type
            if (block.source?.media_type === 'application/pdf') {
                return 5000; // PDFs are expensive
            }
            // For other documents, estimate from content length if available
            if (block.source?.data) {
                return roughTokenCountEstimation(block.source.data, 4);
            }
            return 2000;
        }

        default: {
            // Unknown block types: stringify and estimate
            try {
                const str = JSON.stringify(block);
                return roughTokenCountEstimation(str, 4);
            } catch {
                return 100; // Fallback estimate
            }
        }
    }
}

/**
 * Estimate total tokens for a list of messages
 * @param {Array} messages - Array of message objects with role and content
 * @returns {number} Estimated total token count
 */
export function estimateMessageTokens(messages) {
    if (!Array.isArray(messages)) {
        return 0;
    }

    let totalTokens = 0;

    for (const message of messages) {
        if (!message || typeof message !== 'object') {
            continue;
        }

        // Add tokens for role
        totalTokens += 1; // Role token overhead

        // Handle different content formats
        const content = message.content;

        if (typeof content === 'string') {
            // Simple string content
            totalTokens += roughTokenCountEstimation(content, 4);
        } else if (Array.isArray(content)) {
            // Array of content blocks
            for (const block of content) {
                if (typeof block === 'string') {
                    totalTokens += roughTokenCountEstimation(block, 4);
                } else if (typeof block === 'object') {
                    totalTokens += estimateContentBlockTokens(block);
                }
            }
        } else if (typeof content === 'object' && content !== null) {
            // Single object content
            totalTokens += estimateContentBlockTokens(content);
        }

        // Add overhead for message formatting
        totalTokens += 4; // Message overhead (role markers, etc.)

        // Handle tool calls in message
        if (message.tool_calls) {
            for (const toolCall of message.tool_calls) {
                totalTokens += estimateContentBlockTokens({
                    type: 'tool_use',
                    name: toolCall.function?.name,
                    input: toolCall.function?.arguments
                });
            }
        }
    }

    // Add conversation overhead
    totalTokens += 3; // Conversation start/end markers

    return totalTokens;
}

/**
 * Estimate tokens for a file based on its content and type
 * @param {string} content - File content
 * @param {string} fileType - File extension or type
 * @returns {number} Estimated token count
 */
export function estimateFileTokens(content, fileType) {
    if (!content || typeof content !== 'string') {
        return 0;
    }
    const ratio = bytesPerTokenForFileType(fileType);
    return roughTokenCountEstimation(content, ratio);
}