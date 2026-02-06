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

declare global {
  interface Window {
    webkitSpeechRecognition?: any;
    SpeechRecognition?: any;
  }
}

function getSpeechRecognitionCtor() {
  return window.SpeechRecognition || window.webkitSpeechRecognition;
}

export default function Home() {
  const [isRecording, setIsRecording] = useState(false);

  // Full transcript (final + interim)
  const [finalText, setFinalText] = useState("");
  const [interimText, setInterimText] = useState("");

  // UI / status
  const [error, setError] = useState<string | null>(null);
  const [lang, setLang] = useState<"pt-PT" | "en-US">("pt-PT");
  const [autoLang, setAutoLang] = useState(true);

  // Gemini summary (parallel)
  const [summary, setSummary] = useState<Summary | null>(null);
  const [summaryStatus, setSummaryStatus] = useState<"idle" | "updating" | "ok" | "error">("idle");

  // Speech recognition instance
  const recRef = useRef<any>(null);

  // Debounce timers
  const debounceRef = useRef<number | null>(null);
  const lastSentRef = useRef<string>("");

  const combinedTranscript = useMemo(() => {
    const full = (finalText + (interimText ? " " + interimText : "")).trim();
    return full.replace(/\s+/g, " ");
  }, [finalText, interimText]);

  // Auto language heuristic (very lightweight)
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

  function resetAll() {
    setError(null);
    setFinalText("");
    setInterimText("");
    setSummary(null);
    setSummaryStatus("idle");
    lastSentRef.current = "";
  }

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
      setError("O teu browser não suporta SpeechRecognition. Usa Chrome/Edge no desktop para live transcription.");
      return;
    }

    resetAll();

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

      // Trigger parallel summarization updates
      scheduleSummaryUpdate();
    };

    rec.onerror = (e: any) => {
      // Common: "no-speech" / "aborted" / "network"
      setError(`SpeechRecognition error: ${e?.error ?? "unknown"}`);
      setIsRecording(false);
      stopRecognition();
    };

    rec.onend = () => {
      // If still recording, auto-restart (keeps live transcription stable)
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
      setError(e?.message ?? "Não foi possível iniciar a gravação.");
    }
  }

  function stop() {
    setIsRecording(false);
    stopRecognition();
    // Do one last summary update with the final combined text
    void updateSummaryNow(true);
  }

  function scheduleSummaryUpdate() {
    if (!isRecording) return;

    if (debounceRef.current) {
      window.clearTimeout(debounceRef.current);
    }
    debounceRef.current = window.setTimeout(() => {
      void updateSummaryNow(false);
    }, 1200); // update ~1.2s after you pause speaking
  }

  async function updateSummaryNow(force: boolean) {
    const text = combinedTranscript.trim();
    if (!text) return;

    // avoid spamming: only send if meaningfully changed
    const last = lastSentRef.current;
    const delta = Math.abs(text.length - last.length);
    if (!force && (delta < 25 || text === last)) return;

    lastSentRef.current = text;
    setSummaryStatus("updating");

    try {
      const apiUrl = process.env.NEXT_PUBLIC_SUMMARY_API_URL;
      if (!apiUrl) throw new Error("Falta NEXT_PUBLIC_SUMMARY_API_URL no .env.local.");

      // Map UI lang to pt/en preference
      const preferred_language = lang.startsWith("pt") ? "pt" : "en";

      const res = await fetch(apiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          transcript: text,
          preferred_language,
          // optional hint: "live" (if you want your Worker to be more concise during live)
          mode: isRecording ? "live" : "final",
        }),
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
      setError((prev) => prev ?? `Resumo (Gemini) falhou: ${e?.message ?? "erro"}`);
    }
  }

  // Ensure recognition uses updated language if user changes it
  useEffect(() => {
    if (recRef.current) {
      try {
        recRef.current.lang = lang;
      } catch {}
    }
  }, [lang]);

  return (
    <main style={ui.page}>
      <div style={ui.bgGlow} />

      <header style={ui.header}>
        <div>
          <h1 style={ui.h1}>Voice Note Summarizer</h1>
          <p style={ui.sub}>Live transcript + resumo em paralelo (PT/EN)</p>
        </div>

        <div style={ui.pills}>
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
              <input
                type="checkbox"
                checked={autoLang}
                onChange={(e) => setAutoLang(e.target.checked)}
              />
              <span>Auto</span>
            </label>
          </div>

          <div style={ui.pill}>
            <span style={{ opacity: 0.8 }}>Gemini</span>
            <span style={ui.statusDot(summaryStatus)} />
            <span style={{ fontSize: 12 }}>
              {summaryStatus === "updating" ? "a atualizar…" : summaryStatus === "ok" ? "ok" : summaryStatus === "error" ? "erro" : "idle"}
            </span>
          </div>
        </div>
      </header>

      <section style={ui.controls}>
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

        <button style={ui.btnGhost} onClick={resetAll}>
          Limpar
        </button>
      </section>

      {error && (
        <div style={ui.alert}>
          <b>⚠️</b> <span>{error}</span>
        </div>
      )}

      <section style={ui.grid}>
        {/* Full transcript */}
        <div style={ui.card}>
          <div style={ui.cardHeader}>
            <h2 style={ui.h2}>Versão completa (live)</h2>
            <span style={ui.badge}>{isRecording ? "LIVE" : "PAUSED"}</span>
          </div>

          <div style={ui.editor}>
            <p style={ui.text}>{finalText}</p>
            {interimText && (
              <p style={ui.interim}>
                {interimText}
                <span style={ui.cursor} />
              </p>
            )}
            {!combinedTranscript && <p style={ui.placeholder}>Começa a falar para ver o texto a aparecer aqui…</p>}
          </div>

          <div style={ui.cardFooter}>
            <span style={ui.meta}>Chars: {combinedTranscript.length}</span>
            <button
              style={ui.copyBtn}
              onClick={async () => {
                await navigator.clipboard.writeText(combinedTranscript);
              }}
              disabled={!combinedTranscript}
            >
              Copy
            </button>
          </div>
        </div>

        {/* Parallel summary */}
        <div style={ui.card}>
          <div style={ui.cardHeader}>
            <h2 style={ui.h2}>Resumo (Gemini)</h2>
            <span style={ui.badgeSoft}>AUTO</span>
          </div>

          <div style={ui.summaryBox}>
            {summary ? (
              <>
                <div style={ui.summaryTitle}>{summary.title}</div>
                <div style={ui.oneLiner}>{summary.one_liner}</div>

                <div style={ui.section}>
                  <div style={ui.sectionTitle}>Action items</div>
                  {summary.action_items?.length ? (
                    <ul style={ui.ul}>
                      {summary.action_items.slice(0, 6).map((a, i) => (
                        <li key={i} style={ui.li}>
                          <b>{a.task}</b>
                          {a.owner ? <span style={ui.dim}> — {a.owner}</span> : null}
                          {a.due_date ? <span style={ui.dim}> — {a.due_date}</span> : null}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <div style={ui.dim}>Sem action items ainda.</div>
                  )}
                </div>

                <div style={ui.section}>
                  <div style={ui.sectionTitle}>Key points</div>
                  <ul style={ui.ul}>
                    {(summary.key_points ?? []).slice(0, 6).map((k, i) => (
                      <li key={i} style={ui.li}>{k}</li>
                    ))}
                  </ul>
                </div>
              </>
            ) : (
              <div style={ui.placeholder}>O resumo vai aparecendo aqui enquanto falas…</div>
            )}
          </div>

          <div style={ui.cardFooter}>
            <span style={ui.meta}>Lang: {lang.startsWith("pt") ? "PT" : "EN"}</span>
            <button
              style={ui.copyBtn}
              onClick={async () => {
                await navigator.clipboard.writeText(JSON.stringify(summary, null, 2));
              }}
              disabled={!summary}
              title="Copia JSON do resumo"
            >
              Copy JSON
            </button>
          </div>
        </div>
      </section>

      <footer style={ui.footer}>
        Dica: para melhor “live”, usa Chrome/Edge. O “Stop” força um resumo final.
      </footer>
    </main>
  );
}

const ui: Record<string, any> = {
  page: {
    minHeight: "100vh",
    padding: 24,
    color: "#EAF2FF",
    background: "radial-gradient(1200px 700px at 15% 10%, #1b2b72 0%, rgba(14, 18, 34, 0) 60%), radial-gradient(900px 600px at 85% 20%, #6b1ed6 0%, rgba(14, 18, 34, 0) 55%), linear-gradient(180deg, #070A12, #050713)",
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
  header: { display: "flex", justifyContent: "space-between", gap: 16, alignItems: "flex-start", maxWidth: 1200, margin: "0 auto 18px" },
  h1: { margin: 0, fontSize: 28, letterSpacing: 0.2 },
  sub: { margin: "6px 0 0", opacity: 0.8 },
  pills: { display: "flex", gap: 10, flexWrap: "wrap" },
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
  statusDot: (s: string) => ({
    width: 8,
    height: 8,
    borderRadius: 99,
    background:
      s === "ok" ? "rgba(0,255,180,0.9)" :
      s === "updating" ? "rgba(0,200,255,0.95)" :
      s === "error" ? "rgba(255,80,120,0.95)" :
      "rgba(255,255,255,0.35)",
    boxShadow: s === "ok" ? "0 0 18px rgba(0,255,180,0.35)" : s === "updating" ? "0 0 18px rgba(0,200,255,0.35)" : "none",
  }),
  controls: { maxWidth: 1200, margin: "0 auto 18px", display: "flex", gap: 10, flexWrap: "wrap" },
  btnPrimary: {
    padding: "10px 14px",
    borderRadius: 14,
    border: "1px solid rgba(0,255,255,0.35)",
    background: "linear-gradient(135deg, rgba(0,255,255,0.18), rgba(107,30,214,0.12))",
    color: "#EAF2FF",
    cursor: "pointer",
    boxShadow: "0 0 24px rgba(0,255,255,0.10)",
  },
  btnDanger: {
    padding: "10px 14px",
    borderRadius: 14,
    border: "1px solid rgba(255,80,120,0.45)",
    background: "linear-gradient(135deg, rgba(255,80,120,0.22), rgba(107,30,214,0.10))",
    color: "#EAF2FF",
    cursor: "pointer",
    boxShadow: "0 0 24px rgba(255,80,120,0.10)",
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
    maxWidth: 1200,
    margin: "0 auto 16px",
    padding: "10px 12px",
    borderRadius: 14,
    border: "1px solid rgba(255,120,120,0.35)",
    background: "rgba(255,80,120,0.10)",
    display: "flex",
    gap: 10,
    alignItems: "center",
  },
  grid: { maxWidth: 1200, margin: "0 auto", display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 },
  card: {
    borderRadius: 18,
    border: "1px solid rgba(255,255,255,0.12)",
    background: "rgba(255,255,255,0.06)",
    backdropFilter: "blur(12px)",
    boxShadow: "0 20px 60px rgba(0,0,0,0.45)",
    overflow: "hidden",
    display: "flex",
    flexDirection: "column",
    minHeight: 420,
  },
  cardHeader: { padding: "14px 16px", display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: "1px solid rgba(255,255,255,0.10)" },
  h2: { margin: 0, fontSize: 14, letterSpacing: 0.6, textTransform: "uppercase", opacity: 0.9 },
  badge: {
    fontSize: 11,
    padding: "4px 10px",
    borderRadius: 99,
    border: "1px solid rgba(0,255,255,0.30)",
    background: "rgba(0,255,255,0.10)",
  },
  badgeSoft: {
    fontSize: 11,
    padding: "4px 10px",
    borderRadius: 99,
    border: "1px solid rgba(255,255,255,0.16)",
    background: "rgba(255,255,255,0.06)",
  },
  editor: { padding: 16, flex: 1, overflow: "auto" },
  text: { margin: 0, whiteSpace: "pre-wrap", lineHeight: 1.5 },
  interim: { margin: "10px 0 0", whiteSpace: "pre-wrap", opacity: 0.85, lineHeight: 1.5 },
  cursor: { display: "inline-block", width: 8, height: 16, marginLeft: 6, background: "rgba(0,255,255,0.75)", boxShadow: "0 0 18px rgba(0,255,255,0.35)", verticalAlign: "text-bottom", animation: "blink 1s steps(2, start) infinite" },
  placeholder: { opacity: 0.6, margin: 0 },
  summaryBox: { padding: 16, flex: 1, overflow: "auto" },
  summaryTitle: { fontWeight: 800, fontSize: 16, marginBottom: 6 },
  oneLiner: { opacity: 0.9, marginBottom: 14 },
  section: { marginTop: 14 },
  sectionTitle: { fontSize: 12, letterSpacing: 0.5, textTransform: "uppercase", opacity: 0.8, marginBottom: 8 },
  ul: { margin: 0, paddingLeft: 18 },
  li: { marginBottom: 8 },
  dim: { opacity: 0.75 },
  cardFooter: {
    padding: "12px 16px",
    borderTop: "1px solid rgba(255,255,255,0.10)",
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
  },
  meta: { fontSize: 12, opacity: 0.75 },
  copyBtn: {
    padding: "8px 12px",
    borderRadius: 12,
    border: "1px solid rgba(255,255,255,0.14)",
    background: "rgba(255,255,255,0.06)",
    color: "#EAF2FF",
    cursor: "pointer",
  },
  footer: { maxWidth: 1200, margin: "14px auto 0", opacity: 0.7, fontSize: 12 },
};
