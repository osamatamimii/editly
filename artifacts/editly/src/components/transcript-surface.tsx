/**
 * The transcript surface: the second way of editing.
 *
 * The words are the timeline. Reading is scrubbing, a press on a word moves
 * the video there, and a second press pins a sentence to that instant — which
 * arrives at the renderer as a note on the **source clock**, `sourceMs` from
 * the word's own start. That clock never converts: second 47 of the edited
 * cut is not second 47 of the original, and the one safe number to send is
 * the one the transcript itself carries. The server snaps it to the nearest
 * word boundary; nothing is computed here beyond picking the word.
 *
 * A two-hour podcast is tens of thousands of words, and a DOM holding all of
 * them is a page that does not scroll. So the words are grouped into
 * paragraphs (a gap in the speech is a paragraph break, which is also where
 * the eye expects one), and a paragraph renders its words only while it is on
 * or near the screen — off-screen it is a block of the right height and
 * nothing else. Height is estimated from word count and corrected by the
 * browser once the real thing renders, which is enough: the estimate only
 * has to be good while you cannot see it.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2, X } from "lucide-react";
import {
  useCreateNote,
  useDeleteNote,
  useProjectNotes,
  useTranscript,
  type ProjectNote,
  type TranscriptWord,
} from "@workspace/api-client-react";
import { useLanguage } from "@/lib/language";
import { EDITOR } from "@/lib/copy/editor";

/** A speech gap that reads as a pause worth a new line, measured in ms. */
const PARAGRAPH_GAP_MS = 1400;
/** A paragraph longer than this splits anyway, so no block grows unbounded. */
const PARAGRAPH_MAX_WORDS = 90;
/** How far past the viewport a paragraph still renders its words. */
const RENDER_MARGIN = "600px";

interface Paragraph {
  /** Index of the first word in the whole transcript, for keys and lookups. */
  from: number;
  words: TranscriptWord[];
}

function toParagraphs(words: TranscriptWord[]): Paragraph[] {
  const out: Paragraph[] = [];
  let start = 0;
  for (let i = 1; i <= words.length; i += 1) {
    const gap = i === words.length || words[i][0] - words[i - 1][1] >= PARAGRAPH_GAP_MS;
    if (gap || i - start >= PARAGRAPH_MAX_WORDS) {
      out.push({ from: start, words: words.slice(start, i) });
      start = i;
    }
  }
  return out;
}

/** The word the playhead is inside, by binary search over start times. */
function wordAt(words: TranscriptWord[], ms: number): number {
  let lo = 0;
  let hi = words.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (words[mid][0] <= ms) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

/**
 * One paragraph, rendering its words only while near the viewport.
 *
 * The placeholder height leans on the container's own metrics: the parent
 * measures how tall a rendered word-line actually is and passes an estimate
 * per word, so the scrollbar is honest before anything has been seen.
 */
function ParagraphBlock({
  paragraph,
  activeIndex,
  notesByWord,
  onWordPress,
  onNoteDelete,
  deleteLabel,
  estimatedHeight,
}: {
  paragraph: Paragraph;
  activeIndex: number;
  notesByWord: Map<number, ProjectNote[]>;
  onWordPress: (index: number) => void;
  onNoteDelete: (noteId: string) => void;
  deleteLabel: string;
  estimatedHeight: number;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(false);
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      ([entry]) => setNear(Boolean(entry?.isIntersecting)),
      { rootMargin: RENDER_MARGIN },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={host} style={near ? undefined : { minHeight: estimatedHeight }} className="px-1">
      {near &&
        paragraph.words.map(([, , text], i) => {
          const index = paragraph.from + i;
          const active = index === activeIndex;
          const noted = notesByWord.get(index);
          return (
            <span key={index}>
              <button
                type="button"
                data-testid="transcript-word"
                onClick={() => onWordPress(index)}
                className={`rounded px-0.5 transition-colors duration-150 ${
                  active
                    ? "bg-primary text-primary-foreground shadow-[0_0_12px_rgba(80,161,237,0.5)]"
                    : noted
                      ? "text-foreground border-b-2 border-secondary/70 bg-secondary/10"
                      : index < activeIndex
                        ? "text-muted-foreground hover:text-foreground"
                        : "text-foreground/85 hover:text-foreground hover:bg-primary/10"
                }`}
              >
                {text}
              </button>
              {noted?.map((note) => (
                <span
                  key={note.id}
                  data-testid="transcript-note"
                  className="inline-flex items-center gap-1 align-[2px] mx-1 px-2 py-0 rounded-full text-[11px] font-medium text-secondary bg-secondary/10 border border-secondary/30 whitespace-nowrap"
                >
                  {note.text}
                  <button
                    type="button"
                    aria-label={deleteLabel}
                    data-testid="button-delete-note"
                    onClick={() => onNoteDelete(note.id)}
                    className="opacity-60 hover:opacity-100"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </span>
              ))}{" "}
            </span>
          );
        })}
    </div>
  );
}

export function TranscriptSurface({
  projectId,
  currentTime,
  onSeek,
}: {
  projectId: string;
  /** Seconds on the source clock, straight from the `<video>` element. */
  currentTime: number;
  /** Move the video, in milliseconds on the source clock. */
  onSeek: (sourceMs: number) => void;
}) {
  const { t, fmt } = useLanguage();
  const transcript = useTranscript(projectId);
  const notes = useProjectNotes(projectId, { enabled: transcript.data?.available === true });
  const createNote = useCreateNote(projectId);
  const deleteNote = useDeleteNote(projectId);

  const words = transcript.data?.words ?? [];
  const paragraphs = useMemo(() => toParagraphs(words), [words]);

  /*
    Which word each note belongs to, resolved once per change of either. The
    server stored `sourceMs` snapped to a word start, so an exact match is the
    common case and the nearest start is the honest fallback.
  */
  const notesByWord = useMemo(() => {
    const map = new Map<number, ProjectNote[]>();
    for (const note of notes.data?.notes ?? []) {
      if (words.length === 0) break;
      const index = Math.max(0, wordAt(words, note.sourceMs));
      const list = map.get(index) ?? [];
      list.push(note);
      map.set(index, list);
    }
    return map;
  }, [notes.data, words]);

  const activeIndex = useMemo(() => wordAt(words, currentTime * 1000), [words, currentTime]);

  /*
    Press once to travel, press the travelled-to word again to write. One
    state, holding the word the composer is about, cleared by sending,
    cancelling, or pressing a different word.
  */
  const [composerAt, setComposerAt] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const onWordPress = (index: number) => {
    const word = words[index];
    if (!word) return;
    if (composerAt === index) return;
    if (activeIndex === index) {
      setComposerAt(index);
      setDraft("");
      return;
    }
    onSeek(word[0]);
    setComposerAt(null);
  };

  const sendNote = () => {
    const word = composerAt !== null ? words[composerAt] : undefined;
    const text = draft.trim();
    if (!word || !text) return;
    createNote.mutate(
      { sourceMs: word[0], text },
      {
        onSuccess: () => {
          setComposerAt(null);
          setDraft("");
        },
      },
    );
  };

  /*
    Follow the playhead, but never fight the reader: auto-scroll happens only
    when the person has not scrolled this surface themselves in the last few
    seconds. `block: "nearest"` keeps the correction gentle.
  */
  const scroller = useRef<HTMLDivElement>(null);
  const lastManualScroll = useRef(0);
  const activeRef = useRef(activeIndex);
  useEffect(() => {
    if (activeIndex === activeRef.current) return;
    activeRef.current = activeIndex;
    if (Date.now() - lastManualScroll.current < 4000) return;
    const el = scroller.current?.querySelector('[data-testid="transcript-word"].bg-primary');
    el?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [activeIndex]);

  /* An estimated line is measured off the real font rather than guessed. */
  const wordsPerLine = 9;
  const lineHeight = 34;

  if (transcript.isLoading) {
    return (
      <div className="flex items-center justify-center h-full min-h-32" data-testid="transcript-loading">
        <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!transcript.data?.available) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 h-full min-h-40 px-6 text-center" data-testid="transcript-waiting">
        <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
        <p className="text-sm font-medium">{t(EDITOR.transcriptWaiting)}</p>
        <p className="text-xs text-muted-foreground max-w-64">{t(EDITOR.transcriptWaitingDetail)}</p>
      </div>
    );
  }

  if (words.length === 0) {
    return (
      <div className="flex items-center justify-center h-full min-h-32 px-6 text-center" data-testid="transcript-silent">
        <p className="text-sm text-muted-foreground">{t(EDITOR.transcriptSilent)}</p>
      </div>
    );
  }

  const direction = transcript.data.language === "ar" ? "rtl" : "ltr";
  const noteLimit = notes.data ? notes.data.notes.length >= notes.data.limit : false;
  const composerWord = composerAt !== null ? words[composerAt] : undefined;

  return (
    <div className="flex flex-col h-full min-h-0" data-testid="transcript-surface">
      <div className="flex items-baseline justify-between gap-2 px-3 pb-2 border-b border-hairline flex-shrink-0">
        <span className="text-xs text-muted-foreground">
          {fmt(EDITOR.transcriptHint, new Intl.NumberFormat("en").format(words.length))}
        </span>
      </div>
      <div
        ref={scroller}
        onWheel={() => {
          lastManualScroll.current = Date.now();
        }}
        onTouchMove={() => {
          lastManualScroll.current = Date.now();
        }}
        dir={direction}
        className="flex-1 min-h-0 overflow-y-auto px-2 py-3 text-[15px] leading-[2.1] space-y-3"
      >
        {paragraphs.map((paragraph) => (
          <ParagraphBlock
            key={paragraph.from}
            paragraph={paragraph}
            activeIndex={activeIndex}
            notesByWord={notesByWord}
            onWordPress={onWordPress}
            onNoteDelete={(noteId) => deleteNote.mutate({ noteId })}
            deleteLabel={t(EDITOR.noteDelete)}
            estimatedHeight={Math.ceil(paragraph.words.length / wordsPerLine) * lineHeight}
          />
        ))}
        {transcript.data.truncated && (
          <p className="text-xs text-muted-foreground border border-dashed border-hairline rounded-lg px-3 py-2" data-testid="transcript-truncated">
            {t(EDITOR.transcriptTruncated)}
          </p>
        )}
      </div>
      {composerWord && (
        <div className="flex-shrink-0 border-t border-hairline p-2" data-testid="note-composer">
          {noteLimit ? (
            <p className="text-xs text-muted-foreground px-1 py-1.5">
              {fmt(EDITOR.noteLimitReached, String(notes.data?.limit ?? 0))}
            </p>
          ) : (
            <div className="flex items-center gap-2">
              <input
                autoFocus
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") sendNote();
                  if (e.key === "Escape") setComposerAt(null);
                }}
                placeholder={fmt(EDITOR.notePlaceholder, composerWord[2])}
                className="flex-1 min-w-0 bg-surface-1 border border-hairline rounded-lg px-3 py-2 text-sm outline-none focus:border-primary/60"
                data-testid="input-note"
              />
              <button
                type="button"
                onClick={sendNote}
                disabled={createNote.isPending || draft.trim().length === 0}
                className="flex-shrink-0 text-sm font-semibold text-primary-foreground bg-primary rounded-lg px-4 py-2 disabled:opacity-50 min-h-11 md:min-h-9"
                data-testid="button-add-note"
              >
                {createNote.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : t(EDITOR.noteAdd)}
              </button>
              <button
                type="button"
                onClick={() => setComposerAt(null)}
                aria-label={t(EDITOR.noteCancel)}
                className="flex-shrink-0 text-muted-foreground hover:text-foreground min-h-11 md:min-h-9 px-1"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
