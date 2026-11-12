const form = document.querySelector('#chatForm');
const input = document.querySelector('#messageInput');
const messages = document.querySelector('#messages');
const welcome = document.querySelector('#welcome');
const send = document.querySelector('.send-button');
let threadId = sessionStorage.getItem('zaykaa-thread-id');
if (!threadId) {
  threadId = crypto.randomUUID();
  sessionStorage.setItem('zaykaa-thread-id', threadId);
}

function addMessage(text, role, extra = {}) {
  const row = document.createElement('div'); row.className = `message ${role}`;
  const avatar = document.createElement('div'); avatar.className = 'message-avatar'; avatar.textContent = role === 'user' ? 'N' : 'z';
  const content = document.createElement('div'); content.className = 'message-content';
  const meta = document.createElement('div'); meta.className = 'message-meta';
  meta.textContent = role === 'user' ? 'You · just now' : `Zaykaa assistant · ${extra.agent || 'ready'}`;
  const bubble = document.createElement('div'); bubble.className = 'bubble'; bubble.textContent = text;
  content.append(meta, bubble);
  if (role === 'assistant' && extra.agent) {
    const tag = document.createElement('div'); tag.className = 'agent-tag'; tag.textContent = `${extra.agent} · LangChain routed`; content.append(tag);
  }
  row.append(avatar, content); messages.append(row); messages.scrollTop = messages.scrollHeight;
}

async function ask(text) {
  const message = text.trim(); if (!message || send.disabled) return;
  welcome.hidden = true; addMessage(message, 'user'); input.value = ''; send.disabled = true;
  const typing = document.createElement('div'); typing.className = 'message'; typing.innerHTML = '<div class="message-avatar">z</div><div class="message-content"><div class="message-meta">Zaykaa assistant is thinking</div><div class="bubble typing"><i></i><i></i><i></i></div></div>'; messages.append(typing); messages.scrollTop = messages.scrollHeight;
  try {
    const response = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message, threadId }) });
    const result = await response.json(); typing.remove();
    addMessage(result.text || result.error || 'Something went wrong. Please try again.', 'assistant', result);
  } catch {
    typing.remove(); addMessage('I couldn’t reach the server. Please try again in a moment.', 'assistant');
  } finally { send.disabled = false; input.focus(); }
}
form.addEventListener('submit', event => { event.preventDefault(); ask(input.value); });
document.querySelectorAll('[data-prompt]').forEach(button => button.addEventListener('click', () => ask(button.dataset.prompt)));
document.querySelector('#orderShortcut').addEventListener('click', () => ask('Track order ZY-2048'));
