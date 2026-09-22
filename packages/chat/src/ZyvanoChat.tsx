import { useEffect, useMemo, useRef, useState } from "react";

export type ZyvanoChatProps = {
  apiBaseUrl: string;
  accessToken: string;
  currentUserZyvanoId?: string;
};

type Conversation = {
  id: string;
  other_user: { id: string; zyvano_id: string; name?: string | null };
  last_message?: Message | null;
  updated_at: string;
};

type Message = {
  id: string;
  conversation_id: string;
  sender_id: string;
  body?: string | null;
  created_at: string;
  read_at?: string | null;
  attachment?: {
    id: string;
    name: string;
    mime_type: string;
    size_bytes: number;
  } | null;
};

const authHeaders = (token: string) => ({
  Authorization: `Bearer ${token}`,
  "Content-Type": "application/json",
});

export function ZyvanoChat({
  apiBaseUrl,
  accessToken,
  currentUserZyvanoId,
}: ZyvanoChatProps) {
  const base = apiBaseUrl.replace(/\/$/, "");
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [active, setActive] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [text, setText] = useState("");
  const [lookupId, setLookupId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const socketRef = useRef<WebSocket | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const loadConversations = async () => {
    const response = await fetch(`${base}/api/v1/chat/conversations`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) throw new Error("Unable to load conversations");
    setConversations(await response.json());
  };

  const loadMessages = async (conversationId: string) => {
    const response = await fetch(
      `${base}/api/v1/chat/conversations/${conversationId}/messages`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    if (!response.ok) throw new Error("Unable to load messages");
    setMessages(await response.json());
  };

  const openConversation = async (conversation: Conversation) => {
    setActive(conversation);
    await loadMessages(conversation.id);
    await fetch(
      `${base}/api/v1/chat/conversations/${conversation.id}/read`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}` },
      },
    );
  };

  useEffect(() => {
    loadConversations().catch((e: unknown) =>
      setError(e instanceof Error ? e.message : "Unable to load conversations"),
    );
    return () => socketRef.current?.close();
  }, [accessToken, base]);

  useEffect(() => {
    socketRef.current?.close();
    if (!active) return;

    const protocol = base.startsWith("https") ? "wss" : "ws";
    const host = base.replace(/^https?:\/\//, "");
    const socket = new WebSocket(
      `${protocol}://${host}/api/v1/chat/ws/${active.id}?token=${encodeURIComponent(accessToken)}`,
    );

    socket.onmessage = (event) => {
      const message = JSON.parse(event.data) as Message;
      setMessages((current) =>
        current.some((item) => item.id === message.id)
          ? current
          : [...current, message],
      );
    };
    socket.onerror = () =>
      setError("Live chat connection failed; messages can still be sent.");
    socketRef.current = socket;

    return () => socket.close();
  }, [active?.id, accessToken, base]);

  const send = async (body: string, attachmentId?: string) => {
    if (!active || (!body.trim() && !attachmentId)) return;

    const response = await fetch(
      `${base}/api/v1/chat/conversations/${active.id}/messages`,
      {
        method: "POST",
        headers: authHeaders(accessToken),
        body: JSON.stringify({
          body: body.trim() || null,
          attachment_id: attachmentId ?? null,
        }),
      },
    );
    if (!response.ok) throw new Error("Message could not be sent");

    const message = (await response.json()) as Message;
    setMessages((current) =>
      current.some((item) => item.id === message.id)
        ? current
        : [...current, message],
    );
    setText("");
  };

  const startChat = async () => {
    setError(null);
    const response = await fetch(`${base}/api/v1/chat/conversations`, {
      method: "POST",
      headers: authHeaders(accessToken),
      body: JSON.stringify({ zyvano_id: lookupId.trim() }),
    });

    if (!response.ok) {
      setError("Zyvano ID not found");
      return;
    }

    const data = await response.json();
    await loadConversations();
    const conversation = {
      id: data.id,
      other_user: data.other_user,
      updated_at: new Date().toISOString(),
    } as Conversation;

    setLookupId("");
    await openConversation(conversation);
  };

  const uploadAndSend = async (file: File) => {
    if (!active) return;

    setLoading(true);
    try {
      const form = new FormData();
      form.append("file", file);
      const response = await fetch(
        `${base}/api/v1/chat/conversations/${active.id}/attachments`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${accessToken}` },
          body: form,
        },
      );
      if (!response.ok) throw new Error("File upload failed");

      const attachment = (await response.json()) as { id: string };
      await send("", attachment.id);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "File upload failed");
    } finally {
      setLoading(false);
    }
  };

  const title = useMemo(
    () => active?.other_user.name || active?.other_user.zyvano_id || "Select a chat",
    [active],
  );

  return (
    <section className="zyvano-chat">
      <aside className="zyvano-chat__sidebar">
        <div className="zyvano-chat__identity">
          {currentUserZyvanoId
            ? `Your ID: ${currentUserZyvanoId}`
            : "Zyvano Chat"}
        </div>

        <div className="zyvano-chat__new">
          <input
            value={lookupId}
            onChange={(event) => setLookupId(event.target.value)}
            placeholder="Enter Zyvano ID"
            onKeyDown={(event) => {
              if (event.key === "Enter") void startChat();
            }}
          />
          <button onClick={() => void startChat()}>Chat</button>
        </div>

        {conversations.map((conversation) => (
          <button
            key={conversation.id}
            className={`zyvano-chat__conversation ${active?.id === conversation.id ? "is-active" : ""}`}
            onClick={() => void openConversation(conversation)}
          >
            <strong>
              {conversation.other_user.name || conversation.other_user.zyvano_id}
            </strong>
            <span>{conversation.other_user.zyvano_id}</span>
          </button>
        ))}
      </aside>

      <main className="zyvano-chat__main">
        <header>
          <strong>{title}</strong>
          {active && <span>{active.other_user.zyvano_id}</span>}
        </header>

        <div className="zyvano-chat__messages">
          {messages.map((message) => (
            <article
              key={message.id}
              className={
                message.sender_id === active?.other_user.id
                  ? "incoming"
                  : "outgoing"
              }
            >
              {message.body && <div>{message.body}</div>}
              {message.attachment && (
                <button
                  className="zyvano-chat__file"
                  onClick={async () => {
                    const response = await fetch(
                      `${base}/api/v1/chat/attachments/${message.attachment!.id}/url`,
                      {
                        headers: {
                          Authorization: `Bearer ${accessToken}`,
                        },
                      },
                    );
                    const data = await response.json();
                    window.open(data.url, "_blank", "noopener,noreferrer");
                  }}
                >
                  📎 {message.attachment.name}
                </button>
              )}
              <small>{new Date(message.created_at).toLocaleString()}</small>
            </article>
          ))}
        </div>

        <footer>
          <input
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder={
              active ? "Write a message…" : "Choose a conversation"
            }
            disabled={!active}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void send(text).catch((e: unknown) =>
                  setError(e instanceof Error ? e.message : "Send failed"),
                );
              }
            }}
          />
          <input
            ref={fileInputRef}
            type="file"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void uploadAndSend(file);
            }}
          />
          <button
            disabled={!active || loading}
            onClick={() => fileInputRef.current?.click()}
          >
            Attach
          </button>
          <button
            disabled={!active || !text.trim()}
            onClick={() =>
              void send(text).catch((e: unknown) =>
                setError(e instanceof Error ? e.message : "Send failed"),
              )
            }
          >
            Send
          </button>
        </footer>

        {error && <div className="zyvano-chat__error">{error}</div>}
      </main>
    </section>
  );
}
