import { useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import DOMPurify from "dompurify";
import { marked } from "marked";
import { getSettings } from "../lib/db";
import {
  askHelpCompanion, boundedHelpHistory, HELP_CONTEXT_EVENT, HELP_OPEN_EVENT,
  HELP_TOPICS, helpCropFromPoints, helpScreenForRoute, helpSuggestions, MAX_HELP_IMAGES, prepareHelpImage, searchHelp, supportsHelpSnapshot,
  type HelpAnswer, type HelpCropBox, type HelpImage, type HelpScreen, type HelpTurn,
} from "../lib/helpCompanion";
import "./HelpCompanion.css";

type Attachment = HelpImage & { id: number };
type Message = HelpTurn & { result?: HelpAnswer; context?: HelpScreen; imageCount?: number };
const FILTER_LABELS: Record<string, string> = {
  year: "Year", year_mode: "Reporting basis", quarter: "Quarter", month: "Month", as_of: "As of",
};

function HelpIcon() {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
    <path d="M8 9a4 4 0 0 1 8 0c0 3-4 3-4 6" /><circle cx="12" cy="19" r=".8" fill="currentColor" />
  </svg>;
}

export default function HelpCompanion() {
  const location = useLocation();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"chat" | "guide">("chat");
  const [question, setQuestion] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [cropId, setCropId] = useState<number | null>(null);
  const [imageConsent, setImageConsent] = useState(false);
  const [includeData, setIncludeData] = useState(false);
  const [includeScreen, setIncludeScreen] = useState(true);
  const [screen, setScreen] = useState<HelpScreen>(() => helpScreenForRoute(location.pathname));
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [availability, setAvailability] = useState("Checking Azure configuration…");
  const [sharingOpen, setSharingOpen] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [pending, setPending] = useState<Message | null>(null);
  const [guideSection, setGuideSection] = useState("all");
  const launcher = useRef<HTMLButtonElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const questionInput = useRef<HTMLTextAreaElement>(null);
  const end = useRef<HTMLDivElement>(null);
  const latestAnswer = useRef<HTMLElement>(null);
  const pendingScreen = useRef<HelpScreen | null>(null);
  const epoch = useRef(0);
  const uploadEpoch = useRef(0);
  const sending = useRef(false);
  const preparingRef = useRef(false);
  const nextImageId = useRef(0);
  const guide = searchHelp(search, location.pathname).filter((topic) => guideSection === "all" ||
    (guideSection === "screen" ? topic.routes.includes(location.pathname) : topic.routes.some((path) => path.startsWith(`/${guideSection}/`) || path === `/${guideSection}`)));
  const activeScreen = screen.route === location.pathname ? screen : helpScreenForRoute(location.pathname);
  const snapshotAvailable = !includeScreen || supportsHelpSnapshot(location.pathname);
  const suggestions = helpSuggestions(location.pathname);
  const hasConversation = messages.length > 0 || question.length > 0 || attachments.length > 0 || preparing;
  const cropImage = attachments.find((image) => image.id === cropId);

  useEffect(() => {
    const requests = epoch;
    const uploads = uploadEpoch;
    const handleOpen = (event: Event) => {
      const detail = (event as CustomEvent<{ question?: string }>).detail;
      if (detail?.question && !sending.current) setQuestion(detail.question.slice(0, 4000));
      setOpen(true);
      setTab("chat");
    };
    const handleContext = (event: Event) => {
      const next = (event as CustomEvent<HelpScreen>).detail;
      pendingScreen.current = next;
      setScreen(next);
    };
    window.addEventListener(HELP_OPEN_EVENT, handleOpen);
    window.addEventListener(HELP_CONTEXT_EVENT, handleContext);
    return () => {
      requests.current++;
      uploads.current++;
      window.removeEventListener(HELP_OPEN_EVENT, handleOpen);
      window.removeEventListener(HELP_CONTEXT_EVENT, handleContext);
    };
  }, []);

  useEffect(() => {
    const current = pendingScreen.current;
    setScreen(current?.route === location.pathname ? current : helpScreenForRoute(location.pathname));
    setIncludeData(false);
  }, [location.pathname]);

  useEffect(() => {
    if (open) heading.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
      const target = event.target;
      if (target instanceof HTMLElement && target.closest('[role="dialog"], [aria-modal="true"]')) return;
      setOpen(false);
      launcher.current?.focus();
    };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [open]);

  useEffect(() => {
    if (!open || tab !== "chat") return;
    if (!busy && messages.length > 0) latestAnswer.current?.scrollIntoView({ block: "start" });
    else if (busy) end.current?.scrollIntoView({ block: "nearest" });
  }, [messages, busy, open, tab]);

  useEffect(() => {
    if (tab === "guide" && expanded) {
      document.getElementById(`help-topic-${expanded}`)?.scrollIntoView({ block: "nearest" });
    }
  }, [tab, expanded]);

  useEffect(() => {
    if (!open) return;
    let active = true;
    const load = async () => {
      try {
        const settings = await getSettings();
        if (!active) return;
        setAvailability(settings.ask_echelon_enabled === "0"
          ? "AI help is disabled. Enable Ask Echelon in Configuration → Staff."
          : settings.azure_ai_key_set !== "1"
            ? "Add an Azure AI key in Configuration → Staff to ask AI."
            : "");
      } catch {
        if (active) setAvailability("Could not check AI settings. The offline guide is still available.");
      }
    };
    void load();
    window.addEventListener("settings-saved", load);
    return () => { active = false; window.removeEventListener("settings-saved", load); };
  }, [open]);

  function close() {
    setOpen(false);
    launcher.current?.focus();
  }

  function clearConversation() {
    epoch.current++;
    uploadEpoch.current++;
    sending.current = false;
    preparingRef.current = false;
    setBusy(false);
    setPreparing(false);
    setMessages([]);
    setQuestion("");
    setAttachments([]);
    setCropId(null);
    setImageConsent(false);
    setIncludeData(false);
    setError("");
    setPending(null);
    setConfirmClear(false);
    questionInput.current?.focus();
  }

  function stopAnswer() {
    epoch.current++;
    sending.current = false;
    setBusy(false);
    setPending(null);
    setError("Answer stopped. Your question is still here. A request already sent to Azure cannot be recalled.");
  }

  function startQuestion(text: string) {
    if (sending.current) return;
    setQuestion(text);
    setTab("chat");
    setConfirmClear(false);
    requestAnimationFrame(() => questionInput.current?.focus());
  }

  async function attach(files: File[]) {
    if (sending.current || preparingRef.current) return;
    const request = ++uploadEpoch.current;
    if (attachments.length + files.length > MAX_HELP_IMAGES) {
      setError("Attach at most two screenshots per question.");
      return;
    }
    preparingRef.current = true;
    setPreparing(true);
    setImageConsent(false);
    setError("");
    try {
      const prepared = await Promise.all(files.map(prepareHelpImage));
      if (uploadEpoch.current !== request) return;
      setAttachments((previous) => [...previous, ...prepared.map((image) => ({ ...image, id: ++nextImageId.current }))]);
    } catch (cause) {
      if (uploadEpoch.current === request) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (uploadEpoch.current === request) { preparingRef.current = false; setPreparing(false); }
    }
  }

  async function send() {
    const text = question.trim() || (attachments.length > 0 ? "Explain this screenshot and what I should check or do next." : "");
    if (!text || sending.current || preparingRef.current || availability || cropId !== null) return;
    if (attachments.length && !imageConsent) {
      setError("Confirm that these screenshots may be sent to Azure, or remove them.");
      return;
    }
    sending.current = true;
    setBusy(true);
    setConfirmClear(false);
    setError("");
    const request = ++epoch.current;
    const context: HelpScreen = includeScreen ? activeScreen : { route: "", title: "", filters: {} };
    const imageCount = attachments.length;
    setPending({ role: "user", content: text, imageCount, context });
    try {
      const answer = await askHelpCompanion({
        question: text,
        history: boundedHelpHistory(messages.map(({ role, content }) => ({ role, content }))),
        screen: context,
        images: attachments.map(({ mime_type, data_base64 }) => ({ mime_type, data_base64 })),
        images_confirmed: imageConsent,
        include_data: includeData && snapshotAvailable,
      });
      if (epoch.current !== request) return;
      const exchange: Message[] = [
        { role: "user", content: text, imageCount, context },
        { role: "assistant", content: answer.answer, result: answer, context },
      ];
      setMessages((previous) => [...previous, ...exchange].slice(-20));
      setQuestion("");
      setAttachments([]);
      setImageConsent(false);
    } catch (cause) {
      if (epoch.current === request) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (epoch.current === request) { sending.current = false; setBusy(false); setPending(null); }
    }
  }

  function goTo(path: string) {
    // Destinations come only from the shipped guide, never model-provided URLs.
    if (!HELP_TOPICS.some((topic) => topic.routes.includes(path))) return;
    navigate(path);
    close();
  }

  return <>
    <button ref={launcher} type="button" className={`help-launcher${location.pathname === "/" ? " help-launcher-home" : ""}`} onClick={() => open ? close() : setOpen(true)}
      aria-expanded={open} aria-controls="help-companion" title="Help with this screen">
      <HelpIcon /><span>Ask Echelon</span>
    </button>
    {open && <aside id="help-companion" className="help-panel" aria-labelledby="help-title"
      onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); close(); } }}>
      <header className="help-header">
        <div><h2 id="help-title" ref={heading} tabIndex={-1}>Ask Echelon</h2><p>Here to help. Your records stay unchanged.</p></div>
        <div className="help-header-actions">
          {hasConversation && !busy && <button type="button" className="help-text-button" onClick={() => setConfirmClear((value) => !value)}>New chat</button>}
          <button className="help-icon-button" type="button" onClick={close} aria-label="Close help" title="Close help (Esc)">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="m6 6 12 12M6 18 18 6" /></svg>
          </button>
        </div>
      </header>
      <div className="help-tabs" role="group" aria-label="Help mode">
        <button type="button" aria-pressed={tab === "chat"} onClick={() => setTab("chat")}>Ask a question</button>
        <button type="button" aria-pressed={tab === "guide"} onClick={() => setTab("guide")}>Browse help <span>Works offline</span></button>
      </div>
      {confirmClear && <div className="help-clear-confirm" role="group" aria-label="Start a new chat">
        <p>Clear this chat and any attached screenshots?</p>
        <div className="help-actions">
          <button className="btn secondary" type="button" onClick={() => setConfirmClear(false)}>Keep this chat</button>
          <button className="btn" type="button" onClick={clearConversation}>Clear & start new</button>
        </div>
      </div>}
      {tab === "guide" ? <div className="help-guide">
        <label htmlFor="help-search">What do you need help with?</label>
        <input id="help-search" type="search" value={search} onChange={(event) => setSearch(event.target.value)}
          placeholder="Search receipts, staff, attendance…" />
        <div className="help-guide-filter">
          <label htmlFor="help-guide-section">Show</label>
          <select id="help-guide-section" value={guideSection} onChange={(event) => { setGuideSection(event.target.value); setExpanded(null); }}>
            <option value="all">All topics</option><option value="screen">This screen</option>
            <option value="students">Students & receipts</option><option value="reports">Reports</option>
            <option value="staff">Staff</option><option value="expenses">Expenses</option>
            <option value="communications">Communications</option><option value="config">Settings & backups</option>
          </select>
          <span className="help-muted">{guide.length} {guide.length === 1 ? "topic" : "topics"}</span>
        </div>
        <p className="help-muted">Nothing is sent to Azure when you browse help.</p>
        {guide.length === 0 && <div className="help-guide-empty"><p>No topics found. Try a shorter search or browse all topics.</p>
          <button type="button" className="btn secondary" onClick={() => { setSearch(""); setGuideSection("all"); }}>Show all topics</button>
        </div>}
        {guide.map((topic) => <article id={`help-topic-${topic.id}`} key={topic.id} className="help-topic">
          <button className="help-topic-title" type="button" aria-expanded={expanded === topic.id} aria-controls={`help-topic-body-${topic.id}`}
            onClick={() => setExpanded(expanded === topic.id ? null : topic.id)}>
            <span>{topic.title}{topic.routes.includes(location.pathname) && <small>On this screen</small>}</span>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
              <path d={expanded === topic.id ? "m6 15 6-6 6 6" : "m6 9 6 6 6-6"} />
            </svg>
          </button>
          <p className={expanded === topic.id ? "" : "help-topic-summary"}>{topic.summary}</p>
          {expanded === topic.id && <>
            <div id={`help-topic-body-${topic.id}`}>
            <ol>{topic.steps.map((step, index) => <li key={index}>{step}</li>)}</ol>
            {topic.cautions.length > 0 && <div className="help-cautions"><strong>Before you act</strong>
              <ul>{topic.cautions.map((caution, index) => <li key={index}>{caution}</li>)}</ul>
            </div>}
            <div className="help-actions">
              <button className="btn secondary" type="button" onClick={() => goTo(topic.routes[0])}>Open {topic.title}</button>
              <button className="help-text-button" type="button" disabled={busy} onClick={() => startQuestion(`Explain ${topic.title} and what I should check before using it.`)}>Ask about this</button>
            </div>
            </div>
          </>}
        </article>)}
      </div> : <>
        <div className="help-conversation" role="log" aria-label="Help conversation">
          {messages.length === 0 && !pending && <div className="help-intro">
            <HelpIcon />
            <h3>Let’s make this easier.</h3>
            <p>Ask in your own words, or add a screenshot of what you’re seeing.</p>
            <div className="help-suggestions">
              {suggestions.map((suggestion) =>
                <button type="button" key={suggestion.label} onClick={() => startQuestion(suggestion.question)}>
                  <span>{suggestion.label}</span><span aria-hidden="true">→</span>
                </button>)}
            </div>
          </div>}
          {messages.map((message, index) => <article ref={message.role === "assistant" && index === messages.length - 1 ? latestAnswer : undefined}
            className={`help-message help-message-${message.role}`} key={index}>
            <strong>{message.role === "user" ? "You" : "Ask Echelon"}</strong>
            {message.role === "assistant" ? <FormattedHelpAnswer content={message.content} /> : <div className="help-answer">{message.content}</div>}
            {!!message.imageCount && <p className="help-muted">{message.imageCount === 1 ? "1 screenshot attached" : `${message.imageCount} screenshots attached`} · Reattach to inspect again</p>}
            {message.result && <>
              <AnswerSources result={message.result} onOpen={goTo} onGuide={(id) => {
                setTab("guide"); setSearch(""); setGuideSection("all"); setExpanded(id);
              }} />
              <details className="help-answer-details">
                <summary>About this answer{message.result.evidence.length ? " · includes saved totals" : ""}</summary>
                <p className="help-muted">App v{message.result.app_version} · {message.context?.title || "No screen context"}. AI can make mistakes; check the guide before acting.</p>
                {message.result.evidence.length > 0 && <div className="help-evidence">
                  <strong>Read-only data used</strong><ul>{message.result.evidence.map((fact, i) => <li key={i}>{fact}</li>)}</ul>
                </div>}
              </details>
            </>}
          </article>)}
          {pending && <article className="help-message help-message-user"><strong>You</strong><div className="help-answer">{pending.content}</div>
            {!!pending.imageCount && <p className="help-muted">{pending.imageCount} screenshot(s) attached</p>}
          </article>}
          {busy && <div className="help-thinking" role="status"><span className="help-thinking-dot" />Looking through the app guide…
            <button type="button" className="help-text-button" onClick={stopAnswer}>Stop</button>
          </div>}
          {messages.length > 0 && !busy && !question && <div className="help-follow-ups" aria-label="Follow-up suggestions">
            <button type="button" onClick={() => startQuestion("Show me the steps for your previous answer, one at a time.")}>Show me the steps</button>
            <button type="button" onClick={() => startQuestion("What should I check before following your previous answer?")}>What should I check?</button>
          </div>}
          <div ref={end} />
        </div>
        <form className="help-composer" onSubmit={(event) => { event.preventDefault(); void send(); }}
          onPaste={(event) => {
            const images = Array.from(event.clipboardData.files).filter((file) => file.type.startsWith("image/"));
            if (images.length) { event.preventDefault(); void attach(images); }
          }}>
          <details className="help-sharing" open={sharingOpen} onToggle={(event) => setSharingOpen(event.currentTarget.open)}>
            <summary><span>{includeScreen ? `Helping with: ${activeScreen.title}` : "Screen context off"}{includeData && snapshotAvailable ? " + totals" : ""}</span>
              <span className="help-sharing-link">Privacy & options</span>
            </summary>
            <div className="help-sharing-body">
            <label><input type="checkbox" checked={includeScreen} disabled={busy}
              onChange={(event) => {
                setIncludeScreen(event.target.checked);
                if (event.target.checked && !supportsHelpSnapshot(location.pathname)) setIncludeData(false);
              }} />Use this screen and its selected dates</label>
            {includeScreen && <div className="help-context">{activeScreen.title}
              {Object.entries(activeScreen.filters).map(([key, value]) => <div key={key}>
                {FILTER_LABELS[key] ?? key}: {
                  value === "fiscal_sep_aug" ? "Fiscal (September-August)" : value === "calendar" ? "Calendar year" : value
                }
              </div>)}
            </div>}
            <label><input type="checkbox" checked={includeData && snapshotAvailable} disabled={busy || !snapshotAvailable}
              onChange={(event) => setIncludeData(event.target.checked)} />{
                includeScreen && ["/students", "/students/roster"].includes(location.pathname)
                  ? "Include the active-student count (no names)"
                  : "Include saved receipt totals (no names)"
              }</label>
            {!snapshotAvailable && <p>Automatic totals are not available for this screen. Use Data questions for other records.</p>}
            {!includeScreen && <p>Without screen context, receipt totals cover all dates.</p>}
            <p>Only your question, up to five recent exchanges, and the options you choose go to Azure. Opening help never uploads a screenshot. Text and images are not automatically redacted.</p>
            <p>Chat and images are not saved as local chat files. They clear when the app locks; Azure retention follows your service configuration.</p>
            {hasConversation && <button type="button" className="help-text-button" disabled={busy} onClick={() => { setSharingOpen(false); setConfirmClear(true); }}>Clear chat & screenshots…</button>}
            </div>
          </details>
          {availability && <p className="help-notice" role="status">{availability} <button className="help-text-button" type="button" onClick={() => { navigate("/config/staff"); close(); }}>Open configuration</button></p>}
          {attachments.length > 0 && <div className="help-attachments">
            {attachments.map((image, index) => <div key={image.id} className="help-attachment">
              <button className="help-image-preview" type="button" disabled={busy} title="View and crop screenshot" onClick={() => { setCropId(image.id); setImageConsent(false); }}>
                <img src={`data:${image.mime_type};base64,${image.data_base64}`} alt={`Review screenshot ${index + 1}`} />
              </button>
              <div className="help-actions">
                <button type="button" disabled={busy} onClick={() => { setCropId(image.id); setImageConsent(false); }}>Crop</button>
                <button type="button" disabled={busy} aria-label={`Remove screenshot ${index + 1}`} onClick={() => { setAttachments((previous) => previous.filter((item) => item.id !== image.id)); setImageConsent(false); if (cropId === image.id) setCropId(null); }}>Remove</button>
              </div>
            </div>)}
          </div>}
          {cropImage && <ScreenshotCrop key={cropImage.id}
            image={cropImage}
            onCancel={() => setCropId(null)}
            onApply={(image) => { setAttachments((previous) => previous.map((item) => item.id === cropId ? { ...image, id: item.id } : item)); setCropId(null); setImageConsent(false); }} />}
          {attachments.length > 0 && <label className="help-consent"><input type="checkbox" checked={imageConsent} disabled={busy}
            onChange={(event) => setImageConsent(event.target.checked)} /><span>I’ve checked these images. Send them to Azure.<small>Crop out names or private details you don’t want to share.</small></span></label>}
          <label htmlFor="help-question">{messages.length ? "Ask a follow-up" : "Your question"}</label>
          <textarea ref={questionInput} id="help-question" value={question} maxLength={4000} rows={2} disabled={busy}
            aria-describedby="help-send-note"
            onChange={(event) => setQuestion(event.target.value)}
            placeholder={attachments.length ? "Add a question, or send to explain the screenshot…" : messages.length ? "What else would you like to know?" : "What would you like help with?"}
            onKeyDown={(event) => { if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }} />
          {error && <div role="alert" className="help-error"><p>{error}</p>
            <button type="button" className="help-text-button" onClick={() => setError("")}>Dismiss</button>
          </div>}
          <input ref={fileInput} type="file" accept="image/png,image/jpeg" multiple hidden onChange={(event) => {
            void attach(Array.from(event.target.files ?? [])); event.target.value = "";
          }} />
          <div className="help-actions help-compose-actions">
            <button className="btn secondary" type="button" disabled={busy || preparing || attachments.length >= MAX_HELP_IMAGES}
              title="Attach PNG or JPEG, up to 4 MB each. You can also paste a screenshot."
              onClick={() => fileInput.current?.click()}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                <rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="8" cy="9" r="1.5" /><path d="m3 17 5-5 4 4 4-6 5 7" />
              </svg>{preparing ? "Preparing…" : "Add screenshot"}
            </button>
            <button className="btn help-send" type="submit" disabled={busy || preparing || !!availability || (!question.trim() && !attachments.length) || (attachments.length > 0 && !imageConsent) || cropId !== null}>
              {busy ? "Thinking…" : "Send question"}
              {!busy && <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M12 19V5m-6 6 6-6 6 6" /></svg>}
            </button>
          </div>
          <p id="help-send-note" className="help-send-note">Your question goes to Azure. I can guide you, not change records.</p>
          <div className="help-footer">
            <span>Ctrl / ⌘ + Enter to send</span>
            <button className="help-text-button" type="button" onClick={() => { navigate("/ask"); close(); }}>Data questions & saved reports</button>
          </div>
        </form>
      </>}
    </aside>}
  </>;
}

function FormattedHelpAnswer({ content }: { content: string }) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState("");
  const answerText = useRef<HTMLDivElement>(null);
  useEffect(() => { setCopied(false); setCopyError(""); }, [content]);
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(content, { async: false, breaks: true }), {
    ALLOWED_TAGS: ["p", "br", "strong", "em", "ol", "ul", "li", "h1", "h2", "h3", "h4", "blockquote", "pre", "code"],
    ALLOWED_ATTR: [], ALLOW_DATA_ATTR: false,
  }), [content]);
  return <>
    <div ref={answerText} className="help-answer help-formatted-answer" dangerouslySetInnerHTML={{ __html: html }} />
    <button type="button" className="help-text-button help-copy" onClick={async () => {
      try {
        if (!answerText.current) throw new Error("The answer is no longer available.");
        await navigator.clipboard.writeText(answerText.current.innerText);
        setCopied(true);
        setCopyError("");
      } catch {
        setCopied(false);
        setCopyError("Could not copy. Select the answer text and copy it manually.");
      }
    }}>{copied ? "Copied" : "Copy answer"}</button>
    {copyError && <p role="alert" className="help-error">{copyError}</p>}
  </>;
}

function AnswerSources({ result, onOpen, onGuide }: {
  result: HelpAnswer;
  onOpen: (path: string) => void;
  onGuide: (id: string) => void;
}) {
  const topics = Array.from(new Set(result.topic_ids)).flatMap((id) => {
    const topic = HELP_TOPICS.find((item) => item.id === id);
    return topic ? [topic] : [];
  });
  if (!topics.length) return null;
  return <div className="help-answer-sources">
    <button type="button" className="btn secondary" onClick={() => onOpen(topics[0].routes[0])}>
      Open {topics[0].title}
    </button>
    <details><summary>Related instructions</summary>
      <div className="help-source-links">{topics.map((topic) =>
        <button type="button" className="help-text-button" key={topic.id} onClick={() => onGuide(topic.id)}>{topic.title}</button>)}</div>
    </details>
  </div>;
}

function ScreenshotCrop({ image, onApply, onCancel }: {
  image: HelpImage;
  onApply: (image: HelpImage) => void;
  onCancel: () => void;
}) {
  const source = useRef<HTMLImageElement>(null);
  const [dimensions, setDimensions] = useState({ width: 1, height: 1 });
  const [box, setBox] = useState<HelpCropBox>({ x: 0, y: 0, width: 1, height: 1 });
  const [error, setError] = useState("");
  const selection = useRef<{ start: { x: number; y: number }; previous: HelpCropBox } | null>(null);

  function imagePoint(event: PointerEvent<HTMLDivElement>) {
    const bounds = source.current?.getBoundingClientRect();
    if (!bounds?.width || !bounds.height || !source.current?.naturalWidth) return null;
    return {
      x: (event.clientX - bounds.left) / bounds.width * dimensions.width,
      y: (event.clientY - bounds.top) / bounds.height * dimensions.height,
    };
  }

  function updateSelection(event: PointerEvent<HTMLDivElement>) {
    const point = imagePoint(event);
    if (!point || !selection.current) return;
    if (Math.abs(point.x - selection.current.start.x) < 3 && Math.abs(point.y - selection.current.start.y) < 3) return;
    setBox(helpCropFromPoints(selection.current.start, point, dimensions));
    setError("");
  }

  function crop() {
    const { x, y, width, height } = box;
    if (![x, y, width, height].every(Number.isInteger) || x < 0 || y < 0 || width < 1 || height < 1 ||
        x + width > dimensions.width || y + height > dimensions.height || !source.current?.naturalWidth) {
      setError("Choose a crop rectangle within the image dimensions."); return;
    }
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) { setError("Image cropping is unavailable on this device."); return; }
    context.drawImage(source.current, x, y, width, height, 0, 0, width, height);
    onApply({ mime_type: "image/png", data_base64: canvas.toDataURL("image/png").split(",")[1] });
  }
  return <section className="help-crop" aria-label="Crop screenshot">
    <strong>Keep just the part you need</strong>
    <p id="help-crop-instructions">Drag across the image to select an area. Only the selected area will be sent.</p>
    <div className="help-crop-preview" role="group" aria-label="Select screenshot area" aria-describedby="help-crop-instructions"
      onPointerDown={(event) => {
        if (event.button !== 0 || !event.isPrimary) return;
        const start = imagePoint(event);
        if (!start) return;
        selection.current = { start, previous: box };
        event.currentTarget.setPointerCapture(event.pointerId);
        event.preventDefault();
      }}
      onPointerMove={updateSelection}
      onPointerUp={(event) => {
        updateSelection(event);
        selection.current = null;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onPointerCancel={() => {
        if (selection.current) setBox(selection.current.previous);
        selection.current = null;
      }}>
      <img ref={source} src={`data:${image.mime_type};base64,${image.data_base64}`} alt="Screenshot to crop" draggable={false}
        onLoad={(event) => {
          const { naturalWidth: width, naturalHeight: height } = event.currentTarget;
          setDimensions({ width, height }); setBox({ x: 0, y: 0, width, height });
        }} />
      <div aria-hidden="true" className="help-crop-outline" style={{
        left: `${box.x / dimensions.width * 100}%`, top: `${box.y / dimensions.height * 100}%`,
        width: `${box.width / dimensions.width * 100}%`, height: `${box.height / dimensions.height * 100}%`,
      }} />
    </div>
    <div className="help-crop-selection"><span role="status">Selected: {box.width} × {box.height} pixels</span>
      <button type="button" className="help-text-button" onClick={() => { setBox({ x: 0, y: 0, ...dimensions }); setError(""); }}>Reset selection</button>
    </div>
    <details className="help-crop-precise"><summary>Fine-tune with the keyboard</summary>
    <div className="help-crop-fields">{(["x", "y", "width", "height"] as const).map((key) =>
      <label key={key}>{({ x: "Left", y: "Top", width: "Width", height: "Height" })[key]}
        <input type="number" min={key === "x" || key === "y" ? 0 : 1} max={key === "x" || key === "width" ? dimensions.width : dimensions.height}
          value={box[key]} onChange={(event) => setBox({ ...box, [key]: Number(event.target.value) })} />
      </label>)}</div>
    </details>
    {error && <p role="alert" className="help-error">{error}</p>}
    <div className="help-actions"><button type="button" className="btn secondary" onClick={onCancel}>Cancel crop</button>
      <button type="button" className="btn" onClick={crop}>Use selected area</button></div>
  </section>;
}
