const path = require('node:path');
const { getAIConfig } = require('./ai-config');

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(part => typeof part === 'string' ? part : part.text || '').join('');
  return String(content ?? '');
}
function findMcpTool(tools, suffix) {
  const found = tools.find(item => item.name === suffix || item.name.endsWith(`_${suffix}`));
  if (!found) throw new Error(`The MCP connectors did not expose ${suffix}.`);
  return found;
}

async function buildOrchestrator() {
  const ai = getAIConfig();
  if (!ai.apiKey) throw new Error(ai.apiKeyName + ' is not configured. Add it to .env and restart Zaykaa.');
  const modelImport = ai.provider === 'google' ? import('@langchain/google/node') : import('@langchain/openai');
  const [{ StateGraph, StateSchema, MessagesValue, MemorySaver, START, END }, { createAgent }, modelPackage, { MCPAdapter }, { z }] = await Promise.all([
    import('@langchain/langgraph'), import('langchain'), modelImport, import('@langchain/mcp-adapters'), import('zod/v4'),
  ]);
  const RouteSchema = z.object({ route: z.enum(['faq', 'order', 'recommendation']) });
  const ChatState = new StateSchema({
    messages: MessagesValue,
    route: z.enum(['faq', 'order', 'recommendation']).optional(),
    reply: z.string().optional(),
  });
  const ChatModel = ai.provider === 'google' ? modelPackage.ChatGoogle : modelPackage.ChatOpenAI;
  const model = new ChatModel({ model: ai.chatModel, apiKey: ai.apiKey, temperature: 0 });
  const classifier = model.withStructuredOutput(RouteSchema);

  const mcpAdapter = new MCPAdapter({
    servers: {
      zaykaa_faq: { command: process.execPath, args: [path.join(__dirname, 'mcp-server.js'), 'faq'] },
      zaykaa_store: { command: process.execPath, args: [path.join(__dirname, 'mcp-server.js'), 'store'] },
    },
  });
  try {
    const mcpTools = await mcpAdapter.listTools();
    const faqTool = findMcpTool(mcpTools, 'search_help_centre');
    const orderTool = findMcpTool(mcpTools, 'lookup_order');
    const menuTool = findMcpTool(mcpTools, 'search_menu');

    const faqAgent = createAgent({
      model, tools: [faqTool],
      systemPrompt: 'You are Zaykaa’s FAQ specialist. Use the help centre MCP tool for factual answers. When the tool reports mode=hybrid, it combines embedding cosine similarity with BM25 keyword retrieval. During indexing it may report mode=bm25 and use keyword retrieval only. Answer clearly and warmly in a few sentences. If no matching FAQ is returned, say you do not have that detail and suggest contacting support. Do not invent policies.',
    });
    const orderAgent = createAgent({
      model, tools: [orderTool],
      systemPrompt: 'You are Zaykaa’s order support specialist. For order questions, inspect the actual record with the read-only MCP lookup tool. If the customer has not shared an order ID, ask for it. If no record is found, say so. Never make up status, ETA, items or totals.',
    });
    const recommendationAgent = createAgent({
      model, tools: [menuTool],
      systemPrompt: 'You are Zaykaa’s menu recommendation specialist. Search the menu with the MCP tool first, then suggest up to three relevant dishes with their actual prices. Use only returned menu data. If the menu has no exact match, explain that and offer the closest choices.',
    });

    const classify = async state => {
      const conversation = state.messages.slice(-8).map(message => `${message.getType() === 'human' ? 'Customer' : 'Assistant'}: ${textOf(message.content)}`).join('\n');
      const result = await classifier.invoke([
        { role: 'system', content: 'Route the latest customer turn to exactly one specialist. Use order for tracking or help with a specific placed order; recommendation for menu discovery, dishes, ingredients, dietary preferences or cravings; FAQ for store policies, delivery, payment and general support. If ambiguous, choose faq.' },
        { role: 'user', content: conversation },
      ]);
      return { route: result.route };
    };
    const runAgent = agent => async state => {
      const result = await agent.invoke({ messages: state.messages });
      const finalMessage = result.messages.at(-1);
      return { reply: textOf(finalMessage?.content), messages: [finalMessage] };
    };
    const graph = new StateGraph(ChatState)
      .addNode('classify', classify)
      .addNode('faq', runAgent(faqAgent))
      .addNode('order', runAgent(orderAgent))
      .addNode('recommendation', runAgent(recommendationAgent))
      .addEdge(START, 'classify')
      .addConditionalEdges('classify', state => state.route, { faq: 'faq', order: 'order', recommendation: 'recommendation' })
      .addEdge('faq', END)
      .addEdge('order', END)
      .addEdge('recommendation', END)
      .compile({ checkpointer: new MemorySaver() });
    return { graph, mcpAdapter };
  } catch (error) {
    await mcpAdapter.close();
    throw error;
  }
}
let orchestratorPromise;
function getOrchestrator() {
  if (!orchestratorPromise) orchestratorPromise = buildOrchestrator();
  return orchestratorPromise;
}
async function handleMessage(message, threadId) {
  const { graph } = await getOrchestrator();
  const result = await graph.invoke({ messages: [{ role: 'user', content: message }] }, { configurable: { thread_id: threadId } });
  return { text: result.reply, agent: `${result.route[0].toUpperCase()}${result.route.slice(1)} Agent`, route: result.route };
}
async function closeOrchestrator() {
  if (!orchestratorPromise) return;
  const running = orchestratorPromise;
  orchestratorPromise = undefined;
  try { const { mcpAdapter } = await running; await mcpAdapter.close(); }
  catch { /* connector setup may have failed before there was anything to close */ }
}
module.exports = { handleMessage, closeOrchestrator };

