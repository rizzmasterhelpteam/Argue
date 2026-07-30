import { supabase } from '../lib/supabase';

function requireClient() {
  if (!supabase) throw new Error('Supabase is not configured.');
  return supabase;
}

function throwOnError(error) {
  if (error) throw error;
}

export function messageForUi(message) {
  return {
    id: message.id,
    role: message.role,
    text: message.content,
    source: message.source,
    model: message.model,
    time: new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' }).format(new Date(message.created_at)),
  };
}

export function conversationForUi(conversation) {
  return {
    id: conversation.id,
    title: conversation.title,
    mode: conversation.mode === 'brainstorm' ? 'Brainstorm' : conversation.mode === 'roast' ? 'Roast' : 'Argue',
    date: new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(new Date(conversation.updated_at)),
    preview: conversation.messages?.[0]?.content || 'No messages yet.',
    count: conversation.message_count || conversation.messages?.length || 0,
  };
}

export async function listConversations() {
  const client = requireClient();
  const { data, error } = await client
    .from('conversations')
    .select('id,title,mode,updated_at,messages(content,created_at)')
    .eq('archived', false)
    .order('updated_at', { ascending: false })
    .limit(50);
  throwOnError(error);
  return (data || []).map((conversation) => conversationForUi({
    ...conversation,
    messages: [...(conversation.messages || [])].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at)),
  }));
}

export async function getMessages(conversationId) {
  const client = requireClient();
  const { data, error } = await client
    .from('messages')
    .select('id,role,source,content,model,created_at')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: true })
    .limit(100);
  throwOnError(error);
  return (data || []).map(messageForUi);
}

export async function createConversation(mode) {
  const client = requireClient();
  const { data: { user }, error: userError } = await client.auth.getUser();
  throwOnError(userError);
  if (!user || user.is_anonymous) throw new Error('Your session has expired. Please sign in again.');
  const normalizedMode = mode === 'Brainstorm' ? 'brainstorm' : mode === 'Roast' ? 'roast' : 'argue';
  const { data, error } = await client
    .from('conversations')
    .insert({ user_id: user.id, mode: normalizedMode, title: normalizedMode === 'brainstorm' ? 'New brainstorm' : normalizedMode === 'roast' ? 'New roast' : 'New argument' })
    .select('id,title,mode,updated_at')
    .single();
  throwOnError(error);
  return conversationForUi(data);
}

export async function renameConversation(id, title) {
  const { error } = await requireClient().from('conversations').update({ title: title.trim() }).eq('id', id);
  throwOnError(error);
}

export async function archiveConversation(id) {
  const { error } = await requireClient().from('conversations').update({ archived: true }).eq('id', id);
  throwOnError(error);
}

export async function deleteConversation(id) {
  const { error } = await requireClient().from('conversations').delete().eq('id', id);
  throwOnError(error);
}
