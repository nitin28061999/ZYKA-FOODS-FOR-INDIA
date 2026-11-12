const { searchFaq, lookupOrder, searchMenu } = require('./data-tools');

async function main() {
  const [{ McpServer }, { StdioServerTransport }, { z }] = await Promise.all([
    import('@modelcontextprotocol/server'),
    import('@modelcontextprotocol/server/stdio'),
    import('zod/v4'),
  ]);
  const serverName = process.argv[2];
  const server = new McpServer({ name: `zaykaa-${serverName || 'data'}`, version: '1.0.0' });

  if (serverName === 'faq') {
    server.registerTool('search_help_centre', {
      description: 'Search Zaykaa help centre using semantic embeddings and BM25 keyword relevance.',
      inputSchema: { question: z.string().describe('The customer question to search for') },
      annotations: { readOnlyHint: true, openWorldHint: false },
    }, async ({ question }) => ({
      content: [{ type: 'text', text: JSON.stringify(await searchFaq(question)) }],
    }));
  } else if (serverName === 'store') {
    server.registerTool('lookup_order', {
      description: 'Read an order status from the SQLite demo database using its ZY order ID.',
      inputSchema: { orderId: z.string().describe('The complete order ID, such as ZY-2048') },
      annotations: { readOnlyHint: true, openWorldHint: false },
    }, async ({ orderId }) => ({
      content: [{ type: 'text', text: JSON.stringify(lookupOrder(orderId)) }],
    }));
    server.registerTool('search_menu', {
      description: 'Search the available menu by dish, ingredient, diet, flavour or category.',
      inputSchema: { query: z.string().describe('Food preferences, ingredients, dietary needs or dish type') },
      annotations: { readOnlyHint: true, openWorldHint: false },
    }, async ({ query }) => ({
      content: [{ type: 'text', text: JSON.stringify(searchMenu(query)) }],
    }));
  } else {
    throw new Error('Choose the faq or store MCP connector.');
  }

  await server.connect(new StdioServerTransport());
}
main().catch(error => {
  console.error('Zaykaa MCP server failed:', error);
  process.exitCode = 1;
});

