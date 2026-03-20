"use client";

import { useEffect, useMemo, useRef, useState } from "react";

type Summary = {
  title: string;
  one_liner: string;
  key_points: string[];
  action_items: { task: string; owner: string | null; due_date: string | null; priority: "low" | "medium" | "high" | null }[];
  decisions: string[];
  open_questions: string[];
  tags: string[];
  language: "pt" | "en";
};

type UserProfile = {
  sub: string; // unique user id
  name?: string;
  email?: string;
  picture?: string;
};

type Note = {
  id: string;
  createdAt: number;
  title: string;
  transcript: string;
  summary: Summary | null;
};

declare global {
  interface Window {
    google?: any;
    webkitSpeechRecognition?: any;
    SpeechRecognition?: any;
  }
}

function getSpeechRecognitionCtor() {
  return window.SpeechRecognition || window.webkitSpeechRecognition;
}

function decodeJwtPayload(token: string): any | null {
  try {
    const part = token.split(".")[1];
    if (!part) return null;
    const base64 = part.replace(/-/g, "+").replace(/_/g, "/");
    const json = decodeURIComponent(
      atob(base64)
        .split("")
        .map((c) => "%" + ("00" + c.charCodeAt(0).toString(16)).slice(-2))
        .join("")
    );
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function makeNoteTitle(summary: Summary | null, transcript: string) {
  if (summary?.title?.trim()) return summary.title.trim();
  const t = transcript.trim();
  return t.length ? (t.slice(0, 48) + (t.length > 48 ? "…" : "")) : "Untitled note";
}

export default function Home() {
  // ===== Google login =====
  const [idToken, setIdToken] = useState<string | null>(null);
  const [user, setUser] = useState<UserProfile | null>(null);
  const googleBtnRef = useRef<HTMLDivElement | null>(null);

  // ===== Notes (localStorage by user) =====
  const [notes, setNotes] = useState<Note[]>([]);
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null);

  // ===== Live transcription =====
  const [isRecording, setIsRecording] = useState(false);
  const [finalText, setFinalText] = useState("");
  const [interimText, setInterimText] = useState("");

  const [error, setError] = useState<string | null>(null);
  const [lang, setLang] = useState<"pt-PT" | "en-US">("pt-PT");
  const [autoLang, setAutoLang] = useState(true);

  const [summary, setSummary] = useState<Summary | null>(null);
  const [summaryStatus, setSummaryStatus] = useState<"idle" | "updating" | "ok" | "error">("idle");

  const recRef = useRef<any>(null);
  const debounceRef = useRef<number | null>(null);
  const lastSentRef = useRef<string>("");

  const combinedTranscript = useMemo(() => {
    const full = (finalText + (interimText ? " " + interimText : "")).trim();
    return full.replace(/\s+/g, " ");
  }, [finalText, interimText]);

  // ===== Helpers for notes storage key =====
  const storageKey = useMemo(() => {
    // if logged in, store per user sub; otherwise guest
    const sub = user?.sub ?? "guest";
    return `vns_notes_${sub}`;
  }, [user?.sub]);

  function loadNotes() {
    try {
      const raw = localStorage.getItem(storageKey);
      const parsed = raw ? (JSON.parse(raw) as Note[]) : [];
      // newest first
      parsed.sort((a, b) => b.createdAt - a.createdAt);
      setNotes(parsed);
      if (parsed.length && !selectedNoteId) setSelectedNoteId(parsed[0].id);
    } catch {
      setNotes([]);
    }
  }

  function persistNotes(next: Note[]) {
    setNotes(next);
    localStorage.setItem(storageKey, JSON.stringify(next));
  }

  // Load token/profile on boot
  useEffect(() => {
    const saved = localStorage.getItem("vns_google_id_token");
    if (saved) {
      setIdToken(saved);
      const payload = decodeJwtPayload(saved);
      if (payload?.sub) {
        setUser({
          sub: payload.sub,
          name: payload.name,
          email: payload.email,
          picture: payload.picture,
        });
      }
    }
  }, []);

  // Whenever storageKey changes (login/logout), reload notes for that user
  useEffect(() => {
    if (typeof window === "undefined") return;
    loadNotes();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey]);

  // Init Google button
  useEffect(() => {
    const clientId = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;
    if (!clientId) {
      setError("Falta NEXT_PUBLIC_GOOGLE_CLIENT_ID no .env.local.");
      return;
    }

    const tryInit = () => {
      if (!window.google?.accounts?.id) return false;

      window.google.accounts.id.initialize({
        client_id: clientId,
        callback: (resp: any) => {
          const token = resp?.credential;
          if (!token) return;
          localStorage.setItem("vns_google_id_token", token);
          setIdToken(token);

          const payload = decodeJwtPayload(token);
          if (payload?.sub) {
            setUser({
              sub: payload.sub,
              name: payload.name,
              email: payload.email,
              picture: payload.picture,
            });
          }

          // notes will reload because storageKey changes
        },
      });

      if (googleBtnRef.current) {
        googleBtnRef.current.innerHTML = "";
        window.google.accounts.id.renderButton(googleBtnRef.current, {
          theme: "outline",
          size: "large",
          shape: "pill",
          text: "continue_with",
        });
      }
      return true;
    };

    // Script may load slightly later
    const t = window.setInterval(() => {
      if (tryInit()) window.clearInterval(t);
    }, 250);

    return () => window.clearInterval(t);
  }, []);

  function signOut() {
    localStorage.removeItem("vns_google_id_token");
    setIdToken(null);
    setUser(null);
    setSelectedNoteId(null);
    setFinalText("");
    setInterimText("");
    setSummary(null);
    setSummaryStatus("idle");
    lastSentRef.current = "";
    try {
      window.google?.accounts?.id?.disableAutoSelect?.();
    } catch {}
  }

  // ===== Auto language heuristic =====
  useEffect(() => {
    if (!autoLang) return;
    const t = combinedTranscript.toLowerCase();
    if (t.length < 20) return;

    const ptHints = ["ã", "õ", "ção", "ções", "não ", "para ", "com ", "que ", "está", "vou ", "preciso "];
    const enHints = [" the ", " and ", " to ", " i ", " we ", " you ", " need ", " will "];

    const ptScore = ptHints.reduce((a, h) => a + (t.includes(h) ? 1 : 0), 0);
    const enScore = enHints.reduce((a, h) => a + (t.includes(h) ? 1 : 0), 0);

    if (ptScore > enScore) setLang("pt-PT");
    if (enScore > ptScore) setLang("en-US");
  }, [combinedTranscript, autoLang]);

  function stopRecognition() {
    try {
      recRef.current?.stop?.();
    } catch {}
    recRef.current = null;
    setInterimText("");
  }

  async function start() {
    setError(null);

    const Ctor = getSpeechRecognitionCtor();
    if (!Ctor) {
      setError("O teu browser não suporta SpeechRecognition. Usa Chrome/Edge no desktop.");
      return;
    }

    // reset current draft
    setFinalText("");
    setInterimText("");
    setSummary(null);
    setSummaryStatus("idle");
    lastSentRef.current = "";

    const rec = new Ctor();
    recRef.current = rec;

    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = lang;

    rec.onresult = (event: any) => {
      let interim = "";
      let finalized = "";

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const res = event.results[i];
        const txt = res[0]?.transcript ?? "";
        if (res.isFinal) finalized += txt + " ";
        else interim += txt;
      }

      if (finalized) setFinalText((prev) => (prev + " " + finalized).replace(/\s+/g, " ").trim());
      setInterimText(interim.trim());

      scheduleSummaryUpdate();
    };

    rec.onerror = (e: any) => {
      setError(`SpeechRecognition error: ${e?.error ?? "unknown"}`);
      setIsRecording(false);
      stopRecognition();
    };

    rec.onend = () => {
      if (isRecording) {
        try {
          rec.start();
        } catch {}
      }
    };

    try {
      rec.start();
      setIsRecording(true);
    } catch (e: any) {
      setError(e?.message ?? "Não foi possível iniciar.");
    }
  }

  function stop() {
    setIsRecording(false);
    stopRecognition();
    void updateSummaryNow(true);
  }

  function scheduleSummaryUpdate() {
    if (!isRecording) return;
    if (debounceRef.current) window.clearTimeout(debounceRef.current);

    debounceRef.current = window.setTimeout(() => {
      void updateSummaryNow(false);
    }, 1200);
  }

  async function updateSummaryNow(force: boolean) {
    const text = combinedTranscript.trim();
    if (!text) return;

    const last = lastSentRef.current;
    const delta = Math.abs(text.length - last.length);
    if (!force && (delta < 25 || text === last)) return;

    lastSentRef.current = text;
    setSummaryStatus("updating");
    setError(null);

    try {
      const apiUrl = process.env.NEXT_PUBLIC_SUMMARY_API_URL;
      if (!apiUrl) throw new Error("Falta NEXT_PUBLIC_SUMMARY_API_URL no .env.local.");

      const preferred_language = lang.startsWith("pt") ? "pt" : "en";
      const res = await fetch(apiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ transcript: text, preferred_language, mode: isRecording ? "live" : "final" }),
      });

      if (!res.ok) {
        const t = await res.text();
        throw new Error(t);
      }

      const data = (await res.json()) as Summary;
      setSummary(data);
      setSummaryStatus("ok");
    } catch (e: any) {
      setSummaryStatus("error");
      setError(`Resumo (Gemini) falhou: ${e?.message ?? "erro"}`);
    }
  }

  function saveNote() {
    const transcript = combinedTranscript.trim();
    if (!transcript) {
      setError("Nada para guardar. Faz uma gravação primeiro.");
      return;
    }

    const now = Date.now();
    const note: Note = {
      id: crypto.randomUUID(),
      createdAt: now,
      title: makeNoteTitle(summary, transcript),
      transcript,
      summary: summary ?? null,
    };

    const next = [note, ...notes].slice(0, 50); // keep last 50 locally
    persistNotes(next);
    setSelectedNoteId(note.id);
  }

  function loadNote(noteId: string) {
    const n = notes.find((x) => x.id === noteId);
    if (!n) return;
    setSelectedNoteId(noteId);
    setFinalText(n.transcript);
    setInterimText("");
    setSummary(n.summary);
    setSummaryStatus(n.summary ? "ok" : "idle");
    lastSentRef.current = n.transcript;
  }

  function deleteNote(noteId: string) {
    const next = notes.filter((n) => n.id !== noteId);
    persistNotes(next);
    if (selectedNoteId === noteId) {
      setSelectedNoteId(next[0]?.id ?? null);
      if (next[0]) loadNote(next[0].id);
      else {
        setFinalText("");
        setInterimText("");
        setSummary(null);
        setSummaryStatus("idle");
      }
    }
  }

  function prettySummaryText(s: Summary, transcript: string) {
    const lines: string[] = [];
    lines.push(`# ${s.title}`);
    lines.push(s.one_liner);
    lines.push("");
    lines.push(`## Action items`);
    if (s.action_items?.length) {
      for (const a of s.action_items) {
        const bits = [a.task, a.owner ? `(${a.owner})` : null, a.due_date ? `due: ${a.due_date}` : null, a.priority ? `prio: ${a.priority}` : null]
          .filter(Boolean)
          .join(" ");
        lines.push(`- ${bits}`);
      }
    } else {
      lines.push(`- (none)`);
    }
    lines.push("");
    lines.push(`## Key points`);
    for (const k of s.key_points ?? []) lines.push(`- ${k}`);
    if (s.decisions?.length) {
      lines.push("");
      lines.push(`## Decisions`);
      for (const d of s.decisions) lines.push(`- ${d}`);
    }
    if (s.open_questions?.length) {
      lines.push("");
      lines.push(`## Open questions`);
      for (const q of s.open_questions) lines.push(`- ${q}`);
    }
    if (s.tags?.length) {
      lines.push("");
      lines.push(`Tags: ${s.tags.join(", ")}`);
    }
    lines.push("");
    lines.push(`---`);
    lines.push(`Transcript:`);
    lines.push(transcript);
    return lines.join("\n");
  }

  async function copyPretty() {
    if (!summary) return;
    await navigator.clipboard.writeText(prettySummaryText(summary, combinedTranscript.trim()));
  }

  async function ttsPlay() {
    if (!summary) return;
    const text = prettySummaryText(summary, combinedTranscript.trim());

    const u = new SpeechSynthesisUtterance(text);
    u.lang = summary.language === "pt" ? "pt-PT" : "en-US";
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(u);
  }

  function ttsStop() {
    window.speechSynthesis.cancel();
  }

  return (
    <main style={ui.page}>
      <div style={ui.bgGlow} />

      <header style={ui.header}>
        <div>
          <h1 style={ui.h1}>VNS</h1>
          <p style={ui.sub}>Live transcript + Gemini summary • Login Google → notas recentes por perfil</p>
        </div>

        <div style={ui.rightHeader}>
          {!user ? (
            <div>
              <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 6 }}>Login (Google)</div>
              <div ref={googleBtnRef} />
            </div>
          ) : (
            <div style={ui.userBox}>
              {user.picture ? <img src={user.picture} alt="avatar" style={ui.avatar} /> : <div style={ui.avatarFallback} />}
              <div>
                <div style={{ fontWeight: 800, lineHeight: 1.2 }}>{user.name ?? "Logged in"}</div>
                <div style={{ fontSize: 12, opacity: 0.8 }}>{user.email ?? ""}</div>
              </div>
              <button style={ui.btnGhost} onClick={signOut}>Logout</button>
            </div>
          )}

          <div style={ui.pill}>
            <span style={{ opacity: 0.8 }}>Idioma</span>
            <select
              value={lang}
              onChange={(e) => {
                setAutoLang(false);
                setLang(e.target.value as any);
              }}
              style={ui.select}
              disabled={autoLang}
              title={autoLang ? "Desativa Auto para escolher manualmente" : "Escolhe o idioma"}
            >
              <option value="pt-PT">PT</option>
              <option value="en-US">EN</option>
            </select>
            <label style={ui.toggle}>
              <input type="checkbox" checked={autoLang} onChange={(e) => setAutoLang(e.target.checked)} />
              <span>Auto</span>
            </label>
          </div>
        </div>
      </header>

      {error && (
        <div style={ui.alert}>
          <b>⚠️</b> <span>{error}</span>
        </div>
      )}

      <section style={ui.topControls}>
        {!isRecording ? (
          <button style={ui.btnPrimary} onClick={start}>
            ● Start
          </button>
        ) : (
          <button style={ui.btnDanger} onClick={stop}>
            ■ Stop
          </button>
        )}

        <button style={ui.btn} onClick={() => void updateSummaryNow(true)} disabled={!combinedTranscript.trim()}>
          ⟳ Atualizar resumo
        </button>

        <button style={ui.btn} onClick={saveNote} disabled={!combinedTranscript.trim()}>
          💾 Guardar nota
        </button>

        <button style={ui.btn} onClick={copyPretty} disabled={!summary}>
          📋 Copiar resumo
        </button>

        <button style={ui.btn} onClick={ttsPlay} disabled={!summary}>
          🔊 Play
        </button>
        <button style={ui.btnGhost} onClick={ttsStop}>
          ⏹️ Stop áudio
        </button>
      </section>

      <section style={ui.grid3}>
        {/* Notes list */}
        <div style={ui.card}>
          <div style={ui.cardHeader}>
            <h2 style={ui.h2}>Notas recentes</h2>
            <span style={ui.badgeSoft}>{user ? "perfil" : "guest"}</span>
          </div>

          <div style={ui.scroll}>
            {notes.length ? (
              notes.map((n) => (
                <div key={n.id} style={ui.noteRow(selectedNoteId === n.id)} onClick={() => loadNote(n.id)}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
                    <div style={{ fontWeight: 800, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{n.title}</div>
                    <div style={{ fontSize: 12, opacity: 0.65 }}>{new Date(n.createdAt).toLocaleString()}</div>
                  </div>
                  <div style={{ fontSize: 12, opacity: 0.8, marginTop: 4, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {n.summary?.one_liner ?? n.transcript}
                  </div>
                  <div style={{ marginTop: 8 }}>
                    <button
                      style={ui.smallDanger}
                      onClick={(e) => {
                        e.stopPropagation();
                        deleteNote(n.id);
                      }}
                    >
                      Apagar
                    </button>
                  </div>
                </div>
              ))
            ) : (
              <div style={{ opacity: 0.7, padding: 12 }}>Ainda não tens notas guardadas.</div>
            )}
          </div>

          <div style={ui.cardFooter}>
            <span style={ui.meta}>LocalStorage key: {storageKey}</span>
          </div>
        </div>

        {/* Live transcript */}
        <div style={ui.card}>
          <div style={ui.cardHeader}>
            <h2 style={ui.h2}>Versão completa (live)</h2>
            <span style={ui.badge}>{isRecording ? "LIVE" : "PAUSED"}</span>
          </div>

          <div style={ui.scroll}>
            <p style={ui.text}>{finalText}</p>
            {interimText && (
              <p style={ui.interim}>
                {interimText}
                <span style={ui.cursor} />
              </p>
            )}
            {!combinedTranscript && <p style={ui.placeholder}>Clica Start e fala — o texto aparece aqui em tempo real…</p>}
          </div>

          <div style={ui.cardFooter}>
            <span style={ui.meta}>Chars: {combinedTranscript.length}</span>
          </div>
        </div>

        {/* Summary */}
        <div style={ui.card}>
          <div style={ui.cardHeader}>
            <h2 style={ui.h2}>Resumo (Gemini)</h2>
            <span style={ui.badgeSoft}>{summaryStatus}</span>
          </div>

          <div style={ui.scroll}>
            {summary ? (
              <>
                <div style={ui.summaryTitle}>{summary.title}</div>
                <div style={ui.oneLiner}>{summary.one_liner}</div>

                <div style={ui.section}>
                  <div style={ui.sectionTitle}>Action items</div>
                  {summary.action_items?.length ? (
                    <ul style={ui.ul}>
                      {summary.action_items.map((a, i) => (
                        <li key={i} style={ui.li}>
                          <b>{a.task}</b>
                          {a.owner ? <span style={ui.dim}> — {a.owner}</span> : null}
                          {a.due_date ? <span style={ui.dim}> — {a.due_date}</span> : null}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <div style={ui.dim}>Sem action items.</div>
                  )}
                </div>

                <div style={ui.section}>
                  <div style={ui.sectionTitle}>Key points</div>
                  <ul style={ui.ul}>
                    {(summary.key_points ?? []).map((k, i) => (
                      <li key={i} style={ui.li}>
                        {k}
                      </li>
                    ))}
                  </ul>
                </div>
              </>
            ) : (
              <div style={ui.placeholder}>O resumo vai aparecer aqui enquanto falas…</div>
            )}
          </div>

          <div style={ui.cardFooter}>
            <span style={ui.meta}>Lang: {lang.startsWith("pt") ? "PT" : "EN"}</span>
          </div>
        </div>
      </section>

      <footer style={ui.footer}>
        Nota: este login é para “perfil” + separar notas no teu browser. O próximo passo é sincronizar notas na cloud (Worker + D1).
      </footer>
    </main>
  );
}

const ui: Record<string, any> = {
  page: {
    minHeight: "100vh",
    padding: 24,
    color: "#EAF2FF",
    background:
      "radial-gradient(1200px 700px at 15% 10%, #1b2b72 0%, rgba(14, 18, 34, 0) 60%), radial-gradient(900px 600px at 85% 20%, #6b1ed6 0%, rgba(14, 18, 34, 0) 55%), linear-gradient(180deg, #070A12, #050713)",
    fontFamily: "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial",
    position: "relative",
    overflow: "hidden",
  },
  bgGlow: {
    position: "absolute",
    inset: -200,
    background: "radial-gradient(circle at 50% 50%, rgba(0,255,255,0.10), rgba(0,0,0,0) 55%)",
    filter: "blur(10px)",
    pointerEvents: "none",
  },
  header: { display: "flex", justifyContent: "space-between", gap: 16, alignItems: "flex-start", maxWidth: 1300, margin: "0 auto 14px" },
  rightHeader: { display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-start", justifyContent: "flex-end" },
  h1: { margin: 0, fontSize: 28, letterSpacing: 0.2 },
  sub: { margin: "6px 0 0", opacity: 0.8 },
  pill: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "10px 12px",
    borderRadius: 14,
    border: "1px solid rgba(255,255,255,0.12)",
    background: "rgba(255,255,255,0.06)",
    backdropFilter: "blur(10px)",
  },
  select: {
    background: "rgba(0,0,0,0.25)",
    color: "#EAF2FF",
    border: "1px solid rgba(255,255,255,0.16)",
    borderRadius: 10,
    padding: "6px 10px",
    outline: "none",
  },
  toggle: { display: "flex", gap: 6, alignItems: "center", fontSize: 12, opacity: 0.9 },
  topControls: { maxWidth: 1300, margin: "0 auto 14px", display: "flex", gap: 10, flexWrap: "wrap" },
  btnPrimary: {
    padding: "10px 14px",
    borderRadius: 14,
    border: "1px solid rgba(0,255,255,0.35)",
    background: "linear-gradient(135deg, rgba(0,255,255,0.18), rgba(107,30,214,0.12))",
    color: "#EAF2FF",
    cursor: "pointer",
  },
  btnDanger: {
    padding: "10px 14px",
    borderRadius: 14,
    border: "1px solid rgba(255,80,120,0.45)",
    background: "linear-gradient(135deg, rgba(255,80,120,0.22), rgba(107,30,214,0.10))",
    color: "#EAF2FF",
    cursor: "pointer",
  },
  btn: {
    padding: "10px 14px",
    borderRadius: 14,
    border: "1px solid rgba(255,255,255,0.14)",
    background: "rgba(255,255,255,0.06)",
    color: "#EAF2FF",
    cursor: "pointer",
    backdropFilter: "blur(10px)",
  },
  btnGhost: {
    padding: "10px 14px",
    borderRadius: 14,
    border: "1px dashed rgba(255,255,255,0.18)",
    background: "transparent",
    color: "rgba(234,242,255,0.9)",
    cursor: "pointer",
  },
  alert: {
    maxWidth: 1300,
    margin: "0 auto 14px",
    padding: "10px 12px",
    borderRadius: 14,
    border: "1px solid rgba(255,120,120,0.35)",
    background: "rgba(255,80,120,0.10)",
    display: "flex",
    gap: 10,
    alignItems: "center",
  },
  grid3: { maxWidth: 1300, margin: "0 auto", display: "grid", gridTemplateColumns: "1.1fr 1.4fr 1.4fr", gap: 14 },
  card: {
    borderRadius: 18,
    border: "1px solid rgba(255,255,255,0.12)",
    background: "rgba(255,255,255,0.06)",
    backdropFilter: "blur(12px)",
    boxShadow: "0 20px 60px rgba(0,0,0,0.45)",
    overflow: "hidden",
    display: "flex",
    flexDirection: "column",
    minHeight: 520,
  },
  cardHeader: { padding: "14px 16px", display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: "1px solid rgba(255,255,255,0.10)" },
  cardFooter: { padding: "12px 16px", borderTop: "1px solid rgba(255,255,255,0.10)" },
  h2: { margin: 0, fontSize: 13, letterSpacing: 0.6, textTransform: "uppercase", opacity: 0.9 },
  badge: { fontSize: 11, padding: "4px 10px", borderRadius: 99, border: "1px solid rgba(0,255,255,0.30)", background: "rgba(0,255,255,0.10)" },
  badgeSoft: { fontSize: 11, padding: "4px 10px", borderRadius: 99, border: "1px solid rgba(255,255,255,0.16)", background: "rgba(255,255,255,0.06)" },
  scroll: { padding: 16, flex: 1, overflow: "auto" },
  text: { margin: 0, whiteSpace: "pre-wrap", lineHeight: 1.5 },
  interim: { margin: "10px 0 0", whiteSpace: "pre-wrap", opacity: 0.85, lineHeight: 1.5 },
  cursor: { display: "inline-block", width: 8, height: 16, marginLeft: 6, background: "rgba(0,255,255,0.75)", verticalAlign: "text-bottom" },
  placeholder: { opacity: 0.6, margin: 0 },
  meta: { fontSize: 12, opacity: 0.7 },
  noteRow: (active: boolean) => ({
    borderRadius: 14,
    border: "1px solid rgba(255,255,255,0.12)",
    background: active ? "rgba(0,255,255,0.08)" : "rgba(255,255,255,0.04)",
    padding: 12,
    marginBottom: 10,
    cursor: "pointer",
  }),
  smallDanger: {
    padding: "6px 10px",
    borderRadius: 12,
    border: "1px solid rgba(255,80,120,0.40)",
    background: "rgba(255,80,120,0.12)",
    color: "#EAF2FF",
    cursor: "pointer",
    fontSize: 12,
  },
  summaryTitle: { fontWeight: 800, fontSize: 16, marginBottom: 6 },
  oneLiner: { opacity: 0.9, marginBottom: 14 },
  section: { marginTop: 14 },
  sectionTitle: { fontSize: 12, letterSpacing: 0.5, textTransform: "uppercase", opacity: 0.8, marginBottom: 8 },
  ul: { margin: 0, paddingLeft: 18 },
  li: { marginBottom: 8 },
  dim: { opacity: 0.75 },
  userBox: {
    display: "flex",
    gap: 10,
    alignItems: "center",
    padding: "10px 12px",
    borderRadius: 14,
    border: "1px solid rgba(255,255,255,0.12)",
    background: "rgba(255,255,255,0.06)",
    backdropFilter: "blur(10px)",
  },
  avatar: { width: 34, height: 34, borderRadius: 999, objectFit: "cover", border: "1px solid rgba(255,255,255,0.18)" },
  avatarFallback: { width: 34, height: 34, borderRadius: 999, background: "rgba(255,255,255,0.10)" },
  footer: { maxWidth: 1300, margin: "12px auto 0", opacity: 0.7, fontSize: 12 },
};
