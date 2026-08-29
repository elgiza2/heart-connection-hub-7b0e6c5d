import { memo, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import MegsyStar from "@/components/branding/MegsyStar";
import { BrandLogo } from "@/components/brand/BrandLogo";
import { t as uiT, useUserLang } from "@/lib/authI18n";

export interface ThinkingTraceProps {
  /** Rotating / live status line shown while the model is still working. */
  status?: string;
  /** Ordered narration steps (deep research, tools, slides, media…). */
  steps?: string[];
  /** Raw reasoning tokens from the model. */
  text?: string;
  /** True while the turn is still running. */
  active?: boolean;
  /** Start expanded (rarely needed — collapsed is the default look). */
  defaultOpen?: boolean;
  className?: string;
}

const RTL_LANGS = new Set(["ar", "ar-eg", "fa", "he"]);

// Fallback phases so the badge is never frozen on a single word while we wait
// for the backend. They advance with elapsed time, so the badge always moves.
const PHASES: Array<{ after: number; en: string; ar: string }> = [
  { after: 0, en: "Reading your request…", ar: "بقرأ طلبك…" },
  { after: 3, en: "Thinking it through…", ar: "بفكر في الحل…" },
  { after: 8, en: "Gathering what's needed…", ar: "بجمع المعلومات المطلوبة…" },
  { after: 14, en: "Working on the details…", ar: "بشتغل على التفاصيل…" },
  { after: 22, en: "Checking the answer…", ar: "براجع الإجابة…" },
  { after: 32, en: "Almost there…", ar: "قربت أخلّص…" },
];

/**
 * The single "AI thinking" surface used across chat, deep research, slides,
 * media and tool turns. Borderless, quiet grey, collapsible — the Megsy star
 * stays as the marker of the row. The headline follows real live activity
 * (status events, tool calls, reasoning) and falls back to elapsed-time
 * phases so it never looks stuck.
 */
const ThinkingTrace = ({
  status,
  steps,
  text,
  active,
  defaultOpen,
  className = "",
}: ThinkingTraceProps) => {
  const lang = useUserLang();
  const [open, setOpen] = useState(!!defaultOpen);
  const rtl = RTL_LANGS.has(lang);
  const isAr = lang.startsWith("ar");

  // Keep every distinct line we ever saw this turn, so expanding the badge
  // always shows the real trace instead of an empty panel.
  const historyRef = useRef<string[]>([]);
  const [, forceRender] = useState(0);
  useEffect(() => {
    const incoming: string[] = [];
    for (const s of steps || []) {
      const v = String(s || "").trim();
      if (v) incoming.push(v);
    }
    const st = String(status || "").trim();
    if (st) incoming.push(st);
    let changed = false;
    for (const line of incoming) {
      const h = historyRef.current;
      if (h[h.length - 1] !== line && !h.includes(line)) {
        h.push(line);
        changed = true;
      }
    }
    if (historyRef.current.length > 60) {
      historyRef.current = historyRef.current.slice(-60);
      changed = true;
    }
    if (changed) forceRender((n) => n + 1);
  }, [steps, status]);

  // Elapsed seconds while active — drives the fallback phase rotation.
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!active) return;
    setElapsed(0);
    const started = Date.now();
    const id = setInterval(() => setElapsed(Math.round((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(id);
  }, [active]);

  const reasoningLines = useMemo(() => {
    if (!text?.trim()) return [] as string[];
    const out: string[] = [];
    for (const p of text.trim().split(/\n{2,}|\n/)) {
      const v = p.trim();
      if (v && out[out.length - 1] !== v) out.push(v);
    }
    return out;
  }, [text]);

  const lines = useMemo(
    () => [...historyRef.current, ...reasoningLines],
    // historyRef mutations are surfaced through forceRender
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [reasoningLines, historyRef.current.length],
  );

  const hasBody = lines.length > 0;
  const label = active ? uiT("thinking", lang) : uiT("thoughts", lang);

  // Live headline: newest real signal wins; otherwise an elapsed-time phase.
  const headline = useMemo(() => {
    if (!active) return label;
    const live =
      String(status || "").trim() ||
      historyRef.current[historyRef.current.length - 1] ||
      reasoningLines[reasoningLines.length - 1] ||
      "";
    if (live) return live.length > 90 ? `${live.slice(0, 90)}…` : live;
    let phase = PHASES[0];
    for (const p of PHASES) if (elapsed >= p.after) phase = p;
    return isAr ? phase.ar : phase.en;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, status, elapsed, label, isAr, reasoningLines, historyRef.current.length]);

  // Nothing to show at all.
  if (!hasBody && !active) return null;

  return (
    <div className={`mb-3 ${className}`} dir={rtl ? "rtl" : undefined}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 py-0.5 text-start"
      >
        {active ? (
          <MegsyStar className="h-3.5 w-3.5 shrink-0 text-[var(--megsy-blue)] motion-safe:animate-pulse" />
        ) : (
          <BrandLogo className="h-3.5 w-3.5 shrink-0" />
        )}
        <span
          key={headline}
          className={`truncate text-[13px] ${
            active
              ? "ai-shimmer font-medium motion-reduce:animate-none animate-in fade-in-0 duration-300"
              : "text-muted-foreground"
          }`}
          aria-live="polite"
        >
          {headline}
        </span>
        {active && elapsed > 2 && (
          <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground/70">
            {elapsed}s
          </span>
        )}
        <span className="ms-auto grid h-6 w-6 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground">
          <ChevronDown
            className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-180" : ""}`}
          />
        </span>
      </button>

      {open && (
        <div className="mt-1.5 max-h-80 overflow-y-auto">
          <div className="border-s border-border/40 ps-3 flex flex-col gap-2">
            {hasBody ? (
              lines.map((line, i) => (
                <div
                  key={`${i}-${line.slice(0, 24)}`}
                  className="text-[12.5px] leading-relaxed text-muted-foreground whitespace-pre-wrap"
                >
                  {line}
                </div>
              ))
            ) : (
              <div className="text-[12.5px] text-muted-foreground">
                {isAr ? "لا توجد تفاصيل بعد…" : "No details yet…"}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default memo(ThinkingTrace);
