import React, { useEffect, useMemo, useRef, useState } from "react";

import {
  Bot,
  Calculator,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Code2,
  Copy,
  FileText,
  Menu,
  MessageSquare,
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
  Send,
  Sparkles,
  Trash2,
  X,
  UserRound,
  Settings2,
  LogOut,
  ShieldCheck,
  Save,
  PlusCircle,
  ArrowLeft,
} from "lucide-react";

import { createRoot } from "react-dom/client";

import "./styles.css";

const API = "http://127.0.0.1:8000";

const HISTORY_KEY = "atlas-agentic-rag-history-v4";

const ACTIVE_CHAT_KEY = "atlas-agentic-rag-active-chat-v2";

const NEW_CHAT_STATE = "__new_chat__";

const examples = [
  "What are the 6 pillars of the AWS Well-Architected Framework, and which pillar covers incident response?",

  "Look up the asyncio.TaskGroup class in the Python reference documentation and write a minimal code example showing two tasks concurrently.",

  "Using NIST SP 800-145, define the essential characteristics of cloud computing and state if on-demand self-service requires human interaction.",

  "Calculate (1250 \* 0.18) + 47.5.",
];

const toolMeta = {
  vector_search: { label: "RAG Search", icon: Search, className: "rag" },

  calculator: { label: "Calculator", icon: Calculator, className: "calc" },

  python: {
    label: "Python Interpreter Tool",

    icon: Code2,

    className: "python",
  },

  direct: { label: "Direct Answer", icon: Bot, className: "direct" },
};

function makeId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function loadHistory(historyKey = HISTORY_KEY) {
  try {
    const value = JSON.parse(localStorage.getItem(historyKey) || "[]");

    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function titleFrom(text) {
  const clean = text.replace(/\s+/g, " ").trim();

  return clean.length > 48 ? `${clean.slice(0, 48)}…` : clean || "New chat";
}

function ChatApp({
  user,
  onPromptsClick,
  profileOpen,
  onProfileToggle,
  onLogout,
}) {
  // Keep browser history separate for each signed-in account.
  const accountKey = String(user?.username || "guest")
    .trim()
    .toLowerCase();
  const historyKey = `${HISTORY_KEY}:${accountKey}`;
  const activeChatKey = `${ACTIVE_CHAT_KEY}:${accountKey}`;
  const [history, setHistory] = useState(() => loadHistory(historyKey));

  const [activeId, setActiveId] = useState(() => {
    try {
      const saved = localStorage.getItem(activeChatKey);

      if (saved === NEW_CHAT_STATE) return null;

      if (saved) return saved;

      // First-ever load: preserve the previous default behavior and open

      // the first saved conversation. Once New Chat is clicked, the explicit

      // NEW_CHAT_STATE value prevents this fallback on refresh.

      const existingHistory = loadHistory();

      return existingHistory[0]?.id || null;
    } catch {
      return null;
    }
  });

  const [input, setInput] = useState("");

  const [busy, setBusy] = useState(false);

  const [workingLabel, setWorkingLabel] = useState(
    "Agent is deciding which tool to use...",
  );

  const [sidebarOpen, setSidebarOpen] = useState(true);

  const [menuId, setMenuId] = useState(null);

  const [renamingId, setRenamingId] = useState(null);

  const [renameValue, setRenameValue] = useState("");

  const chatRef = useRef(null);

  const activeChat = useMemo(
    () => history.find((chat) => chat.id === activeId) || null,

    [history, activeId],
  );

  const messages = activeChat?.messages || [];

  useEffect(() => {
    localStorage.setItem(historyKey, JSON.stringify(history));
  }, [history, historyKey]);

  // Persist which conversation is open, including the explicit New Chat state.

  // This prevents a refresh from automatically reopening the previous chat.

  useEffect(() => {
    try {
      localStorage.setItem(activeChatKey, activeId || NEW_CHAT_STATE);
    } catch {
      // Ignore storage errors (for example, private browsing restrictions).
    }
  }, [activeId, activeChatKey]);

  // If a previously selected chat was removed outside this component, recover

  // gracefully. Do not select the first chat when the persisted state is New Chat.

  useEffect(() => {
    if (!activeId) return;

    const exists = history.some((chat) => chat.id === activeId);

    if (!exists) {
      setActiveId(null);
    }
  }, [history, activeId]);

  useEffect(() => {
    const el = chatRef.current;

    if (!el) return;

    // A new/empty chat must always start at the top of the landing page.

    // Existing conversations continue to auto-scroll to the newest message.

    if (messages.length === 0) {
      el.scrollTop = 0;
    } else {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages.length, busy, activeId]);

  const createChat = () => {
    // IMPORTANT: activeId=null is the explicit New Chat state.

    // We intentionally do not create an empty chat object in history.

    // A chat is created only when the user sends the first message.

    setActiveId(null);

    setInput("");

    setBusy(false);

    setMenuId(null);

    setRenamingId(null);

    // Cancel any pending browser scroll and force the empty/new-chat

    // landing view to the top.

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (chatRef.current) {
          chatRef.current.scrollTo({ top: 0, left: 0, behavior: "auto" });
        }
      });
    });

    if (window.innerWidth < 900) setSidebarOpen(false);
  };

  const updateActiveMessages = (nextMessages) => {
    if (!activeId) return;

    setHistory((prev) =>
      prev.map((chat) =>
        chat.id === activeId
          ? { ...chat, messages: nextMessages, updatedAt: Date.now() }
          : chat,
      ),
    );
  };

  const send = async (text = input) => {
    text = text.trim();

    if (!text || busy) return;

    let chatId = activeId;

    let baseMessages = messages;

    if (!chatId) {
      chatId = makeId();

      baseMessages = [];

      const newChat = {
        id: chatId,

        title: titleFrom(text),

        messages: [],

        createdAt: Date.now(),

        updatedAt: Date.now(),
      };

      setHistory((prev) => [newChat, ...prev]);

      setActiveId(chatId);

      try {
        localStorage.setItem(activeChatKey, chatId);
      } catch {}
    } else if (messages.length === 0) {
      setHistory((prev) =>
        prev.map((chat) =>
          chat.id === chatId
            ? { ...chat, title: titleFrom(text), updatedAt: Date.now() }
            : chat,
        ),
      );
    }

    const userMessage = { role: "user", content: text, id: makeId() };

    const nextMessages = [...baseMessages, userMessage];

    setHistory((prev) =>
      prev.map((chat) =>
        chat.id === chatId
          ? { ...chat, messages: nextMessages, updatedAt: Date.now() }
          : chat,
      ),
    );

    setInput("");

    setWorkingLabel("Agent is deciding which tool to use...");
    setBusy(true);

    setMenuId(null);

    const apiHistory = baseMessages.map((m) => ({
      role: m.role,

      content: m.content || m.answer || "",
    }));

    try {
      const routeResponse = await fetch(`${API}/api/route`, {
        method: "POST",

        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${localStorage.getItem("atlas_access_token") || ""}`,
        },

        body: JSON.stringify({ message: text, history: apiHistory }),
      });

      const plan = await routeResponse.json();

      if (!routeResponse.ok) throw new Error(plan.detail || "Routing failed");

      const selectedTool = plan.tool;

      const selectedLabel =
        plan.tool_label ||
        toolMeta[selectedTool]?.label ||
        selectedTool ||
        "Direct Answer";

      setWorkingLabel(`Using ${selectedLabel}...`);

      const response = await fetch(`${API}/api/chat`, {
        method: "POST",

        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${localStorage.getItem("atlas_access_token") || ""}`,
        },

        body: JSON.stringify({
          message: text,

          history: apiHistory,

          selected_tool: plan.tool,
        }),
      });

      const data = await response.json();

      if (!response.ok) throw new Error(data.detail || "Request failed");

      const assistantMessage = { role: "assistant", ...data, id: makeId() };

      setHistory((prev) =>
        prev.map((chat) =>
          chat.id === chatId
            ? {
                ...chat,

                messages: [...chat.messages, assistantMessage],

                updatedAt: Date.now(),
              }
            : chat,
        ),
      );
    } catch (error) {
      const errorMessage = {
        role: "assistant",

        content: `Something went wrong: ${error.message}`,

        tool: "direct",

        tool_label: "Direct Answer",

        citations: [],

        steps: [],

        id: makeId(),
      };

      setHistory((prev) =>
        prev.map((chat) =>
          chat.id === chatId
            ? {
                ...chat,

                messages: [...chat.messages, errorMessage],

                updatedAt: Date.now(),
              }
            : chat,
        ),
      );
    } finally {
      setBusy(false);
    }
  };

  const deleteChat = (id) => {
    setHistory((prev) => prev.filter((chat) => chat.id !== id));

    setMenuId(null);

    if (activeId === id) {
      const remaining = history.filter((chat) => chat.id !== id);

      const nextId = remaining[0]?.id || null;

      setActiveId(nextId);

      try {
        localStorage.setItem(activeChatKey, nextId || NEW_CHAT_STATE);
      } catch {}
    }
  };

  const clearAll = () => {
    if (!history.length) return;

    if (!window.confirm("Clear all chat history? This cannot be undone."))
      return;

    setHistory([]);

    setActiveId(null);

    try {
      localStorage.setItem(activeChatKey, NEW_CHAT_STATE);
    } catch {}

    setMenuId(null);
  };

  const startRename = (chat) => {
    setRenamingId(chat.id);

    setRenameValue(chat.title);

    setMenuId(null);
  };

  const saveRename = () => {
    if (!renamingId) return;

    const value = renameValue.trim();

    if (value) {
      setHistory((prev) =>
        prev.map((chat) =>
          chat.id === renamingId
            ? { ...chat, title: value, updatedAt: Date.now() }
            : chat,
        ),
      );
    }

    setRenamingId(null);
  };

  return (
    <div className="app-shell">
      <aside className={`sidebar ${sidebarOpen ? "open" : "closed"}`}>
        <div className="sidebar-header">
          <div className="brand">
            <div className="brandmark">
              <Sparkles size={19} />
            </div>

            <div>
              <strong>Atlas</strong>

              <span>Agentic RAG</span>
            </div>
          </div>

          <button
            className="mobile-close"
            onClick={() => setSidebarOpen(false)}
            aria-label="Close sidebar"
          >
            <X size={18} />
          </button>
        </div>

        <button className="new-chat" onClick={createChat}>
          <Plus size={17} />

          <span>New chat</span>

          <kbd>Ctrl K</kbd>
        </button>

        <div className="history-area">
          <div className="section-heading">
            <span>Chat history</span>

            <span className="history-count">{history.length}</span>
          </div>

          <div className="history-list">
            {history.length === 0 ? (
              <div className="history-empty">
                <MessageSquare size={19} />

                <p>No conversations yet.</p>

                <span>Your chats will appear here.</span>
              </div>
            ) : (
              history.map((chat) => (
                <div
                  key={chat.id}
                  className={`history-item ${chat.id === activeId ? "active" : ""}`}
                  onClick={() => {
                    setActiveId(chat.id);

                    try {
                      localStorage.setItem(activeChatKey, chat.id);
                    } catch {}

                    setMenuId(null);

                    if (window.innerWidth < 900) setSidebarOpen(false);
                  }}
                >
                  <MessageSquare size={16} />

                  {renamingId === chat.id ? (
                    <input
                      autoFocus
                      className="rename-input"
                      value={renameValue}
                      onChange={(e) => setRenameValue(e.target.value)}
                      onClick={(e) => e.stopPropagation()}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") saveRename();

                        if (e.key === "Escape") setRenamingId(null);
                      }}
                      onBlur={saveRename}
                    />
                  ) : (
                    <span className="history-title">{chat.title}</span>
                  )}

                  <button
                    className="history-menu"
                    onClick={(e) => {
                      e.stopPropagation();

                      setMenuId(menuId === chat.id ? null : chat.id);
                    }}
                    aria-label="Chat options"
                  >
                    <MoreHorizontal size={16} />
                  </button>

                  {menuId === chat.id && (
                    <div
                      className="chat-menu"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <button onClick={() => startRename(chat)}>
                        <Pencil size={14} /> Rename
                      </button>

                      <button
                        className="danger"
                        onClick={() => deleteChat(chat.id)}
                      >
                        <Trash2 size={14} /> Delete
                      </button>
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        </div>

        <div className="sidebar-footer">
          <button
            className="clear-history"
            onClick={clearAll}
            disabled={!history.length}
          >
            <Trash2 size={15} />

            <span>Clear all history</span>
          </button>

          <div className="sidebar-note">
            Your conversations are saved locally in this browser.
          </div>
        </div>
      </aside>

      {sidebarOpen && (
        <div className="mobile-overlay" onClick={() => setSidebarOpen(false)} />
      )}

      <main className="main-panel">
        <header className="topbar">
          <button
            className="icon-button"
            onClick={() => setSidebarOpen(!sidebarOpen)}
            aria-label="Toggle sidebar"
          >
            {sidebarOpen ? <ChevronLeft size={20} /> : <Menu size={20} />}
          </button>

          <div className="top-title">
            <span className="online-dot" />
            <span>Technical Assistant</span>
          </div>

          <div className="topbar-actions">
            <button className="top-nav-btn" onClick={onPromptsClick}>
              <Settings2 size={17} /> Prompts
            </button>
            <div className="profile-wrap">
              <button className="profile-trigger" onClick={onProfileToggle}>
                <span className="profile-avatar">
                  <UserRound size={17} />
                </span>
                <span className="profile-label">
                  {user.display_name || user.username}
                </span>
                <ChevronDown size={15} />
              </button>
              {profileOpen && (
                <div className="profile-dropdown">
                  <div className="profile-detail">
                    <strong>{user.display_name || user.username}</strong>
                    <span>{user.username}</span>
                    <small>Role: {user.role_name || user.role_code}</small>
                  </div>
                  <button onClick={onLogout}>
                    <LogOut size={15} /> Logout
                  </button>
                </div>
              )}
            </div>
          </div>
        </header>

        <section className="chat-scroll" ref={chatRef}>
          {messages.length === 0 ? (
            <LandingPage onExample={send} />
          ) : (
            <div className="conversation">
              {messages.map((message) => (
                <Message
                  key={message.id || `${message.role}-${Math.random()}`}
                  message={message}
                />
              ))}

              {busy && <WorkingIndicator label={workingLabel} />}
            </div>
          )}
        </section>

        <div className="composer-area">
          <div className="composer">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();

                  send();
                }
              }}
              placeholder="Ask about Python, AWS, NIST, or calculate something..."
              rows="1"
              disabled={busy}
            />

            <button
              className="send-button"
              disabled={busy || !input.trim()}
              onClick={() => send()}
              aria-label="Send message"
            >
              <Send size={17} />
            </button>
          </div>

          <div className="composer-hint">
            Enter to send · Shift + Enter for a new line · Agent routing happens
            automatically
          </div>
        </div>
      </main>
    </div>
  );
}

function LandingPage({ onExample }) {
  return (
    <div className="landing">
      <div className="landing-glow glow-one" />

      <div className="landing-glow glow-two" />

      <div className="hero-logo">
        <Sparkles size={27} />
      </div>

      <div className="eyebrow">AGENTIC RAG · MULTI-TOOL ASSISTANT</div>

      <h1>
        Intelligent answers,
        <br />
        <span>grounded in your documents.</span>
      </h1>

      <p className="hero-copy">
        Atlas routes every request to the right tool — RAG Search, Python
        Interpreter, Calculator, or Direct Answer — then presents the result
        with clear sources.
      </p>

      <div className="tool-strip">
        <ToolMini icon={<Search size={15} />} label="RAG Search" color="blue" />

        <ToolMini
          icon={<Code2 size={15} />}
          label="Python Interpreter"
          color="green"
        />

        <ToolMini
          icon={<Calculator size={15} />}
          label="Calculator"
          color="purple"
        />

        <ToolMini icon={<Bot size={15} />} label="Direct Answer" color="gray" />
      </div>

      <div className="example-heading">Try an example</div>

      <div className="example-grid">
        {examples.map((example, index) => (
          <button
            className="example-card"
            key={index}
            onClick={() => onExample(example)}
          >
            <span>{example}</span>

            <ChevronRight size={16} />
          </button>
        ))}
      </div>
    </div>
  );
}

function ToolMini({ icon, label, color }) {
  return (
    <div className={`tool-mini ${color}`}>
      {icon}

      <span>{label}</span>
    </div>
  );
}

function WorkingIndicator({ label }) {
  return (
    <div className="working-row">
      <div className="assistant-avatar working-avatar">
        <Bot size={16} />
      </div>

      <div className="working-card">
        <div className="working-dots">
          <i />

          <i />

          <i />
        </div>

        <span>{label}</span>
      </div>
    </div>
  );
}

function Message({ message }) {
  if (message.role === "user") {
    return (
      <div className="message-row user-message-row">
        <div className="user-bubble">{message.content}</div>
      </div>
    );
  }

  const meta = toolMeta[message.tool] || toolMeta.direct;

  const Icon = meta.icon;

  const answer = message.answer || message.content || "";

  return (
    <div className="message-row assistant-row">
      <div className="assistant-avatar">
        <Bot size={17} />
      </div>

      <div className="assistant-content">
        <div className={`tool-chip ${meta.className}`}>
          <Icon size={14} />

          <span>{message.tool_label || meta.label}</span>

          <span className="tool-check">
            <Check size={11} />
          </span>
        </div>

        <div className="route-line">
          <span className="route-agent">Agent</span>

          <span>→</span>

          <strong>{message.tool_label || meta.label}</strong>

          <span>→</span>

          <span>Answer</span>
        </div>

        {message.steps?.map((step, index) => (
          <div className="step" key={index}>
            ✓ {step}
          </div>
        ))}

        <div className="answer-card">
          <RichAnswer text={answer} />

          <div className="answer-actions">
            <CopyButton text={answer} />
          </div>
        </div>

        {message.citations?.length > 0 && (
          <div className="citations">
            <div className="citations-title">
              <FileText size={13} /> Sources
            </div>

            <div className="citation-list">
              {message.citations.map((citation, index) => (
                <div
                  className="citation"
                  key={`${citation.document}-${citation.page}-${index}`}
                >
                  <FileText size={13} />

                  <span>{citation.document}</span>

                  <b>p. {citation.page}</b>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function CopyButton({ text }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);

      setCopied(true);

      setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };

  return (
    <button className="copy-answer" onClick={copy} title="Copy answer">
      {copied ? <Check size={14} /> : <Copy size={14} />}

      <span>{copied ? "Copied" : "Copy"}</span>
    </button>
  );
}

function RichAnswer({ text }) {
  const parts = text.split(/(```[\s\S]\\\*?```)/g);

  return (
    <div className="rich-answer">
      {parts.map((part, index) => {
        if (!part.startsWith("```")) {
          return <TextBlock key={index} text={part} />;
        }

        const lines = part

          .replace(/^```/, "")

          .replace(/```$/, "")

          .replace(/^\n/, "")

          .split("\n");

        const language = lines[0]?.trim() || "code";

        const code = lines.slice(1).join("\n");

        return <CodeBlock key={index} language={language} code={code} />;
      })}
    </div>
  );
}

function TextBlock({ text }) {
  if (!text.trim()) return null;

  const lines = text.split("\n");

  return (
    <div className="text-block">
      {lines.map((line, index) => {
        const trimmed = line.trim();

        if (trimmed.startsWith("### "))
          return <h4 key={index}>{trimmed.slice(4)}</h4>;

        if (trimmed.startsWith("## "))
          return <h3 key={index}>{trimmed.slice(3)}</h3>;

        if (trimmed.startsWith("# "))
          return <h2 key={index}>{trimmed.slice(2)}</h2>;

        if (/^[-\\\*]\s+/.test(trimmed))
          return (
            <div className="answer-list" key={index}>
              <span>•</span>

              {trimmed.replace(/^[-\\\*]\s+/, "")}
            </div>
          );

        if (/^\d+\.\s+/.test(trimmed))
          return (
            <div className="answer-list" key={index}>
              <span>{trimmed.match(/^\d+/)[0]}.</span>

              {trimmed.replace(/^\d+\.\s+/, "")}
            </div>
          );

        return <p key={index}>{formatInline(line)}</p>;
      })}
    </div>
  );
}

function formatInline(text) {
  const pieces = text.split(
    /(`[^`]+`|\\\\\\\*\\\\\\\*[^\\\*]+\\\\\\\*\\\\\\\*)/g,
  );

  return pieces.map((piece, index) => {
    if (piece.startsWith("`") && piece.endsWith("`"))
      return (
        <code className="inline-code" key={index}>
          {piece.slice(1, -1)}
        </code>
      );

    if (piece.startsWith("\\\*\\\*") && piece.endsWith("\\\*\\\*"))
      return <strong key={index}>{piece.slice(2, -2)}</strong>;

    return <React.Fragment key={index}>{piece}</React.Fragment>;
  });
}

function CodeBlock({ language, code }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);

      setCopied(true);

      setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="code-block">
      <div className="code-header">
        <span>{language || "code"}</span>

        <button onClick={copy}>
          {copied ? <Check size={13} /> : <Copy size={13} />}{" "}
          {copied ? "Copied" : "Copy code"}
        </button>
      </div>

      <pre>
        <code>{code}</code>
      </pre>
    </div>
  );
}

function App() {
  const [token, setToken] = useState(
    () => localStorage.getItem("atlas_access_token") || "",
  );
  const [user, setUser] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem("atlas_user") || "null");
    } catch {
      return null;
    }
  });
  const [page, setPage] = useState("chat");
  const [profileOpen, setProfileOpen] = useState(false);
  const [loginName, setLoginName] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [loginError, setLoginError] = useState("");
  const [loginBusy, setLoginBusy] = useState(false);
  useEffect(() => {
    if (!token) return;
    fetch(`${API}/api/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => {
        if (!r.ok) throw new Error("Session expired");
        return r.json();
      })
      .then((u) => {
        setUser(u);
        localStorage.setItem("atlas_user", JSON.stringify(u));
      })
      .catch(() => {
        localStorage.removeItem("atlas_access_token");
        localStorage.removeItem("atlas_user");
        setToken("");
        setUser(null);
      });
  }, []);
  async function login(e) {
    e.preventDefault();
    setLoginError("");
    setLoginBusy(true);
    try {
      const r = await fetch(`${API}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: loginName, password: loginPassword }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.detail || "Login failed");
      localStorage.setItem("atlas_access_token", data.access_token);
      localStorage.setItem("atlas_user", JSON.stringify(data.user));
      setToken(data.access_token);
      setUser(data.user);
      setPage("chat");
    } catch (err) {
      setLoginError(err.message || "Unable to sign in");
    } finally {
      setLoginBusy(false);
    }
  }
  function logout() {
    // Preserve this account's saved chat history, but clear the selected chat.
    // On the next login, the sidebar history remains available while the main
    // panel starts on a fresh chat landing page.
    const username = String(user?.username || "")
      .trim()
      .toLowerCase();
    if (username) {
      localStorage.removeItem(`${ACTIVE_CHAT_KEY}:${username}`);
    }

    localStorage.removeItem("atlas_access_token");
    localStorage.removeItem("atlas_user");

    // Clear controlled login fields as well as authentication state.
    setLoginName("");
    setLoginPassword("");
    setLoginError("");
    setToken("");
    setUser(null);
    setPage("chat");
    setProfileOpen(false);
  }
  if (!token || !user)
    return (
      <div className="auth-page">
        <form className="auth-card" onSubmit={login} autoComplete="off">
          <div className="auth-logo">
            <ShieldCheck size={25} />
          </div>
          <h1>Atlas Agentic RAG</h1>
          <p>Sign in to continue to your assistant.</p>
          <label>Username</label>
          <input
            value={loginName}
            onChange={(e) => setLoginName(e.target.value)}
            autoComplete="off"
            required
          />
          <label>Password</label>
          <input
            type="password"
            value={loginPassword}
            onChange={(e) => setLoginPassword(e.target.value)}
            autoComplete="new-password"
            required
          />
          {loginError && <div className="auth-error">{loginError}</div>}
          <button className="primary-btn" disabled={loginBusy}>
            {loginBusy ? "Signing in…" : "Sign in"}
          </button>
        </form>
      </div>
    );
  return (
    <div className="signed-in-app">
      {page === "prompts" ? (
        <>
          <header className="top-app-bar">
            <button
              className="top-nav-btn active"
              onClick={() => setPage("chat")}
            >
              <ArrowLeft size={17} /> Back to Assistant
            </button>
            <div className="profile-wrap">
              <button
                className="profile-trigger"
                onClick={() => setProfileOpen((v) => !v)}
              >
                <span className="profile-avatar">
                  <UserRound size={17} />
                </span>
                <span className="profile-label">
                  {user.display_name || user.username}
                </span>
                <ChevronDown size={15} />
              </button>
              {profileOpen && (
                <div className="profile-dropdown">
                  <div className="profile-detail">
                    <strong>{user.display_name || user.username}</strong>
                    <span>{user.username}</span>
                    <small>Role: {user.role_name || user.role_code}</small>
                  </div>
                  <button onClick={logout}>
                    <LogOut size={15} /> Logout
                  </button>
                </div>
              )}
            </div>
          </header>
          <PromptsPage
            user={user}
            token={token}
            onBack={() => setPage("chat")}
          />
        </>
      ) : (
        <div className="chat-app-area">
          <ChatApp
            key={String(user.username || "").toLowerCase()}
            user={user}
            onPromptsClick={() => {
              setProfileOpen(false);
              setPage("prompts");
            }}
            profileOpen={profileOpen}
            onProfileToggle={() => setProfileOpen((v) => !v)}
            onLogout={logout}
          />
        </div>
      )}
    </div>
  );
}

function PromptsPage({ user, token, onBack }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState({
    code: "",
    name: "",
    category: "general",
    content: "",
    is_active: true,
  });
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
  async function load() {
    setLoading(true);
    setError("");
    try {
      const r = await fetch(`${API}/api/prompts`, { headers });
      const d = await r.json();
      if (!r.ok)
        throw new Error(
          r.status === 403
            ? "403 Forbidden — you do not have access to prompts."
            : d.detail || "Unable to load prompts",
        );
      setItems(d.prompts || []);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    load();
  }, []);
  function reset() {
    setEditing(null);
    setForm({
      code: "",
      name: "",
      category: "general",
      content: "",
      is_active: true,
    });
  }
  async function save(e) {
    e.preventDefault();
    setError("");
    setNotice("");
    try {
      const url = editing
        ? `${API}/api/prompts/${editing.id}`
        : `${API}/api/prompts`;
      const payload = editing
        ? {
            name: form.name,
            category: form.category,
            content: form.content,
            is_active: form.is_active,
          }
        : form;
      const r = await fetch(url, {
        method: editing ? "PUT" : "POST",
        headers,
        body: JSON.stringify(payload),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.detail || "Could not save prompt");
      setNotice(
        editing
          ? "Prompt updated successfully."
          : "Prompt created successfully.",
      );
      reset();
      await load();
    } catch (e) {
      setError(e.message);
    }
  }
  async function remove(item) {
    if (!confirm(`Delete prompt “${item.name}”?`)) return;
    try {
      const r = await fetch(`${API}/api/prompts/${item.id}`, {
        method: "DELETE",
        headers,
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.detail || "Delete failed");
      setNotice("Prompt deleted.");
      await load();
    } catch (e) {
      setError(e.message);
    }
  }
  if (user.role_code !== "admin")
    return (
      <main className="prompts-page">
        <div className="prompts-denied">
          <ShieldCheck size={36} />
          <h2>403 Forbidden</h2>
          <p>You do not have access to this page.</p>
          <button className="primary-btn" onClick={onBack}>
            Back to chat
          </button>
        </div>
      </main>
    );
  return (
    <main className="prompts-page">
      <div className="prompts-heading">
        <div>
          <button className="back-link" onClick={onBack}>
            <ArrowLeft size={16} /> Back to chat
          </button>
          <h1>Prompt Management</h1>
          <p>
            Manage the prompts used by the routing and answer-generation agents.
          </p>
        </div>
        <button
          className="primary-btn add-prompt"
          onClick={() => {
            reset();
            window.scrollTo({ top: 0, behavior: "smooth" });
          }}
        >
          <PlusCircle size={16} /> New prompt
        </button>
      </div>
      {error && <div className="notice error-notice">{error}</div>}
      {notice && <div className="notice success-notice">{notice}</div>}
      <div className="prompt-workspace">
        <section className="prompt-list-card">
          <div className="prompt-list-header">
            <strong>Stored prompts</strong>
            <span>{items.length} prompts</span>
          </div>
          {loading ? (
            <p className="empty-state">Loading prompts…</p>
          ) : (
            items.map((item) => (
              <button
                key={item.id}
                className={`prompt-list-item ${editing?.id === item.id ? "selected" : ""}`}
                onClick={() => {
                  setEditing(item);
                  setForm({ ...item });
                }}
              >
                <span>
                  <strong>{item.name}</strong>
                  <small>
                    {item.code} · {item.category}
                  </small>
                </span>
                <span
                  className={`status-pill ${item.is_active ? "enabled" : "disabled"}`}
                >
                  {item.is_active ? "Active" : "Inactive"}
                </span>
              </button>
            ))
          )}
        </section>
        <form className="prompt-editor-card" onSubmit={save}>
          <h2>{editing ? "Edit prompt" : "Create prompt"}</h2>
          <p>Changes are stored in MongoDB and used by the agent.</p>
          <label>Prompt code</label>
          <input
            value={form.code || ""}
            disabled={!!editing}
            onChange={(e) => setForm({ ...form, code: e.target.value })}
            placeholder="e.g. answer_system"
            required
            minLength={2}
          />
          <label>Display name</label>
          <input
            value={form.name || ""}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            required
          />
          <label>Category</label>
          <input
            value={form.category || "general"}
            onChange={(e) => setForm({ ...form, category: e.target.value })}
          />
          <label>Prompt content</label>
          <textarea
            className="prompt-content-input"
            value={form.content || ""}
            onChange={(e) => setForm({ ...form, content: e.target.value })}
            required
            rows={12}
          />
          <label className="active-toggle">
            <input
              type="checkbox"
              checked={form.is_active !== false}
              onChange={(e) =>
                setForm({ ...form, is_active: e.target.checked })
              }
            />{" "}
            Active prompt
          </label>
          <div className="prompt-form-actions">
            <button type="submit" className="primary-btn">
              <Save size={15} />
              {editing ? "Save changes" : "Create prompt"}
            </button>
            {editing && (
              <button
                type="button"
                className="secondary-btn danger-btn"
                onClick={() => remove(editing)}
              >
                Delete
              </button>
            )}
            {editing && (
              <button type="button" className="secondary-btn" onClick={reset}>
                Cancel
              </button>
            )}
          </div>
        </form>
      </div>
    </main>
  );
}

createRoot(document.getElementById("root")).render(<App />);
