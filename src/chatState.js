export function uniqueMessages(messages) {
  return [...new Map(messages.map((message) => [message.id, message])).values()].sort(
    (a, b) => new Date(a.createdAt) - new Date(b.createdAt),
  );
}

export function uniqueChats(chats) {
  return [...new Map(chats.map((chat) => [chat.id, chat])).values()].sort((a, b) => {
    const left = Date.parse(a.lastMessageAt ?? a.messages?.at(-1)?.createdAt ?? 0);
    const right = Date.parse(b.lastMessageAt ?? b.messages?.at(-1)?.createdAt ?? 0);
    return right - left;
  });
}

export function filterChats(chats, query) {
  const q = query.trim().toLowerCase();
  if (!q) return chats;
  return chats.filter((chat) =>
    [chat.name, chat.handle, chat.status, chat.lastMessage, chat.messages?.at(-1)?.text]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(q)),
  );
}

export function isPendingLocalMessage(message) {
  return String(message?.id ?? '').startsWith('pending-') || Boolean(message?.uploadStatus);
}

export function isDraftConversationId(conversationId) {
  return String(conversationId ?? '').startsWith('draft-private-');
}

export function hasDeliveredMessages(chat) {
  return (chat.messages ?? []).some((message) => !isPendingLocalMessage(message));
}

export function isPrivateChatDraft(chat) {
  if (!chat || chat.kind !== 'private') return false;
  if (isDraftConversationId(chat.id)) return true;
  const messages = chat.messages ?? [];
  if (hasDeliveredMessages(chat)) return false;
  if (messages.length > 0) return true;
  return !chat.lastMessageAt;
}

export function listableChats(chats) {
  return chats.filter((chat) => !isPrivateChatDraft(chat));
}

export function updateChatWithMessage(chat, message) {
  return {
    ...chat,
    lastMessage: message.text,
    lastMessageAt: message.createdAt,
    messages: uniqueMessages([...(chat.messages ?? []), message]),
  };
}

export function updateChatMessage(chat, message) {
  return {
    ...chat,
    lastMessage: message.text,
    messages: uniqueMessages((chat.messages ?? []).map((item) => (item.id === message.id ? message : item))),
  };
}

export function removeChatMessage(chat, messageId) {
  return {
    ...chat,
    messages: (chat.messages ?? []).filter((message) => message.id !== messageId),
  };
}
